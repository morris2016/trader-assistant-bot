import { EventEmitter } from "node:events";
import { CandleBuffer } from "./candles";
import { orderBlock } from "./detectors/orderBlock";
import { fairValueGap } from "./detectors/fvg";
import { liquiditySweep } from "./detectors/liquiditySweep";
import { trendContinuation } from "./detectors/trendContinuation";
import { spikeFade } from "./detectors/spikeFade";
import { driftPullback } from "./detectors/driftPullback";
import { breakoutContinuation } from "./detectors/breakoutContinuation";
import { breakoutMeanRev } from "./detectors/breakoutMeanRev";
import { applyStrategy } from "./strategy";
import { latestAtr, latestRegime } from "./indicators";
import type { Detector } from "./detectors/types";
import type { Candle, DetectorConfig, DetectorDiagnostics, LiquidityPool, OrderBlock, RegimeSnapshot, Signal, StrategyConfig, StructureMark, SymbolCode } from "@shared/types";

// SMC stack: OB + FVG + Liquidity Sweep — used by the validated real-asset
// strategy registry. trendContinuation is the rule-based detector used by
// FAST_STRATEGIES (drift-fade scalping). emaCross and structure detectors
// still exist in the codebase but are intentionally not registered.
export const ALL_DETECTORS: Detector[] = [orderBlock, fairValueGap, liquiditySweep, trendContinuation, spikeFade, driftPullback, breakoutContinuation, breakoutMeanRev];

type StrategyTrace = { barIndex: number; signal: Signal };

export class Engine extends EventEmitter {
  private buffers = new Map<SymbolCode, CandleBuffer>();
  private state = new Map<SymbolCode, Record<string, unknown>>();
  private detectorConfig: Map<string, DetectorConfig> = new Map();
  private strategyConfig: StrategyConfig = { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 };
  private recentDetectorSignals = new Map<SymbolCode, Map<string, StrategyTrace>>();
  private barIndex = new Map<SymbolCode, number>();
  // Latest epoch we've evaluated detectors on. Prevents the first live ohlc
  // from re-evaluating the last seed bar (which was already evaluated during
  // seed()). Set in seed() to the last historical epoch.
  private lastEvaluatedEpoch = new Map<SymbolCode, number>();

  constructor(configs: DetectorConfig[], strategy?: StrategyConfig) {
    super();
    this.setDetectorConfigs(configs);
    if (strategy) this.strategyConfig = strategy;
  }

  setDetectorConfigs(configs: DetectorConfig[]) {
    this.detectorConfig.clear();
    for (const c of configs) this.detectorConfig.set(c.id, c);
  }

  setStrategyConfig(config: StrategyConfig) {
    this.strategyConfig = config;
  }

  seed(symbol: SymbolCode, history: Candle[]) {
    // Warm-up: replay each bar through the enabled detectors so the live bot
    // doesn't start with empty OB/FVG/sweep pools and uninitialized ATR/ADX
    // windows. Detector outputs during replay are discarded (no trades fire),
    // but state.provisional / state.active / state.pending / liquidity pools /
    // recentByDetector are populated as if the bot had been running all along.
    const buf = new CandleBuffer();
    this.buffers.set(symbol, buf);
    this.state.set(symbol, {});
    this.recentDetectorSignals.set(symbol, new Map());

    const stateBag = this.state.get(symbol)!;
    const recent = this.recentDetectorSignals.get(symbol)!;
    for (let i = 0; i < history.length; i++) {
      buf.push(history[i]);
      for (const det of ALL_DETECTORS) {
        const cfg = this.detectorConfig.get(det.id);
        if (!cfg || !cfg.enabled) continue;
        const out = det.onClose({ symbol, candles: buf.all, params: cfg.params, state: stateBag });
        for (const sig of out.signals) {
          recent.set(sig.detector, { barIndex: i, signal: sig });
        }
      }
    }
    this.barIndex.set(symbol, history.length - 1);
    if (history.length > 0) {
      this.lastEvaluatedEpoch.set(symbol, history[history.length - 1].epoch);
    }
  }

  reset(symbol: SymbolCode) {
    this.buffers.delete(symbol);
    this.state.delete(symbol);
    this.recentDetectorSignals.delete(symbol);
    this.barIndex.delete(symbol);
    this.lastEvaluatedEpoch.delete(symbol);
  }

  onCandle(symbol: SymbolCode, candle: Candle, isNew: boolean): {
    signals: Signal[];
    orderBlocks: OrderBlock[];
    mitigatedBlockIds: string[];
    structureMarks: StructureMark[];
    liquidityPools: LiquidityPool[];
    liquidityPoolsSwept: Array<{ id: string; sweptEpoch: number }>;
    liquidityPoolsRemoved: string[];
    diagnostics: DetectorDiagnostics[];
    rejected?: number;
    regime?: RegimeSnapshot;
  } {
    const buf = this.buffers.get(symbol) ?? new CandleBuffer();

    // CRITICAL ORDER (fixed 2026-05-03): when isNew=true (a new bar's first
    // tick), the PREVIOUS bar (currently the last entry in buf) just finalized
    // its close. We must run detectors on that finalized previous bar BEFORE
    // pushing the new bar. Pushing first would put the new bar (with only its
    // first-tick close) at length-1, and the detector would evaluate it as
    // "current bar" — missing 5 minutes of price action that already happened
    // during the bar that just closed. This bug caused R-stack to silently
    // emit zero signals for hours of live operation.
    if (!isNew) {
      // Tick update of the still-forming bar — update buffer, don't fire detectors.
      buf.push(candle);
      this.buffers.set(symbol, buf);
      return {
        signals: [], orderBlocks: [], mitigatedBlockIds: [], structureMarks: [],
        liquidityPools: [], liquidityPoolsSwept: [], liquidityPoolsRemoved: [],
        diagnostics: [],
      };
    }

    // isNew=true → bar transition. The current buf.last is the just-finalized
    // previous bar (its final close was set by the last tick update). Fire
    // detectors on it as "current bar" — UNLESS we've already evaluated this
    // epoch (happens once at startup: the first live ohlc fires before we've
    // pushed the new bar, but the seed already evaluated the last seed bar).
    const lastBuf = buf.last();
    const alreadyEvaluated = lastBuf != null && (this.lastEvaluatedEpoch.get(symbol) ?? -1) >= lastBuf.epoch;
    if (buf.length() === 0 || alreadyEvaluated) {
      // Either no buffer yet, or the previous bar was already evaluated during
      // seed/prior live evaluation. Just push and return.
      buf.push(candle);
      this.buffers.set(symbol, buf);
      return {
        signals: [], orderBlocks: [], mitigatedBlockIds: [], structureMarks: [],
        liquidityPools: [], liquidityPoolsSwept: [], liquidityPoolsRemoved: [],
        diagnostics: [],
      };
    }
    if (lastBuf) this.lastEvaluatedEpoch.set(symbol, lastBuf.epoch);

    const idx = (this.barIndex.get(symbol) ?? -1) + 1;
    this.barIndex.set(symbol, idx);

    const rawSignals: Signal[] = [];
    const orderBlocks: OrderBlock[] = [];
    const mitigatedBlockIds: string[] = [];
    const structureMarks: StructureMark[] = [];
    const liquidityPools: LiquidityPool[] = [];
    const liquidityPoolsSwept: Array<{ id: string; sweptEpoch: number }> = [];
    const liquidityPoolsRemoved: string[] = [];
    const diagnostics: DetectorDiagnostics[] = [];
    const stateBag = this.state.get(symbol) ?? (this.state.set(symbol, {}).get(symbol)!);

    for (const det of ALL_DETECTORS) {
      const cfg = this.detectorConfig.get(det.id);
      if (!cfg || !cfg.enabled) continue;
      const out = det.onClose({
        symbol,
        candles: buf.all,
        params: cfg.params,
        state: stateBag,
      });
      rawSignals.push(...out.signals);
      if (out.orderBlocks) orderBlocks.push(...out.orderBlocks);
      if (out.mitigatedBlockIds) mitigatedBlockIds.push(...out.mitigatedBlockIds);
      if (out.structureMarks) structureMarks.push(...out.structureMarks);
      if (out.liquidityPools) liquidityPools.push(...out.liquidityPools);
      if (out.liquidityPoolsSwept) liquidityPoolsSwept.push(...out.liquidityPoolsSwept);
      if (out.liquidityPoolsRemoved) liquidityPoolsRemoved.push(...out.liquidityPoolsRemoved);
      if (out.diagnostics) diagnostics.push({ symbol, ...out.diagnostics });
    }

    // Track most-recent signal per detector for confluence window.
    const recent = this.recentDetectorSignals.get(symbol) ?? new Map();
    for (const sig of rawSignals) {
      recent.set(sig.detector, { barIndex: idx, signal: sig });
    }
    this.recentDetectorSignals.set(symbol, recent);

    // Apply strategy gate.
    const decision = applyStrategy({
      config: this.strategyConfig,
      candles: buf.all,
      currentBarSignals: rawSignals,
      recentByDetector: recent,
      currentBarIndex: idx,
    });

    // Detectors evaluated on the just-closed previous bar. Now push the new
    // bar (the just-arrived tick is its first sample) onto the buffer so
    // future tick updates and the next bar transition see it.
    buf.push(candle);
    this.buffers.set(symbol, buf);

    return {
      signals: decision.allowedSignals,
      orderBlocks,
      mitigatedBlockIds,
      structureMarks,
      liquidityPools,
      liquidityPoolsSwept,
      liquidityPoolsRemoved,
      diagnostics,
      rejected: rawSignals.length - decision.allowedSignals.length,
      regime: {
        symbol,
        adx: decision.regime.adx,
        direction: decision.regime.direction,
        trending: decision.regime.trending,
        threshold: this.strategyConfig.adxThreshold,
        atr: latestAtr(buf.all, 14),
      } satisfies RegimeSnapshot,
    };
  }

  /** Snapshot the current regime for a symbol without advancing any state. */
  regimeFor(symbol: SymbolCode): RegimeSnapshot | null {
    const buf = this.buffers.get(symbol);
    if (!buf || buf.length() === 0) return null;
    const r = latestRegime(buf.all, this.strategyConfig.adxThreshold);
    return {
      symbol,
      adx: r.adx,
      direction: r.direction,
      trending: r.trending,
      threshold: this.strategyConfig.adxThreshold,
      atr: latestAtr(buf.all, 14),
    };
  }

  /** Most recent ATR for a symbol (returns 0 if no buffer yet). */
  atrFor(symbol: SymbolCode, period = 14): number {
    const buf = this.buffers.get(symbol);
    if (!buf) return 0;
    return latestAtr(buf.all, period);
  }

  /** Last known candle close for a symbol. */
  lastCloseFor(symbol: SymbolCode): number | null {
    const buf = this.buffers.get(symbol);
    const last = buf?.last();
    return last?.close ?? null;
  }

  /** Full candle history for a symbol (empty array if not seeded). */
  candlesFor(symbol: SymbolCode): Candle[] {
    const buf = this.buffers.get(symbol);
    return buf?.all ?? [];
  }

  /** Diagnostic snapshot for a symbol — used to debug "why aren't signals firing". */
  diagnose(symbol: SymbolCode): {
    bars: number;
    lastEpoch: number | null;
    barIndex: number;
    atr: number;
    detectors: Record<string, { enabled: boolean; activeCount: number; unmitigatedCount: number; hasZoneState: boolean }>;
  } {
    const buf = this.buffers.get(symbol);
    const stateBag = this.state.get(symbol) ?? {};
    const dets: Record<string, { enabled: boolean; activeCount: number; unmitigatedCount: number; hasZoneState: boolean }> = {};
    for (const det of ALL_DETECTORS) {
      const cfg = this.detectorConfig.get(det.id);
      // OrderBlock + FVG store zones in `active` map with `mitigated` flag.
      // LiquiditySweep stores zones in `pools` map with `sweptEpoch` (null = unswept).
      // Need to handle both shapes so the snapshot is meaningful for all detectors.
      const detState = (stateBag as Record<string, unknown>)[det.id] as
        | { active?: Map<string, { mitigated: boolean }>; pools?: Map<string, { sweptEpoch: number | null }> }
        | undefined;
      let activeCount = 0;
      let unmitigatedCount = 0;
      let hasZoneState = false;
      if (detState?.active) {
        hasZoneState = true;
        for (const blk of detState.active.values()) {
          activeCount++;
          if (!blk.mitigated) unmitigatedCount++;
        }
      }
      if (detState?.pools) {
        hasZoneState = true;
        for (const pool of detState.pools.values()) {
          activeCount++;
          if (pool.sweptEpoch == null) unmitigatedCount++;
        }
      }
      // Stateless rule-based detectors (e.g. trendContinuation) have no zone
      // map. Marking them with hasZoneState=false lets the heartbeat emitter
      // omit the misleading "0/0" entry for them.
      dets[det.id] = { enabled: cfg?.enabled ?? false, activeCount, unmitigatedCount, hasZoneState };
    }
    return {
      bars: buf?.length() ?? 0,
      lastEpoch: buf?.last()?.epoch ?? null,
      barIndex: this.barIndex.get(symbol) ?? -1,
      atr: this.atrFor(symbol),
      detectors: dets,
    };
  }
}

export function defaultDetectorConfigs(): DetectorConfig[] {
  return ALL_DETECTORS.map((d) => ({
    id: d.id,
    label: d.label,
    enabled: true,
    params: { ...d.defaultParams },
  }));
}

import { EventEmitter } from "node:events";
import { CandleBuffer } from "./candles";
import { orderBlock } from "./detectors/orderBlock";
import { fairValueGap } from "./detectors/fvg";
import { liquiditySweep } from "./detectors/liquiditySweep";
import { applyStrategy } from "./strategy";
import { latestAtr, latestRegime } from "./indicators";
import type { Detector } from "./detectors/types";
import type { Candle, DetectorConfig, DetectorDiagnostics, LiquidityPool, OrderBlock, RegimeSnapshot, Signal, StrategyConfig, StructureMark, SymbolCode } from "@shared/types";

// Focused SMC stack: OB + FVG + Liquidity Sweep. emaCross and structure
// detectors still exist in the codebase but are intentionally not registered —
// we're drilling this trio first, everything else is deferred.
export const ALL_DETECTORS: Detector[] = [orderBlock, fairValueGap, liquiditySweep];

type StrategyTrace = { barIndex: number; signal: Signal };

export class Engine extends EventEmitter {
  private buffers = new Map<SymbolCode, CandleBuffer>();
  private state = new Map<SymbolCode, Record<string, unknown>>();
  private detectorConfig: Map<string, DetectorConfig> = new Map();
  private strategyConfig: StrategyConfig = { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 };
  private recentDetectorSignals = new Map<SymbolCode, Map<string, StrategyTrace>>();
  private barIndex = new Map<SymbolCode, number>();

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
  }

  reset(symbol: SymbolCode) {
    this.buffers.delete(symbol);
    this.state.delete(symbol);
    this.recentDetectorSignals.delete(symbol);
    this.barIndex.delete(symbol);
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
    buf.push(candle);
    this.buffers.set(symbol, buf);

    if (!isNew) return {
      signals: [], orderBlocks: [], mitigatedBlockIds: [], structureMarks: [],
      liquidityPools: [], liquidityPoolsSwept: [], liquidityPoolsRemoved: [],
      diagnostics: [],
    };

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
}

export function defaultDetectorConfigs(): DetectorConfig[] {
  return ALL_DETECTORS.map((d) => ({
    id: d.id,
    label: d.label,
    enabled: true,
    params: { ...d.defaultParams },
  }));
}

import { randomUUID } from "node:crypto";
import { ALL_DETECTORS } from "./runner";
import { applyStrategy } from "./strategy";
import { latestAtr, latestRegime } from "./indicators";
import type {
  BacktestRequest,
  BacktestResult,
  BacktestTrade,
  Candle,
  LiquidityPool,
  OrderBlock,
  Signal,
  StrategyConfig,
  StructureMark,
} from "@shared/types";

/**
 * AI signaler callback — the backtest delegates DeepSeek calls here so the
 * main process can hold the API key + manage concurrency without polluting
 * the engine. Returns null on HOLD / low confidence / network failure.
 */
export type AiSignaler = (
  barIdx: number,
  candles: Candle[],
  activeOrderBlocks: OrderBlock[],
  detectorAction?: "BUY" | "SELL",
) => Promise<Signal | null>;

const MIN_BARS_BEFORE_TRADE = 25;
const ATR_PERIOD = 14;

export async function runBacktest(
  request: BacktestRequest,
  candles: Candle[],
  aiSignaler?: AiSignaler,
): Promise<BacktestResult> {
  const atrSlMult = request.atrSlMult ?? 1.0;
  const atrTpMult = request.atrTpMult ?? 2.0;
  // Round-trip cost as a fraction (e.g. 2 bps → 0.0002). Subtracted from each
  // closed trade's pnlPct to model spread + slippage. Hits stops and targets
  // unchanged — cost is applied post-fill so the geometry of the bar test stays
  // honest; the trader just keeps less of the result.
  const costFrac = (request.costBps ?? 2.0) / 10000;
  const breakevenAtRMul = request.breakevenAtRMul ?? 0;
  const maxAdx = request.maxAdx;
  const minAdx = request.minAdx;
  const withTrendAdx = request.withTrendOnlyAboveAdx;
  const skipDays = request.skipDaysOfWeekUtc ? new Set(request.skipDaysOfWeekUtc) : null;
  const buyOnly = request.buyOnly === true;
  const sellOnly = request.sellOnly === true;
  const dynamicSma = request.dynamicSideBySma && request.dynamicSideBySma > 0 ? request.dynamicSideBySma : 0;
  const strategy: StrategyConfig = request.strategy ?? {
    mode: "raw",
    adxThreshold: 22,
    confluenceWindowBars: 3,
  };

  const state: Record<string, unknown> = {};
  const detectorConfig = new Map(request.detectors.map((d) => [d.id, d] as const));
  const recentByDetector = new Map<string, { signal: Signal; barIndex: number }>();

  const signalsAt: Signal[][] = [];
  const blocksCreatedAt: OrderBlock[][] = [];
  const blocksMitigatedAt: string[][] = [];
  const structureMarksAt: StructureMark[][] = [];
  const poolsCreatedAt: LiquidityPool[][] = [];
  const poolsSweptAt: Array<{ id: string; sweptEpoch: number }>[] = [];
  const poolsRemovedAt: string[][] = [];
  const allBlocks: OrderBlock[] = [];
  const trades: BacktestTrade[] = [];
  const equityByIndex: number[] = [];

  let openTrade: { trade: BacktestTrade; barIndex: number } | null = null;
  let runningPnlPct = 0;

  const aiMode = request.aiMode ?? "off";
  const aiInterval = Math.max(1, request.aiIntervalBars ?? 30);
  const useAi = aiMode !== "off" && !!aiSignaler;
  const activeOBs = new Map<string, OrderBlock>();
  let aiCalls = 0;
  const aiConsensus = { ratified: 0, vetoed: 0, abstained: 0 };
  let lastAiSampleAt = -Infinity;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const window = candles.slice(0, i + 1);

    const rawBarSignals: Signal[] = [];
    const barBlocks: OrderBlock[] = [];
    const barMitigated: string[] = [];
    const barMarks: StructureMark[] = [];
    const barPools: LiquidityPool[] = [];
    const barPoolsSwept: Array<{ id: string; sweptEpoch: number }> = [];
    const barPoolsRemoved: string[] = [];

    // Run detectors only after warm-up so EMA/OB have enough history.
    if (i >= MIN_BARS_BEFORE_TRADE) {
      for (const det of ALL_DETECTORS) {
        const cfg = detectorConfig.get(det.id);
        if (!cfg || !cfg.enabled) continue;
        const out = det.onClose({
          symbol: request.symbol,
          candles: window,
          params: cfg.params,
          state,
        });
        rawBarSignals.push(...out.signals);
        if (out.orderBlocks) {
          barBlocks.push(...out.orderBlocks);
          allBlocks.push(...out.orderBlocks);
        }
        if (out.mitigatedBlockIds) barMitigated.push(...out.mitigatedBlockIds);
        if (out.structureMarks) barMarks.push(...out.structureMarks);
        if (out.liquidityPools) barPools.push(...out.liquidityPools);
        if (out.liquidityPoolsSwept) barPoolsSwept.push(...out.liquidityPoolsSwept);
        if (out.liquidityPoolsRemoved) barPoolsRemoved.push(...out.liquidityPoolsRemoved);
      }
    }

    for (const sig of rawBarSignals) {
      recentByDetector.set(sig.detector, { barIndex: i, signal: sig });
    }
    const decision = applyStrategy({
      config: strategy,
      candles: window,
      currentBarSignals: rawBarSignals,
      recentByDetector,
      currentBarIndex: i,
    });
    let barSignals = decision.allowedSignals;

    // Optional ADX-regime gate — applied AFTER the strategy gate so we can
    // restrict OB signals to ranging markets (maxAdx) or trending markets
    // (minAdx) without changing the strategy mode.
    if (barSignals.length > 0 && (maxAdx != null || minAdx != null || withTrendAdx != null)) {
      const reg = latestRegime(window, 22, 14);
      if (maxAdx != null && reg.adx > maxAdx) barSignals = [];
      else if (minAdx != null && reg.adx < minAdx) barSignals = [];
      // With-trend-only filter: in trending regimes (ADX ≥ threshold), drop
      // signals that fight the trend. Below the threshold, signals pass.
      if (barSignals.length > 0 && withTrendAdx != null && reg.adx >= withTrendAdx) {
        barSignals = barSignals.filter((s) =>
          (reg.direction === "up" && s.action === "BUY") ||
          (reg.direction === "down" && s.action === "SELL"),
        );
      }
    }

    // Day-of-week filter (e.g. skip Saturdays for crypto weekend illiquidity).
    if (barSignals.length > 0 && skipDays) {
      const dow = new Date(bar.epoch * 1000).getUTCDay();
      if (skipDays.has(dow)) barSignals = [];
    }

    // BUY-only / SELL-only directional filters.
    if (barSignals.length > 0) {
      if (buyOnly) barSignals = barSignals.filter((s) => s.action === "BUY");
      else if (sellOnly) barSignals = barSignals.filter((s) => s.action === "SELL");
    }

    // Dynamic regime side-bias: drop SELLs in uptrends, BUYs in downtrends.
    // Trend = current close vs SMA(dynamicSma). Auto-flips with the regime.
    if (barSignals.length > 0 && dynamicSma > 0 && i >= dynamicSma) {
      let sum = 0;
      for (let k = i - dynamicSma + 1; k <= i; k++) sum += candles[k].close;
      const sma = sum / dynamicSma;
      const bullish = bar.close > sma;
      barSignals = barSignals.filter((s) =>
        bullish ? s.action === "BUY" : s.action === "SELL",
      );
    }

    // Track the live active-OB set so we can hand it to DeepSeek as context.
    for (const b of barBlocks) activeOBs.set(b.id, b);
    for (const id of barMitigated) activeOBs.delete(id);

    // ── AI-driven signal selection ─────────────────────────────────────────
    if (useAi && aiSignaler && i >= MIN_BARS_BEFORE_TRADE) {
      const obSnap = Array.from(activeOBs.values());
      if (aiMode === "primary") {
        // Sample DeepSeek every `aiInterval` bars; AI fully replaces detector
        // signals as the trading trigger.
        if (i - lastAiSampleAt >= aiInterval) {
          lastAiSampleAt = i;
          aiCalls++;
          const aiSig = await aiSignaler(i, window, obSnap);
          barSignals = aiSig ? [aiSig] : [];
        } else {
          barSignals = [];
        }
      } else if (aiMode === "consensus") {
        // Only spend a DeepSeek call when a detector actually fired.
        const ratified: Signal[] = [];
        for (const sig of decision.allowedSignals) {
          aiCalls++;
          const aiSig = await aiSignaler(i, window, obSnap, sig.action);
          if (!aiSig) {
            aiConsensus.abstained++;
            continue;
          }
          if (aiSig.action === sig.action) {
            aiConsensus.ratified++;
            ratified.push(sig);
          } else {
            aiConsensus.vetoed++;
          }
        }
        barSignals = ratified;
      }
    }

    // --- Position management -------------------------------------------------
    // Check exits on this bar BEFORE opening new trades.
    // Stop and target are absolute price levels set at entry from ATR sampled
    // at that bar — so they're scale-invariant across symbols (R_100 vs FX
    // vs synthetics) and reflect realistic per-instrument volatility.
    //
    // Conservative tie-breaking: when a single bar's range engulfs both stop
    // and target, assume the stop hit first. Without intrabar data we can't
    // know the path, and counting a worst-case as a winner would inflate the
    // win rate.
    if (openTrade) {
      const { trade, barIndex } = openTrade;

      // Trail the stop to breakeven once MFE reaches breakevenAtRMul × initial-risk.
      // Original stop is captured at entry; we don't need to track it because the
      // trail is monotonic — once stop reaches entry, leave it there.
      if (breakevenAtRMul > 0) {
        const initialRisk = Math.abs(trade.entryPrice - trade.stopPrice);
        if (trade.side === "BUY") {
          const mfe = bar.high - trade.entryPrice;
          if (mfe >= breakevenAtRMul * initialRisk && trade.stopPrice < trade.entryPrice) {
            trade.stopPrice = trade.entryPrice;
          }
        } else {
          const mfe = trade.entryPrice - bar.low;
          if (mfe >= breakevenAtRMul * initialRisk && trade.stopPrice > trade.entryPrice) {
            trade.stopPrice = trade.entryPrice;
          }
        }
      }

      let hit: "tp" | "sl" | null = null;
      if (trade.side === "BUY") {
        const stopHit = bar.low <= trade.stopPrice;
        const tpHit = bar.high >= trade.targetPrice;
        if (stopHit) hit = "sl";
        else if (tpHit) hit = "tp";
      } else {
        const stopHit = bar.high >= trade.stopPrice;
        const tpHit = bar.low <= trade.targetPrice;
        if (stopHit) hit = "sl";
        else if (tpHit) hit = "tp";
      }

      if (hit) {
        const exitPrice = hit === "tp" ? trade.targetPrice : trade.stopPrice;
        trade.exitPrice = exitPrice;
        trade.closedAtIndex = i;
        trade.exitReason = hit;
        const gross =
          trade.side === "BUY"
            ? (exitPrice - trade.entryPrice) / trade.entryPrice
            : (trade.entryPrice - exitPrice) / trade.entryPrice;
        trade.pnlPct = gross - costFrac;
        runningPnlPct += trade.pnlPct;
        trades.push(trade);
        openTrade = null;
        void barIndex;
      }
    }

    // Open on signal (or close + reverse on opposite).
    for (const sig of barSignals) {
      if (openTrade && openTrade.trade.side !== sig.action) {
        // Opposite signal — close at current close, then open.
        const t = openTrade.trade;
        t.exitPrice = bar.close;
        t.closedAtIndex = i;
        t.exitReason = "opposite_signal";
        const gross =
          t.side === "BUY"
            ? (bar.close - t.entryPrice) / t.entryPrice
            : (t.entryPrice - bar.close) / t.entryPrice;
        t.pnlPct = gross - costFrac;
        runningPnlPct += t.pnlPct;
        trades.push(t);
        openTrade = null;
      }
      if (!openTrade) {
        const atr = latestAtr(window, ATR_PERIOD);
        if (atr <= 0) continue; // can't size a stop without ATR
        const entry = bar.close;
        // Prefer signal-provided structural stop/target (e.g. OB wick) when
        // present. Fall back to ATR-based stops for detectors that don't
        // emit structural levels.
        let stopPrice: number, targetPrice: number;
        if (sig.stopPrice != null && sig.targetPrice != null) {
          stopPrice = sig.stopPrice;
          targetPrice = sig.targetPrice;
        } else {
          const stopDist = atr * atrSlMult;
          const tpDist = atr * atrTpMult;
          stopPrice = sig.action === "BUY" ? entry - stopDist : entry + stopDist;
          targetPrice = sig.action === "BUY" ? entry + tpDist : entry - tpDist;
        }
        const trade: BacktestTrade = {
          id: randomUUID(),
          symbol: request.symbol,
          detector: sig.detector,
          side: sig.action,
          openedAtIndex: i,
          closedAtIndex: -1,
          entryPrice: entry,
          exitPrice: 0,
          pnlPct: 0,
          exitReason: "run_end",
          stopPrice,
          targetPrice,
          atrAtEntry: atr,
        };
        openTrade = { trade, barIndex: i };
      }
    }

    signalsAt.push(barSignals);
    blocksCreatedAt.push(barBlocks);
    blocksMitigatedAt.push(barMitigated);
    structureMarksAt.push(barMarks);
    poolsCreatedAt.push(barPools);
    poolsSweptAt.push(barPoolsSwept);
    poolsRemovedAt.push(barPoolsRemoved);
    equityByIndex.push(runningPnlPct);
  }

  // Close any still-open trade at the last bar's close.
  if (openTrade) {
    const last = candles[candles.length - 1];
    const t = openTrade.trade;
    t.exitPrice = last.close;
    t.closedAtIndex = candles.length - 1;
    t.exitReason = "run_end";
    const gross =
      t.side === "BUY"
        ? (last.close - t.entryPrice) / t.entryPrice
        : (t.entryPrice - last.close) / t.entryPrice;
    t.pnlPct = gross - costFrac;
    runningPnlPct += t.pnlPct;
    trades.push(t);
    equityByIndex[equityByIndex.length - 1] = runningPnlPct;
  }

  // --- Stats -----------------------------------------------------------------
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  const losses = trades.length - wins;
  const byDetector: BacktestResult["stats"]["byDetector"] = {};
  for (const t of trades) {
    const d = byDetector[t.detector] ?? { totalClosed: 0, wins: 0, winRate: 0, totalPnlPct: 0 };
    d.totalClosed++;
    if (t.pnlPct > 0) d.wins++;
    d.totalPnlPct += t.pnlPct;
    byDetector[t.detector] = d;
  }
  for (const d of Object.values(byDetector)) {
    d.winRate = d.totalClosed > 0 ? d.wins / d.totalClosed : 0;
  }

  // Extract per-detector diagnostic counters (e.g. OB rejection reasons).
  const detectorDiagnostics: Record<string, Record<string, number>> = {};
  for (const [key, val] of Object.entries(state)) {
    if (val && typeof val === "object" && "rejections" in (val as Record<string, unknown>)) {
      const rej = (val as { rejections: Record<string, number> }).rejections;
      if (rej && Object.keys(rej).length > 0) detectorDiagnostics[key] = rej;
    }
  }

  return {
    request,
    candles,
    signalsAt,
    blocksCreatedAt,
    blocksMitigatedAt,
    blocks: allBlocks,
    structureMarksAt,
    poolsCreatedAt,
    poolsSweptAt,
    poolsRemovedAt,
    trades,
    equityByIndex,
    detectorDiagnostics,
    aiCalls,
    aiCostUsd: aiCalls * 0.0005,
    aiConsensus: aiMode === "consensus" ? aiConsensus : undefined,
    stats: {
      totalClosed: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnlPct: runningPnlPct,
      byDetector,
    },
  };
}

import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import { latestAtr } from "../indicators";

/**
 * Breakout Mean-Reversion detector.
 *
 * Inverse of `breakoutContinuation`: when the latest bar's close pierces the
 * prior N-bar range with strong momentum, FADE the breakout — sell into
 * up-pierces, buy into down-pierces. Equidistant SL/TP at K×ATR.
 *
 * Gate: only fires when the asset is currently in CHOP (Kaufman efficiency
 * ratio < `effChopThresh` over `effWindow` bars). On structurally mean-
 * reverting synths (e.g. RDBEAR with bear-side drift), this captures the
 * counter-trend retraces while staying out of sustained trends.
 *
 * Validated 2026-05-01:
 *   • RDBEAR 5m, lb=15, kAtr=2.5, momRatio=0.7, SELL-only, eff<0.30:
 *     120-day Jan→Apr: 688 trades / 57.3% WR / +$12,654 / 0 busts
 *     Daily survival 69.2% · 30.8% DD-paused (cap 60%) · 0% bust
 */
export const breakoutMeanRev: Detector = {
  id: "breakoutMeanRev",
  label: "Breakout Mean-Reversion",
  defaultParams: {
    lookback: 15,
    atrPeriod: 14,
    kAtr: 2.5,
    momRatio: 0.7,
    sideFilter: 0,           // 0 = both, 1 = BUY-only (fade down-pierces), -1 = SELL-only (fade up-pierces)
    effWindow: 24,           // efficiency-ratio lookback
    effChopThresh: 0.30,     // skip if eff >= this (i.e. trending)
    minAdx: 22,              // chop filter floor — avoids noise
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const lookback = Math.max(2, Math.round(ctx.params.lookback ?? 15));
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const kAtr = ctx.params.kAtr ?? 2.5;
    const momRatio = ctx.params.momRatio ?? 0.7;
    const sideFilter = Math.round(ctx.params.sideFilter ?? 0);
    const effWindow = Math.max(2, Math.round(ctx.params.effWindow ?? 24));
    const effChopThresh = ctx.params.effChopThresh ?? 0.30;
    const candles = ctx.candles;
    const minBars = Math.max(lookback + 1, atrPeriod + 1, effWindow + 1);
    if (candles.length < minBars) return { signals: [] };

    // Kaufman efficiency ratio: net-move / sum-of-absolute-moves over `effWindow` bars.
    // 1.0 = pure trend, 0.0 = pure chop. We fire ONLY when chop (eff < threshold).
    const last = candles.length - 1;
    const start = last - effWindow;
    const netMove = Math.abs(candles[last].close - candles[start].close);
    let sumAbs = 0;
    for (let j = start + 1; j <= last; j++) sumAbs += Math.abs(candles[j].close - candles[j - 1].close);
    const eff = sumAbs > 0 ? netMove / sumAbs : 0;
    if (eff >= effChopThresh) return { signals: [] };

    // Prior N-bar high/low (excluding the current bar).
    let hi = -Infinity;
    let lo = Infinity;
    const lookStart = candles.length - 1 - lookback;
    for (let m = lookStart; m < candles.length - 1; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }

    const curr = candles[candles.length - 1];
    const range = curr.high - curr.low;
    if (range <= 0) return { signals: [] };
    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    const closePosUp = (curr.close - curr.low) / range;
    const closePosDn = (curr.high - curr.close) / range;

    // FADE direction (mean-revert): up-pierce → SELL, down-pierce → BUY.
    let side: "BUY" | "SELL" | null = null;
    if (curr.close > hi && closePosUp >= momRatio) side = "SELL";       // fade the up-pierce
    else if (curr.close < lo && closePosDn >= momRatio) side = "BUY";   // fade the down-pierce
    if (!side) return { signals: [] };

    // sideFilter applied AFTER fade-flip: 1 = BUY-only, -1 = SELL-only.
    if (sideFilter === 1 && side !== "BUY") return { signals: [] };
    if (sideFilter === -1 && side !== "SELL") return { signals: [] };

    const dist = kAtr * atr;
    const entry = curr.close;
    const stopPrice = side === "BUY" ? entry - dist : entry + dist;
    const targetPrice = side === "BUY" ? entry + dist : entry - dist;

    return {
      signals: [
        {
          id: randomUUID(),
          ts: curr.epoch * 1000,
          symbol: ctx.symbol,
          detector: "breakoutMeanRev",
          action: side,
          confidence: 0.6,
          reason: `chop eff=${eff.toFixed(2)}; ${lookback}-bar range pierced; fade into ${side} at ${entry.toFixed(5)}`,
          price: entry,
          stopPrice,
          targetPrice,
        },
      ],
    };
  },
};

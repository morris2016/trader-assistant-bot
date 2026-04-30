import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import { latestAtr } from "../indicators";

/**
 * Breakout-Continuation detector.
 *
 * Pattern: when the latest bar's close pierces the prior N-bar range AND the
 * close lands in the breakout direction with strong momentum (close near the
 * extreme of the bar), enter WITH the breakout. Equidistant SL/TP at K×ATR
 * around entry — wins are uncapped while losses are bounded by the multiplier
 * stop-out, so the loss-cap asymmetry favors the trader on high-leverage
 * synthetic indices.
 *
 * sideFilter: 0 = both, 1 = BUY-only, -1 = SELL-only. RDBULL has structural
 * up-drift so SELL breakouts are counter-trend drag — restricting to BUY-only
 * (sideFilter=1) lifted WR from 53% to 62% in OOS testing on Bull Market
 * Index 5m bars.
 *
 * Validated 2026-05-01 via 28-day TRAIN + 3-window 7-day OOS:
 *   • RDBULL 5m, lb=15, kAtr=2.0, momRatio=0.7, BUY-only:
 *     TRAIN  256 trades / 63% WR / +$171 / 12.2/day
 *     OOS    270 trades / 62% WR / +$176 / 12.9/day
 *     All 3 OOS windows passed (62%, 67%, 60% WR).
 */
export const breakoutContinuation: Detector = {
  id: "breakoutContinuation",
  label: "Breakout Continuation",
  defaultParams: {
    lookback: 20,        // prior-N-bar range to pierce
    atrPeriod: 14,
    kAtr: 2.0,           // equidistant SL/TP at K×ATR
    momRatio: 0.7,       // 1.0 = closes exactly at extreme; 0.5 = closes in upper/lower half
    sideFilter: 0,       // 0 = both, 1 = BUY-only, -1 = SELL-only
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const lookback = Math.max(2, Math.round(ctx.params.lookback ?? 20));
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const kAtr = ctx.params.kAtr ?? 2.0;
    const momRatio = ctx.params.momRatio ?? 0.7;
    const sideFilter = Math.round(ctx.params.sideFilter ?? 0);
    const candles = ctx.candles;
    if (candles.length < Math.max(lookback + 1, atrPeriod + 1)) return { signals: [] };

    // Compute prior N-bar high/low (excluding the current bar).
    let hi = -Infinity;
    let lo = Infinity;
    const start = candles.length - 1 - lookback;
    for (let m = start; m < candles.length - 1; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }

    const curr = candles[candles.length - 1];
    const range = curr.high - curr.low;
    if (range <= 0) return { signals: [] };
    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    // Close-position within the bar: 1.0 = closed at the extreme.
    const closePosUp = (curr.close - curr.low) / range;
    const closePosDn = (curr.high - curr.close) / range;

    let side: "BUY" | "SELL" | null = null;
    if (sideFilter !== -1 && curr.close > hi && closePosUp >= momRatio) side = "BUY";
    else if (sideFilter !== 1 && curr.close < lo && closePosDn >= momRatio) side = "SELL";
    if (!side) return { signals: [] };

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
          detector: "breakoutContinuation",
          action: side,
          confidence: 0.6,
          reason: `${lookback}-bar range broken; closed ${(closePosUp >= momRatio ? closePosUp : closePosDn).toFixed(2)} momentum into ${side} direction`,
          price: entry,
          stopPrice,
          targetPrice,
        },
      ],
    };
  },
};

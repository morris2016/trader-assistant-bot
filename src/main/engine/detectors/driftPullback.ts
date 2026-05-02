import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import { latestAtr } from "../indicators";

/**
 * Drift-Pullback detector — high-WR mean-reversion designed for martingale.
 *
 * Pattern: on assets with structural drift (CRASH = up-drift, RDBULL =
 * up-drift, RDBEAR = down-drift), a pullback against drift is a buying
 * opportunity into the dominant direction. After `consec` consecutive bars
 * closing AGAINST drift, fade back INTO drift direction.
 *
 * Levels are EQUIDISTANT at K × ATR around entry — TP and SL the same
 * distance from close. This is intentional: martingale doubling on each
 * loss exactly recovers the prior cumulative loss + base profit only when
 * R:R ≈ 1:1. Strategies with R:R < 1 require steeper-than-2× escalation
 * which compounds bust risk.
 *
 * Validated 2026-04-30 via 31-day historical Deriv backtest, scored by
 * martingale-cycle expectancy:
 *   • CRASH300N 5m (consec=3, kAtr=1.0, drift=up): 454 trades / 31.2d, WR 59%,
 *     RR 1.00, bust 1.19%, cycle EV +$0.24, daily EV +$2.11.
 * Stable across both halves of the 31-day window.
 */
export const driftPullback: Detector = {
  id: "driftPullback",
  label: "Drift Pullback",
  defaultParams: {
    driftDirection: 0,    // 1 = up-drift (CRASH/RDBULL), -1 = down-drift (RDBEAR)
    consec: 3,            // require this many consecutive against-drift closes
    atrPeriod: 14,
    kAtr: 1.0,            // equidistant SL/TP at K × ATR (R:R = 1:1)
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const driftDirection = Math.round(ctx.params.driftDirection ?? 0);
    if (driftDirection !== 1 && driftDirection !== -1) return { signals: [] };
    const consec = Math.max(1, Math.round(ctx.params.consec ?? 3));
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const kAtr = ctx.params.kAtr ?? 1.0;
    const candles = ctx.candles;
    if (candles.length < Math.max(atrPeriod + 1, consec + 1)) return { signals: [] };

    // Last `consec` bars must all close against drift (close < prev_close for
    // up-drift, close > prev_close for down-drift).
    let allAgainst = true;
    for (let m = candles.length - consec; m < candles.length; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const move = candles[m].close - prev;
      if (driftDirection === 1 && move >= 0) { allAgainst = false; break; }
      if (driftDirection === -1 && move <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) return { signals: [] };

    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    const curr = candles[candles.length - 1];
    const entry = curr.close;
    const dist = kAtr * atr;
    const side: "BUY" | "SELL" = driftDirection === 1 ? "BUY" : "SELL";
    const stopPrice = side === "BUY" ? entry - dist : entry + dist;
    const targetPrice = side === "BUY" ? entry + dist : entry - dist;

    return {
      signals: [
        {
          id: randomUUID(),
          ts: curr.epoch * 1000,
          symbol: ctx.symbol,
          detector: "driftPullback",
          action: side,
          confidence: 0.6,
          reason: `${consec}-bar pullback against ${driftDirection === 1 ? "up" : "down"}-drift — fade back to drift direction`,
          price: entry,
          stopPrice,
          targetPrice,
        },
      ],
    };
  },
};

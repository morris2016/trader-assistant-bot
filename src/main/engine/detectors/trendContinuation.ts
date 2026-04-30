import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import { latestAtr } from "../indicators";

/**
 * Trend Continuation detector — fires on bar close when the last `lookback`
 * closes are monotonically in the configured direction. Used by the fast-trade
 * sandbox to scalp drift on Boom/Crash synthetics where the underlying
 * synthetic spec has a deterministic drift between rare spikes.
 *
 * Params:
 *   • direction: 1 = BUY-only (drift up, e.g. CRASH500N), -1 = SELL-only
 *     (drift down, e.g. BOOM300N), 0 = both directions enabled
 *   • lookback: number of consecutive same-direction closes required (default 1)
 *   • atrPeriod: ATR window (default 14)
 *   • atrTpMul: TP distance in ATR multiples (default 0.3 — tight TP since drift
 *     is reliable but small per bar)
 *   • atrSlMul: SL distance in ATR multiples (default 2.0 — wide SL to survive
 *     a single spike against the drift)
 *
 * No state machine, no retest logic — every qualifying bar fires a signal. This
 * is by design: martingale at the trade layer recovers the rare big losses.
 */
export const trendContinuation: Detector = {
  id: "trendContinuation",
  label: "Trend Continuation",
  defaultParams: {
    direction: 0,    // 0 = both, 1 = buy-only, -1 = sell-only
    lookback: 1,     // 1 = "last bar in direction"; 3 = "last 3 monotonic"
    atrPeriod: 14,
    atrTpMul: 0.3,
    atrSlMul: 2.0,
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const direction = Math.round(ctx.params.direction ?? 0);
    const lookback = Math.max(1, Math.round(ctx.params.lookback ?? 1));
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const atrTpMul = ctx.params.atrTpMul ?? 0.3;
    const atrSlMul = ctx.params.atrSlMul ?? 2.0;
    const candles = ctx.candles;
    if (candles.length < Math.max(atrPeriod + 1, lookback + 1)) {
      return { signals: [] };
    }
    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    // Check the last `lookback` bars all closed in the same direction.
    // For BUY: each bar close > open. For SELL: each bar close < open.
    const tail = candles.slice(-lookback);
    const allUp = tail.every((c) => c.close > c.open);
    const allDown = tail.every((c) => c.close < c.open);

    let action: "BUY" | "SELL" | null = null;
    if (allUp && (direction === 0 || direction === 1)) action = "BUY";
    else if (allDown && (direction === 0 || direction === -1)) action = "SELL";
    if (!action) return { signals: [] };

    const curr = candles[candles.length - 1];
    const entry = curr.close;
    const stopPrice = action === "BUY" ? entry - atrSlMul * atr : entry + atrSlMul * atr;
    const targetPrice = action === "BUY" ? entry + atrTpMul * atr : entry - atrTpMul * atr;

    return {
      signals: [
        {
          id: randomUUID(),
          ts: curr.epoch * 1000,
          symbol: ctx.symbol,
          detector: "trendContinuation",
          action,
          confidence: 0.6,
          reason: `${lookback}-bar ${action === "BUY" ? "up" : "down"} continuation`,
          price: entry,
          stopPrice,
          targetPrice,
        },
      ],
    };
  },
};

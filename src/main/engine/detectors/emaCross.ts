import { EMA } from "technicalindicators";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import type { Signal } from "@shared/types";
import { randomUUID } from "node:crypto";

// emaCross is stateless across calls — all it needs is ctx.candles.

export const emaCross: Detector = {
  id: "emaCross",
  label: "EMA 9/21 Cross",
  defaultParams: { fast: 9, slow: 21 },

  onClose(ctx: DetectorContext): DetectorOutput {
    const fastLen = ctx.params.fast ?? 9;
    const slowLen = ctx.params.slow ?? 21;
    const closes = ctx.candles.map((c) => c.close);

    if (closes.length < slowLen + 2) return { signals: [] };

    const fast = EMA.calculate({ period: fastLen, values: closes });
    const slow = EMA.calculate({ period: slowLen, values: closes });

    // Align tail-ends of the three arrays (closes has the most; indicators lag).
    const fPrev = fast[fast.length - 2];
    const fCurr = fast[fast.length - 1];
    const sPrev = slow[slow.length - 2];
    const sCurr = slow[slow.length - 1];
    if (fPrev == null || fCurr == null || sPrev == null || sCurr == null) return { signals: [] };

    const bar = ctx.candles[ctx.candles.length - 1];
    const signals: Signal[] = [];

    const crossedUp = fPrev <= sPrev && fCurr > sCurr;
    const crossedDown = fPrev >= sPrev && fCurr < sCurr;

    if (crossedUp) {
      signals.push({
        id: randomUUID(),
        ts: bar.epoch * 1000,
        symbol: ctx.symbol,
        detector: "emaCross",
        action: "BUY",
        confidence: clamp(Math.abs(fCurr - sCurr) / bar.close * 1000, 0.3, 0.95),
        reason: `EMA${fastLen} crossed above EMA${slowLen}`,
        price: bar.close,
      });
    } else if (crossedDown) {
      signals.push({
        id: randomUUID(),
        ts: bar.epoch * 1000,
        symbol: ctx.symbol,
        detector: "emaCross",
        action: "SELL",
        confidence: clamp(Math.abs(fCurr - sCurr) / bar.close * 1000, 0.3, 0.95),
        reason: `EMA${fastLen} crossed below EMA${slowLen}`,
        price: bar.close,
      });
    }

    return { signals };
  },
};

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

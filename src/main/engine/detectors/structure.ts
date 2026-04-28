import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import type { Signal, StructureMark } from "@shared/types";
import { detectSwings, type Swing } from "../indicators";

/**
 * BOS (Break of Structure) / CHoCH (Change of Character) detector.
 *
 * Definitions used here:
 *   • Trend is inferred from the last two confirmed highs and the last two
 *     confirmed lows:
 *       - uptrend:  HH (last high > prior high) AND HL (last low > prior low)
 *       - downtrend: LL AND LH
 *       - otherwise neutral.
 *   • BOS up: during an uptrend, close breaks above the most recent confirmed
 *     swing high. Continuation signal → BUY.
 *   • BOS down: during a downtrend, close breaks below the most recent confirmed
 *     swing low. Continuation signal → SELL.
 *   • CHoCH up: during a downtrend, close breaks above the most recent confirmed
 *     swing high. Potential reversal → BUY (more conservative).
 *   • CHoCH down: during an uptrend, close breaks below the most recent confirmed
 *     swing low. Potential reversal → SELL.
 *
 * De-duplication: once a swing has been broken we mark it; it doesn't
 * re-emit on subsequent bars.
 */

type StructureState = {
  /** Swing indices already broken (by candle index) so we don't re-emit. */
  brokenHighs: Set<number>;
  brokenLows: Set<number>;
};

const STATE_KEY = "structure";

function stateFor(ctx: DetectorContext): StructureState {
  let s = ctx.state[STATE_KEY] as StructureState | undefined;
  if (!s) {
    s = { brokenHighs: new Set(), brokenLows: new Set() };
    ctx.state[STATE_KEY] = s;
  }
  return s;
}

function inferTrend(swings: Swing[]): "up" | "down" | "neutral" {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  const h2 = highs.slice(-2);
  const l2 = lows.slice(-2);
  if (h2.length === 2 && l2.length === 2) {
    if (h2[1].price > h2[0].price && l2[1].price > l2[0].price) return "up";
    if (h2[1].price < h2[0].price && l2[1].price < l2[0].price) return "down";
  }
  return "neutral";
}

export const structure: Detector = {
  id: "structure",
  label: "BOS / CHoCH (Market Structure)",
  defaultParams: {
    swingLeft: 3,
    swingRight: 3,
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const left = ctx.params.swingLeft ?? 3;
    const right = ctx.params.swingRight ?? 3;
    const candles = ctx.candles;
    if (candles.length < left + right + 5) return { signals: [] };

    const curr = candles[candles.length - 1];
    const s = stateFor(ctx);
    const swings = detectSwings(candles, left, right);
    if (swings.length < 4) return { signals: [] };

    const trend = inferTrend(swings);

    // Find most recent unbroken confirmed swing high + low.
    const lastHigh = [...swings].reverse().find((sw) => sw.kind === "high" && !s.brokenHighs.has(sw.index));
    const lastLow = [...swings].reverse().find((sw) => sw.kind === "low" && !s.brokenLows.has(sw.index));

    const out: DetectorOutput = { signals: [], structureMarks: [] };

    if (lastHigh && curr.close > lastHigh.price && curr.high > lastHigh.price) {
      s.brokenHighs.add(lastHigh.index);
      const isBOS = trend === "up";
      const isCHoCH = trend === "down";
      if (isBOS || isCHoCH) {
        const tag = isBOS ? "BOS" : "CHoCH";
        out.signals.push(makeSignal(ctx, curr, "BUY", tag, isBOS ? 0.65 : 0.55));
        out.structureMarks!.push({
          id: randomUUID(),
          symbol: ctx.symbol,
          kind: tag,
          side: "up",
          price: lastHigh.price,
          swingEpoch: lastHigh.epoch,
          breakEpoch: curr.epoch,
        } satisfies StructureMark);
      }
    }

    if (lastLow && curr.close < lastLow.price && curr.low < lastLow.price) {
      s.brokenLows.add(lastLow.index);
      const isBOS = trend === "down";
      const isCHoCH = trend === "up";
      if (isBOS || isCHoCH) {
        const tag = isBOS ? "BOS" : "CHoCH";
        out.signals.push(makeSignal(ctx, curr, "SELL", tag, isBOS ? 0.65 : 0.55));
        out.structureMarks!.push({
          id: randomUUID(),
          symbol: ctx.symbol,
          kind: tag,
          side: "down",
          price: lastLow.price,
          swingEpoch: lastLow.epoch,
          breakEpoch: curr.epoch,
        } satisfies StructureMark);
      }
    }

    return out;
  },
};

function makeSignal(
  ctx: DetectorContext,
  curr: { epoch: number; close: number },
  action: "BUY" | "SELL",
  tag: "BOS" | "CHoCH",
  confidence: number,
): Signal {
  return {
    id: randomUUID(),
    ts: curr.epoch * 1000,
    symbol: ctx.symbol,
    detector: "structure",
    action,
    confidence,
    reason: `${tag} — ${action === "BUY" ? "swept swing high" : "swept swing low"}`,
    price: curr.close,
  };
}

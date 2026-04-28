import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import type { Candle, OrderBlock } from "@shared/types";
import { latestAtr } from "../indicators";

/**
 * Fair Value Gap / Imbalance detector.
 *
 * Pattern (3-bar window): candles[i-2], candles[i-1], candles[i].
 *   • Bullish FVG: candles[i-2].high < candles[i].low  → gap UP.
 *     Zone = [ candles[i-2].high, candles[i].low ].
 *   • Bearish FVG: candles[i-2].low  > candles[i].high → gap DOWN.
 *     Zone = [ candles[i].high,   candles[i-2].low  ].
 *
 * The middle candle is usually the displacement bar. A retest of the zone is
 * a typical SMC entry — we emit a signal on the first re-touch.
 *
 * Small gaps (< minGapAtrMul × ATR) are ignored to filter out noise, especially
 * important on synthetics where 3-candle micro-gaps are constant.
 */

type FvgState = {
  active: Map<string, OrderBlock>;
};

const STATE_KEY = "fvg";

function stateFor(ctx: DetectorContext): FvgState {
  let s = ctx.state[STATE_KEY] as FvgState | undefined;
  if (!s) {
    s = { active: new Map() };
    ctx.state[STATE_KEY] = s;
  }
  return s;
}

export const fairValueGap: Detector = {
  id: "fvg",
  label: "Fair Value Gap (Imbalance)",
  defaultParams: {
    atrPeriod: 14,
    minGapAtrMul: 0.15,   // TEMP relaxed: was 0.35. Smaller gaps now qualify as FVGs.
    maxActive: 12,        // keep at most N active FVGs per direction to avoid clutter
    targetRMult: 3.0,     // TP at N × structural stop distance
    entryDepth: 0,        // 0 = edge (first touch), 1 = ce (50%), 2 = far (full fill)
    stopBufferAtrMul: 0.1, // buffer past gap-bottom (BULL) / gap-top (BEAR)
    requireRejection: 0,  // 0 = touch, 1 = require close outside zone in FVG direction
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const minGapAtrMul = ctx.params.minGapAtrMul ?? 0.35;
    const maxActive = ctx.params.maxActive ?? 12;
    const candles = ctx.candles;
    if (candles.length < atrPeriod + 3) return { signals: [] };

    const curr = candles[candles.length - 1];
    const mid = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];
    const s = stateFor(ctx);
    const atr = latestAtr(candles, atrPeriod);

    const output: DetectorOutput = { signals: [], orderBlocks: [], mitigatedBlockIds: [] };

    if (atr <= 0) return output;

    // --- Detect new FVG (bar just closed is the third leg) ------------------
    if (prev2.high < curr.low) {
      const gap = curr.low - prev2.high;
      if (gap >= minGapAtrMul * atr) {
        const block: OrderBlock = {
          id: randomUUID(),
          symbol: ctx.symbol,
          kind: "fvg",
          side: "BULL",
          top: curr.low,
          bottom: prev2.high,
          startEpoch: mid.epoch,
          endEpoch: null,
          mitigated: false,
        };
        s.active.set(block.id, block);
        output.orderBlocks!.push(block);
      }
    } else if (prev2.low > curr.high) {
      const gap = prev2.low - curr.high;
      if (gap >= minGapAtrMul * atr) {
        const block: OrderBlock = {
          id: randomUUID(),
          symbol: ctx.symbol,
          kind: "fvg",
          side: "BEAR",
          top: prev2.low,
          bottom: curr.high,
          startEpoch: mid.epoch,
          endEpoch: null,
          mitigated: false,
        };
        s.active.set(block.id, block);
        output.orderBlocks!.push(block);
      }
    }

    // Trim oldest FVGs if we exceed the cap.
    if (s.active.size > maxActive * 2) {
      const ids = Array.from(s.active.keys()).slice(0, s.active.size - maxActive * 2);
      for (const id of ids) s.active.delete(id);
    }

    // --- Mitigation + retest signals ----------------------------------------
    const prev = candles[candles.length - 2];
    const targetRMult = ctx.params.targetRMult ?? 3.0;
    const entryDepth = Math.max(0, Math.min(2, Math.round(ctx.params.entryDepth ?? 0)));
    const stopBuffer = atr * (ctx.params.stopBufferAtrMul ?? 0.1);
    const requireRejection = (ctx.params.requireRejection ?? 0) >= 1;

    for (const block of s.active.values()) {
      if (block.mitigated) continue;

      // Trigger level depends on entryDepth.
      // BULL FVG: zone is [bottom, top] above prior resistance; price retraces DOWN into it.
      //   edge = top, ce = midpoint, far = bottom.
      // BEAR FVG: zone is [bottom, top] below prior support; price retraces UP into it.
      //   edge = bottom, ce = midpoint, far = top.
      const triggerLevel =
        block.side === "BULL"
          ? entryDepth === 0 ? block.top
            : entryDepth === 1 ? (block.top + block.bottom) / 2
            : block.bottom
          : entryDepth === 0 ? block.bottom
            : entryDepth === 1 ? (block.top + block.bottom) / 2
            : block.top;

      const reachedTrigger =
        block.side === "BULL" ? curr.low <= triggerLevel : curr.high >= triggerLevel;

      const cameFromOutside =
        (block.side === "BULL" && prev.low > block.top) ||
        (block.side === "BEAR" && prev.high < block.bottom);

      // Optional rejection filter: require close back outside the zone in FVG direction.
      const rejected = requireRejection
        ? (block.side === "BULL"
            ? curr.close > block.top && curr.close > curr.open
            : curr.close < block.bottom && curr.close < curr.open)
        : true;

      if (reachedTrigger && cameFromOutside && rejected) {
        // Structural stop: fully past the gap (gap fully mitigated → thesis dead).
        const stopPrice = block.side === "BULL"
          ? block.bottom - stopBuffer
          : block.top + stopBuffer;
        const entry = curr.close;
        const stopDist = Math.abs(entry - stopPrice);
        const targetPrice = block.side === "BULL"
          ? entry + targetRMult * stopDist
          : entry - targetRMult * stopDist;

        output.signals.push({
          id: randomUUID(),
          ts: curr.epoch * 1000,
          symbol: ctx.symbol,
          detector: "fvg",
          action: block.side === "BULL" ? "BUY" : "SELL",
          confidence: 0.55,
          reason: `${block.side === "BULL" ? "Bullish" : "Bearish"} FVG retested`,
          price: entry,
          stopPrice,
          targetPrice,
        });
        // Mark block as consumed so we don't re-fire on the next bar.
        block.mitigated = true;
        block.endEpoch = curr.epoch;
        output.mitigatedBlockIds!.push(block.id);
        continue;
      }

      const fullyMitigated =
        (block.side === "BULL" && curr.close < block.bottom) ||
        (block.side === "BEAR" && curr.close > block.top);

      if (fullyMitigated) {
        block.mitigated = true;
        block.endEpoch = curr.epoch;
        output.mitigatedBlockIds!.push(block.id);
      }
    }

    return output;
  },
};

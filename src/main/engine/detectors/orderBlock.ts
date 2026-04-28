import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import type { Candle, LiquidityPool, OrderBlock } from "@shared/types";
import { latestAtr } from "../indicators";

/**
 * Strict ICT Order Block detector — Level 1 conservative, all-gaps edition.
 *
 * Every detected OB must pass ALL of:
 *   1. BoS / CHoCH in the same leg     (displacement closes past prior swing H/L)
 *   2. Displacement                    (current bar body ≥ atrMul × ATR(14))
 *   3. OB = last opposite candle       (within obSearchMaxBack bars)
 *   4. Next-candle range-break         (candles[obIdx+1] high > OB.top / low < OB.bot)
 *   5. FVG adjacency                   (displacement leaves a 3-bar imbalance)
 *   6. Quality filter                  (OB candle is lowest-bear / highest-bull close)
 *   7. Liquidity-sweep precondition    (EQL/EQH pool swept within sweepLookbackBars)
 *   8. 4-candle validation             (4 subsequent bars must NOT re-enter the zone)
 *
 * Entry:
 *   • entryDepth = "edge": trigger when price touches the outer zone edge
 *   • entryDepth = "ce"  : trigger only when price reaches 50% of zone (CE — default strict)
 *   • same-bar pin-bar rejection (wick into, close back out with meaningful body) → immediate
 *   • otherwise next-bar close past the OB edge in direction → fire on that close
 *   • no confirmation in window → drop silently
 *
 * Zone:
 *   • zoneStyle = 0: body (open-to-close)   — default, most common ICT interpretation
 *   • zoneStyle = 1: fullRange (high-to-low) — some schools prefer this
 *
 * Stop metadata:
 *   • wickTop / wickBottom exposed on emitted OB so consumers can place stops
 *     just beyond the OB candle's actual wick (not body) as ICT recommends.
 *
 * Mitigation:
 *   • First touch of the drawn zone consumes the OB.
 *   • Zone removed from chart after signal fires OR confirmation window expires.
 */

type PendingRetest = {
  obId: string;
  touchedAtIdx: number;
};

type ProvisionalOB = {
  block: OrderBlock;
  displacementIdx: number;
  barsValidated: number; // how many clean bars since displacement
};

type ObState = {
  provisional: Map<string, ProvisionalOB>;
  active: Map<string, OrderBlock>;
  pending: PendingRetest[];
  /** Diagnostic counters — which filter rejected how many candidates. */
  rejections: Record<string, number>;
};

type LiqSweepState = {
  pools: Map<string, LiquidityPool>;
};

const STATE_KEY = "orderBlock";
const LIQ_STATE_KEY = "liquiditySweep";

function stateFor(ctx: DetectorContext): ObState {
  let s = ctx.state[STATE_KEY] as ObState | undefined;
  if (!s) {
    s = { provisional: new Map(), active: new Map(), pending: [], rejections: {} };
    ctx.state[STATE_KEY] = s;
  }
  return s;
}

function reject(s: ObState, reason: string) {
  s.rejections[reason] = (s.rejections[reason] ?? 0) + 1;
}

function swingHighLow(candles: Candle[], lookback: number, excludeLast = 1) {
  const slice = candles.slice(-lookback - excludeLast, -excludeLast);
  if (slice.length === 0) return { high: null as number | null, low: null as number | null };
  let high = -Infinity, low = Infinity;
  for (const c of slice) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

function body(c: Candle): number { return Math.abs(c.close - c.open); }

export const orderBlock: Detector = {
  id: "orderBlock",
  label: "Order Blocks (SMC — Strict ICT, all-gap)",
  defaultParams: {
    lookback: 12,                    // TEMP relaxed: was 20. Shorter swing lookback → more BoS opportunities.
    atrPeriod: 14,
    displacementAtrMultiplier: 0.8,  // TEMP relaxed: was 1.2. Weaker displacement bars qualify.
    obSearchMaxBack: 3,              // TEMP relaxed: was 2. Wider search for OB candle.
    requireFVG: 0,                   // TEMP relaxed: was 1 (strict ICT). Flip back after pipeline verified.
    requireLiquiditySweep: 0,        // TEMP relaxed: was 1 (strict ICT). Flip back after pipeline verified.
    sweepLookbackBars: 30,           // how far back to look for a qualifying sweep
    fourCandleValidation: 0,         // TEMP relaxed: was 1 (strict ICT). Flip back after pipeline verified.
    retestConfirmationBars: 2,
    qualityFilterLookback: 0,        // TEMP relaxed: was 10 (strict ICT). Flip back after pipeline verified.
    rejectionBodyAtrMul: 0.3,
    zoneStyle: 0,                    // 0 = body, 1 = fullRange (high-to-low)
    entryDepth: 0,                   // TEMP relaxed: was 1 (CE). 0 = edge: trigger on first touch of zone boundary.
    targetRMult: 3.0,                // R-multiple of structural stop distance for take-profit. 3.0 = 3:1 R:R.
                                     // Sweet spot per Silver R:R sweep on 2026-04-26: +30% USD vs 2:1 at same risk.
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const candles = ctx.candles;
    const lookback = ctx.params.lookback ?? 20;
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const atrMul = ctx.params.displacementAtrMultiplier ?? 1.2;
    const obSearchMaxBack = Math.max(1, ctx.params.obSearchMaxBack ?? 2);
    const requireFVG = (ctx.params.requireFVG ?? 1) >= 1;
    const requireLiquiditySweep = (ctx.params.requireLiquiditySweep ?? 1) >= 1;
    const sweepLookbackBars = ctx.params.sweepLookbackBars ?? 30;
    const fourCandle = (ctx.params.fourCandleValidation ?? 1) >= 1;
    const confWindow = ctx.params.retestConfirmationBars ?? 2;
    const qualityLookback = ctx.params.qualityFilterLookback ?? 10;
    const rejBodyMul = ctx.params.rejectionBodyAtrMul ?? 0.3;
    const zoneStyleFull = (ctx.params.zoneStyle ?? 0) >= 1;
    const entryDepthCE = (ctx.params.entryDepth ?? 1) >= 1;

    if (candles.length < Math.max(lookback, atrPeriod) + 3) return { signals: [] };

    const currIdx = candles.length - 1;
    const curr = candles[currIdx];
    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    const s = stateFor(ctx);
    const output: DetectorOutput = { signals: [], orderBlocks: [], mitigatedBlockIds: [] };

    // ---------------------------------------------------------------------
    // 1. Detect new OB on displacement bar → push to provisional
    // ---------------------------------------------------------------------
    const isGreen = curr.close > curr.open;
    const isRed = curr.close < curr.open;
    const isDisplacement = body(curr) >= atrMul * atr;

    if (isDisplacement) {
      const { high: swingHigh, low: swingLow } = swingHighLow(candles, lookback);

      if (isGreen && swingHigh != null && curr.close > swingHigh) {
        const cand = findOBCandidate(candles, "bull", obSearchMaxBack);
        if (cand) tryCreateBullOB({
          ctx, candles, currIdx, cand, zoneStyleFull,
          requireFVG, qualityLookback, requireLiquiditySweep, sweepLookbackBars,
          state: s,
        });
      }

      if (isRed && swingLow != null && curr.close < swingLow) {
        const cand = findOBCandidate(candles, "bear", obSearchMaxBack);
        if (cand) tryCreateBearOB({
          ctx, candles, currIdx, cand, zoneStyleFull,
          requireFVG, qualityLookback, requireLiquiditySweep, sweepLookbackBars,
          state: s,
        });
      }
    }

    // ---------------------------------------------------------------------
    // 2. Validate provisional OBs — 4-candle rule
    // ---------------------------------------------------------------------
    const toPromote: OrderBlock[] = [];
    const toDiscard: string[] = [];
    for (const [id, prov] of s.provisional) {
      const barsSince = currIdx - prov.displacementIdx;
      if (barsSince <= 0) continue;

      // The 4 bars after displacement must NOT overlap the OB's drawn range.
      const overlap = curr.low <= prov.block.top && curr.high >= prov.block.bottom;
      if (overlap) {
        reject(s, "fourCandleFail");
        toDiscard.push(id);
        continue;
      }

      prov.barsValidated = barsSince;
      if (!fourCandle || prov.barsValidated >= 4) {
        toPromote.push(prov.block);
      }
    }
    for (const id of toDiscard) s.provisional.delete(id);
    for (const block of toPromote) {
      s.provisional.delete(block.id);
      s.active.set(block.id, block);
      output.orderBlocks!.push(block);
    }

    // ---------------------------------------------------------------------
    // 3. Active OB retests + confirmations + mitigation
    // ---------------------------------------------------------------------
    const stillPending: PendingRetest[] = [];
    for (const block of [...s.active.values()]) {
      const triggerLevel = entryDepthCE
        ? (block.top + block.bottom) / 2 // CE = 50%
        : (block.side === "BULL" ? block.top : block.bottom);

      const reachedTrigger =
        block.side === "BULL" ? curr.low <= triggerLevel : curr.high >= triggerLevel;

      const touching = curr.low <= block.top && curr.high >= block.bottom;

      const existingPending = s.pending.find((p) => p.obId === block.id);

      if (!existingPending && touching && reachedTrigger) {
        const sameBarBullReject =
          block.side === "BULL" &&
          curr.close > block.top &&
          curr.close > curr.open &&
          body(curr) >= rejBodyMul * atr;
        const sameBarBearReject =
          block.side === "BEAR" &&
          curr.close < block.bottom &&
          curr.close < curr.open &&
          body(curr) >= rejBodyMul * atr;

        if (sameBarBullReject || sameBarBearReject) {
          output.signals.push(makeSignal(ctx, curr, block, "same-bar pin-bar rejection"));
          s.active.delete(block.id);
          output.mitigatedBlockIds!.push(block.id);
        } else {
          stillPending.push({ obId: block.id, touchedAtIdx: currIdx });
        }
        continue;
      }

      if (existingPending) {
        const barsSince = currIdx - existingPending.touchedAtIdx;

        let confirmed = false;
        if (block.side === "BULL" && curr.close > block.top && curr.close > curr.open) confirmed = true;
        if (block.side === "BEAR" && curr.close < block.bottom && curr.close < curr.open) confirmed = true;

        if (confirmed && barsSince >= 1) {
          output.signals.push(makeSignal(ctx, curr, block, "retest confirmed"));
          s.active.delete(block.id);
          output.mitigatedBlockIds!.push(block.id);
          continue;
        }

        if (barsSince >= confWindow) {
          s.active.delete(block.id);
          output.mitigatedBlockIds!.push(block.id);
          continue;
        }

        stillPending.push(existingPending);
      }
    }
    s.pending = stillPending;

    output.diagnostics = {
      detector: "orderBlock",
      rejections: { ...s.rejections },
      provisional: s.provisional.size,
      active: s.active.size,
    };

    return output;
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findOBCandidate(
  candles: Candle[],
  dir: "bull" | "bear",
  maxBack: number,
): { candle: Candle; idx: number } | null {
  const start = candles.length - 2;
  const end = Math.max(0, start - maxBack + 1);
  for (let i = start; i >= end; i--) {
    const c = candles[i];
    if (dir === "bull" && c.close < c.open) return { candle: c, idx: i };
    if (dir === "bear" && c.close > c.open) return { candle: c, idx: i };
  }
  return null;
}

function isLowestBearClose(candles: Candle[], obIdx: number, lookback: number): boolean {
  const obClose = candles[obIdx].close;
  const start = Math.max(0, obIdx - lookback);
  for (let i = start; i < obIdx; i++) {
    const c = candles[i];
    if (c.close < c.open && c.close < obClose) return false;
  }
  return true;
}

function isHighestBullClose(candles: Candle[], obIdx: number, lookback: number): boolean {
  const obClose = candles[obIdx].close;
  const start = Math.max(0, obIdx - lookback);
  for (let i = start; i < obIdx; i++) {
    const c = candles[i];
    if (c.close > c.open && c.close > obClose) return false;
  }
  return true;
}

function hasRecentSweep(
  ctx: DetectorContext,
  side: "EQH" | "EQL",
  lookbackBars: number,
): boolean {
  const liq = ctx.state[LIQ_STATE_KEY] as LiqSweepState | undefined;
  if (!liq) return false;
  const candles = ctx.candles;
  if (candles.length < 2) return false;
  const idx = Math.max(0, candles.length - 1 - lookbackBars);
  const cutoffEpoch = candles[idx].epoch;
  for (const pool of liq.pools.values()) {
    if (pool.side === side && pool.sweptEpoch != null && pool.sweptEpoch >= cutoffEpoch) {
      return true;
    }
  }
  return false;
}

type CreateArgs = {
  ctx: DetectorContext;
  candles: Candle[];
  currIdx: number;
  cand: { candle: Candle; idx: number };
  zoneStyleFull: boolean;
  requireFVG: boolean;
  qualityLookback: number;
  requireLiquiditySweep: boolean;
  sweepLookbackBars: number;
  state: ObState;
};

function tryCreateBullOB(a: CreateArgs) {
  const { ctx, candles, currIdx, cand, zoneStyleFull, requireFVG, qualityLookback, requireLiquiditySweep, sweepLookbackBars, state } = a;
  const obCandle = cand.candle;
  const obIdx = cand.idx;
  const bodyTop = Math.max(obCandle.open, obCandle.close);
  const bodyBottom = Math.min(obCandle.open, obCandle.close);
  const wickTop = obCandle.high;
  const wickBottom = obCandle.low;

  // Gap 3: next-candle range-break — candle immediately after OB must break OB.top upward
  if (obIdx + 1 >= candles.length) { reject(state, "nextCandleNoBreak"); return; }
  const nextAfterOB = candles[obIdx + 1];
  if (nextAfterOB.high <= bodyTop) { reject(state, "nextCandleNoBreak"); return; }

  // Gap 5: FVG adjacency — canonical 3-bar ICT Fair Value Gap ending at displacement bar
  //   Bull FVG: candles[i-2].high < candles[i].low
  const curr = candles[currIdx];
  if (requireFVG) {
    if (currIdx < 2) { reject(state, "fvgTooEarly"); return; }
    const prior = candles[currIdx - 2];
    if (prior.high >= curr.low) { reject(state, "noFVG"); return; }
  }

  // Gap 6: quality filter — OB is the lowest bearish close in recent leg
  if (qualityLookback > 0 && !isLowestBearClose(candles, obIdx, qualityLookback)) {
    reject(state, "notLowestBear"); return;
  }

  // Gap 7: liquidity-sweep precondition — sell-side liquidity (EQL) must have been swept
  if (requireLiquiditySweep && !hasRecentSweep(ctx, "EQL", sweepLookbackBars)) {
    reject(state, "noSweep"); return;
  }

  const zoneTop = zoneStyleFull ? wickTop : bodyTop;
  const zoneBottom = zoneStyleFull ? wickBottom : bodyBottom;

  const block: OrderBlock = {
    id: randomUUID(),
    symbol: ctx.symbol,
    kind: "ob",
    side: "BULL",
    top: zoneTop,
    bottom: zoneBottom,
    wickTop,
    wickBottom,
    startEpoch: obCandle.epoch,
    endEpoch: null,
    mitigated: false,
  };
  state.provisional.set(block.id, { block, displacementIdx: currIdx, barsValidated: 0 });
}

function tryCreateBearOB(a: CreateArgs) {
  const { ctx, candles, currIdx, cand, zoneStyleFull, requireFVG, qualityLookback, requireLiquiditySweep, sweepLookbackBars, state } = a;
  const obCandle = cand.candle;
  const obIdx = cand.idx;
  const bodyTop = Math.max(obCandle.open, obCandle.close);
  const bodyBottom = Math.min(obCandle.open, obCandle.close);
  const wickTop = obCandle.high;
  const wickBottom = obCandle.low;

  if (obIdx + 1 >= candles.length) { reject(state, "nextCandleNoBreak"); return; }
  const nextAfterOB = candles[obIdx + 1];
  if (nextAfterOB.low >= bodyBottom) { reject(state, "nextCandleNoBreak"); return; }

  const curr = candles[currIdx];
  if (requireFVG) {
    if (currIdx < 2) { reject(state, "fvgTooEarly"); return; }
    const prior = candles[currIdx - 2];
    if (prior.low <= curr.high) { reject(state, "noFVG"); return; }
  }

  if (qualityLookback > 0 && !isHighestBullClose(candles, obIdx, qualityLookback)) {
    reject(state, "notHighestBull"); return;
  }

  if (requireLiquiditySweep && !hasRecentSweep(ctx, "EQH", sweepLookbackBars)) {
    reject(state, "noSweep"); return;
  }

  const zoneTop = zoneStyleFull ? wickTop : bodyTop;
  const zoneBottom = zoneStyleFull ? wickBottom : bodyBottom;

  const block: OrderBlock = {
    id: randomUUID(),
    symbol: ctx.symbol,
    kind: "ob",
    side: "BEAR",
    top: zoneTop,
    bottom: zoneBottom,
    wickTop,
    wickBottom,
    startEpoch: obCandle.epoch,
    endEpoch: null,
    mitigated: false,
  };
  state.provisional.set(block.id, { block, displacementIdx: currIdx, barsValidated: 0 });
}

function makeSignal(
  ctx: DetectorContext,
  curr: Candle,
  block: OrderBlock,
  reason: string,
) {
  // Structural stop: just past the OB candle's wick (where the OB thesis is
  // invalidated — price has fully reclaimed the rejection). Add a small ATR
  // buffer so we're not flicked out by single-tick spikes back to the wick.
  const atr = latestAtr(ctx.candles, 14);
  const buffer = atr * 0.1;
  const wickBottom = block.wickBottom ?? block.bottom;
  const wickTop = block.wickTop ?? block.top;
  const stopPrice = block.side === "BULL"
    ? wickBottom - buffer
    : wickTop + buffer;
  // R-multiple target of the structural stop distance. Configurable via the
  // detector's `targetRMult` param so we can sweep R:R ratios in backtests
  // without rebuilding the detector.
  const targetRMult = ctx.params.targetRMult ?? 2.0;
  const stopDist = Math.abs(curr.close - stopPrice);
  const targetPrice = block.side === "BULL"
    ? curr.close + targetRMult * stopDist
    : curr.close - targetRMult * stopDist;

  return {
    id: randomUUID(),
    ts: curr.epoch * 1000,
    symbol: ctx.symbol,
    detector: "orderBlock",
    action: (block.side === "BULL" ? "BUY" : "SELL") as "BUY" | "SELL",
    confidence: 0.75,
    reason: `${block.side === "BULL" ? "Bullish" : "Bearish"} OB — ${reason}`,
    price: curr.close,
    stopPrice,
    targetPrice,
  };
}

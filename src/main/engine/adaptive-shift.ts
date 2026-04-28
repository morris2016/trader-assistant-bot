// Adaptive shift: pattern-based stake modulation for production real trading.
// Validated 2026-04-28 in scripts/portfolio-adaptive-defense.ts (v4).
//
// PRINCIPLE: single losses are normal variance. Only PATTERNS (≥2 consecutive
// losses, or correlated burst on metals) trigger stake reduction. The bot keeps
// trading — it shifts size, not direction — until proof of regime recovery (a win).
//
// Validated impact (Nov 13 → Jan 23, $200/$40/15%):
//   OFF: $200 → $123 (−50% DD exit triggered Nov 27, account closed)
//   ON:  $200 → $5,486 (+2,643%, account survived to capture Dec-Jan rally)

import type { SymbolCode } from "@shared/types";

export type AdaptiveShiftState = {
  /** Consecutive portfolio losses; resets on first win. */
  consecLosses: number;
  /** Last 5 BUY trade outcomes (most recent last). */
  buyHistory: ("W" | "L")[];
  /** Last 5 SELL trade outcomes (most recent last). */
  sellHistory: ("W" | "L")[];
  /** Epoch (ms) of recent metals losses (last 12h kept). */
  metalsLossEpochs: number[];
  /** Epoch (ms) until which metals are throttled to 50% stake. */
  metalsThrottleUntil: number;
};

export function emptyAdaptiveShiftState(): AdaptiveShiftState {
  return {
    consecLosses: 0,
    buyHistory: [],
    sellHistory: [],
    metalsLossEpochs: [],
    metalsThrottleUntil: 0,
  };
}

/** Stake multiplier ladder by consecutive portfolio losses (resets on win). */
const STAKE_LADDER = [1.0, 1.0, 0.5, 0.25, 0.15];
/** Side-bias: if last 3 trades on a side have ≥2 losses, that side gets 30% multiplier. */
const SIDE_WINDOW = 3;
const SIDE_LOSS_THRESHOLD = 2;
const SIDE_DOWNWEIGHT = 0.30;
/** Metals correlation throttle: 2 metals losses within 4h → 50% stake on metals for 12h. */
const ASSET_BURST_WINDOW_MS = 4 * 3600 * 1000;
const ASSET_BURST_THROTTLE_MS = 12 * 3600 * 1000;
const ASSET_BURST_MULT = 0.50;
/** Floor: never compute multiplier < 0.10 to keep some skin in the game. */
const FLOOR_MULT = 0.10;

const METALS: ReadonlySet<string> = new Set(["frxXAUUSD", "frxXAGUSD", "frxXPTUSD", "frxXPDUSD"]);

export function isMetalsSymbol(symbol: SymbolCode): boolean {
  return METALS.has(symbol);
}

/**
 * Compute the stake multiplier for the next trade.
 * Returns a value in [FLOOR_MULT, 1.0].
 */
export function computeStakeMultiplier(
  state: AdaptiveShiftState,
  side: "BUY" | "SELL",
  symbol: SymbolCode,
  nowMs: number = Date.now(),
): { mult: number; reasons: string[] } {
  const reasons: string[] = [];

  // 1) Consecutive-loss ladder
  const ladderIdx = Math.min(state.consecLosses, STAKE_LADDER.length - 1);
  const ladderMult = STAKE_LADDER[ladderIdx];
  if (ladderMult < 1) reasons.push(`L${state.consecLosses}=${(ladderMult * 100).toFixed(0)}%`);

  // 2) Side-bias
  const sideHist = side === "BUY" ? state.buyHistory : state.sellHistory;
  const recentSide = sideHist.slice(-SIDE_WINDOW);
  const sideLosses = recentSide.filter((o) => o === "L").length;
  const sideMult =
    recentSide.length >= SIDE_WINDOW && sideLosses >= SIDE_LOSS_THRESHOLD ? SIDE_DOWNWEIGHT : 1;
  if (sideMult < 1) reasons.push(`${side}-bias=${(sideMult * 100).toFixed(0)}%`);

  // 3) Metals correlation throttle
  const isMetals = isMetalsSymbol(symbol);
  const metalsMult = isMetals && nowMs < state.metalsThrottleUntil ? ASSET_BURST_MULT : 1;
  if (metalsMult < 1) reasons.push(`metals-burst=${(metalsMult * 100).toFixed(0)}%`);

  const total = Math.max(FLOOR_MULT, ladderMult * sideMult * metalsMult);
  return { mult: total, reasons };
}

/**
 * Update the adaptive shift state after a trade settles.
 * Returns the new state (caller must persist).
 */
export function updateAfterTrade(
  state: AdaptiveShiftState,
  result: "W" | "L",
  side: "BUY" | "SELL",
  symbol: SymbolCode,
  nowMs: number = Date.now(),
): AdaptiveShiftState {
  const next: AdaptiveShiftState = {
    consecLosses: result === "W" ? 0 : state.consecLosses + 1,
    buyHistory: state.buyHistory.slice(),
    sellHistory: state.sellHistory.slice(),
    metalsLossEpochs: state.metalsLossEpochs.slice(),
    metalsThrottleUntil: state.metalsThrottleUntil,
  };
  if (side === "BUY") {
    next.buyHistory.push(result);
    if (next.buyHistory.length > 5) next.buyHistory = next.buyHistory.slice(-5);
  } else {
    next.sellHistory.push(result);
    if (next.sellHistory.length > 5) next.sellHistory = next.sellHistory.slice(-5);
  }
  if (result === "L" && isMetalsSymbol(symbol)) {
    next.metalsLossEpochs.push(nowMs);
    // Keep only losses within the burst window for memory hygiene
    const cutoff = nowMs - ASSET_BURST_WINDOW_MS;
    next.metalsLossEpochs = next.metalsLossEpochs.filter((e) => e >= cutoff);
    if (next.metalsLossEpochs.length >= 2) {
      next.metalsThrottleUntil = Math.max(next.metalsThrottleUntil, nowMs + ASSET_BURST_THROTTLE_MS);
    }
  }
  return next;
}

/** Returns a one-line human-readable status of the current shift state. */
export function describeShiftState(state: AdaptiveShiftState, nowMs = Date.now()): string {
  const parts: string[] = [];
  if (state.consecLosses > 0) parts.push(`${state.consecLosses}L streak`);
  const buyL = state.buyHistory.slice(-SIDE_WINDOW).filter((o) => o === "L").length;
  const sellL = state.sellHistory.slice(-SIDE_WINDOW).filter((o) => o === "L").length;
  if (state.buyHistory.length >= SIDE_WINDOW && buyL >= SIDE_LOSS_THRESHOLD) parts.push(`BUY-bias`);
  if (state.sellHistory.length >= SIDE_WINDOW && sellL >= SIDE_LOSS_THRESHOLD) parts.push(`SELL-bias`);
  if (nowMs < state.metalsThrottleUntil) {
    const remHrs = ((state.metalsThrottleUntil - nowMs) / 3600 / 1000).toFixed(1);
    parts.push(`metals-burst (${remHrs}h)`);
  }
  return parts.length > 0 ? parts.join(", ") : "normal";
}

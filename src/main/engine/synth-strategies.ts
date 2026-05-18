// Deriv synthetic-index strategies. SEPARATE from STRATEGIES (real-asset registry).
// These run in their own paper-trading sandbox so we can validate live performance
// before promoting to real trading.
//
// Reworked 2026-05-01: replaced the original 1h SMC stack (rdbull_fvg,
// jd100_sweep, boom300n_ob) with 5m high-frequency configs found via 28-day
// in-sample sweep + 3-window 7-day OOS validation. Old stack averaged ~3
// trades/day; new stack delivers ~52 trades/day combined at 57-63% WR. JD100
// dropped — no qualifying config across all detectors tested.
//
// Validation method: scripts/synth-rework-sweep.ts (in-sample, 28d Mar 30 →
// Apr 27) + scripts/synth-rework-oos.ts (3 OOS windows: Feb 1-8, Feb 22-Mar 1,
// Mar 15-22). Pass criteria: WR ≥ 55%, expR > 0, half-stable, ≥30 trades.

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

/**
 * BOOM 300N drift-pullback (5m, down-drift, k=2, kAtr=0.7).
 *
 * Pattern: BOOM 300N has structural down-drift (slow grind down) punctuated
 * by rare large up-spikes. After 2 consecutive up-closes (against drift), the
 * pullback is exhausted and price reverts toward the dominant down direction.
 * Equidistant SL/TP at 0.7×ATR — tight geometry trades smaller wins for
 * higher hit rate.
 *
 * Validation:
 *   In-sample (28d, Mar 30 → Apr 27): 1105 trades / 61% WR / +$56 / 39.5/day
 *   OOS aggregate (3×7d windows):     877 trades / 57% WR / +$30 / 41/day
 *   OOS breakdown:
 *     • W1 Feb 01-08:    283t / 61% WR / +$14.69 ✅
 *     • W2 Feb 22-Mar 01: 292t / 55% WR / +$6.83 ⚠ (borderline pass)
 *     • W3 Mar 15-22:    302t / 57% WR / +$8.34 ✅
 */
export const boom300nDrift: StrategyDescriptor = {
  id: "boom300n_drift",
  name: "BOOM 300N drift-pullback (5m, down-drift)",
  description:
    "5m drift-pullback on BOOM 300N. After 2 consecutive against-drift (up) closes, " +
    "SELL back into down-drift with equidistant SL/TP at 0.7×ATR (tight geometry, " +
    "high WR). ~40 trades/day at 57-61% WR.",
  symbols: ["BOOM300N"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "driftPullback",
    params: d.id === "driftPullback"
      ? { driftDirection: -1, consec: 2, atrPeriod: 14, kAtr: 0.7 }
      : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  validation: {
    validatedAt: "2026-05-01",
    sampleDays: 28,
    trades: 1105,
    winRate: 0.61,
    expectancyR: 0.051,
    pnlUsd: 56,
    stake: 1,
    multiplier: 100,
    notes: [
      "✓ 28-day in-sample TRAIN: 61% WR / +$56 / 40 trades/day / both halves +$25/+$31.",
      "✓ 3-window OOS (Feb-Mar 2026): 57% aggregate WR / +$29.85 / 41 trades/day. W1 and W3 PASS, W2 borderline at exactly 55% WR.",
      "Replaces 1h boom300n_ob (0.57/day). 70× higher cadence, similar accuracy band.",
      "Param sweep tested k∈{2,3} × kAtr∈{0.7, 1.0, 1.3} × tf∈{1m, 5m}. k=2/kAtr=0.7/5m won on edge×freq score.",
    ],
  },
};

/**
 * RDBULL breakout-continuation BUY-only (5m, lb=15, kAtr=2.0, momRatio=0.7).
 *
 * Pattern: Bull Market Index has structural up-drift and "breaks out" of
 * ranges in pulses. When price closes above the prior 15-bar high AND closes
 * in the upper 70% of the bar (strong momentum), enter LONG with the
 * breakout. Equidistant SL/TP at 2.0×ATR — wide geometry means losses are
 * capped by the multiplier stop-out (-100% stake) while wins are uncapped,
 * producing asymmetric R:R that pairs well with the 60%+ WR.
 *
 * BUY-only: SELL breakouts on RDBULL are counter-trend drag (51% WR);
 * filtering to BUY lifted WR to 62% in OOS.
 *
 * Validation:
 *   In-sample (28d, Mar 30 → Apr 27): 307 trades / 62% WR / +$200 / 11/day
 *   OOS aggregate (3×7d windows):     256 trades / 63% WR / +$171 / 12/day
 *   OOS breakdown (3/3 windows pass):
 *     • W1 Feb 01-08:    97t / 62% WR / +$63.16 ✅
 *     • W2 Feb 22-Mar 01: 79t / 67% WR / +$62.21 ✅
 *     • W3 Mar 15-22:    80t / 60% WR / +$46.07 ✅
 */
export const rdbullBreakout: StrategyDescriptor = {
  id: "rdbull_breakout",
  name: "RDBULL breakout-continuation (5m, BUY-only)",
  description:
    "5m breakout-continuation on Bull Market Index (RDBULL). When close pierces " +
    "the prior 15-bar high with strong momentum (close in upper 70% of bar), enter " +
    "LONG with equidistant SL/TP at 2.0×ATR. ~12 trades/day at 60-67% WR. SELL-side " +
    "filtered out — RDBULL up-drift makes down-breakouts counter-trend.",
  symbols: ["RDBULL"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation"
      ? { lookback: 15, atrPeriod: 14, kAtr: 2.0, momRatio: 0.7, sideFilter: 1 }
      : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  buyOnly: true,
  validation: {
    validatedAt: "2026-05-01",
    sampleDays: 28,
    trades: 307,
    winRate: 0.62,
    expectancyR: 0.650,
    pnlUsd: 200,
    stake: 1,
    multiplier: 100,
    notes: [
      "✓ 28-day in-sample TRAIN: 62% WR / +$200 / 11 trades/day / both halves +$104/+$95.",
      "✓ 3-window OOS PASS (3/3): 63% aggregate WR / +$171 / 12 trades/day across Feb-Mar 2026.",
      "Replaces 1h rdbull_fvg (2.7/day). 4× higher cadence at 12-13% higher WR.",
      "BUY-only filter critical: bidirectional version was 53% WR. Up-drift makes SELL breakouts counter-trend.",
      "kAtr=2.0 loose geometry creates loss-cap asymmetry (wins uncapped, losses capped at -100% stake) — high expR=+0.65 reflects this leverage interaction, not raw accuracy alone.",
    ],
  },
};

/**
 * BOOM 300N fade-FAST (1m, k=1, ULTRA-asymmetric SL/TP for high RR per win).
 *
 * Retuned 2026-05-07 — the prior 0.3/3.0 geometry produced $3-7 wins at
 * $104 stake (0.03-0.07R), too small. New geometry 0.2/10.0 catches BIG
 * down-drift waves: ~$60-70 per TP win at $104 stake, with most trades
 * taking $4-5 SL losses.
 *
 * 30-day verified sweep at Deriv-real fees (3% commission, MULT cap 100):
 *   sl=0.2, tp=10.0, hold≥60   → +$8.59/day at $1 stake
 *   trades 2134 (3 t/hr), WR 16.1%, R/win 49.3, R/loss -1.0
 *   84% SL hits (small loss), 16% TP hits (big win), 1% TIME exits
 *   max DD $2.20 at $1 stake
 *
 * Translates at $104 stake:
 *   per TP win   : ~$66-69
 *   per SL hit   : ~$4.50 + $3 commission = ~$7.50 loss
 *   expected/day : ~$66 × 350 wins/30d − $7.50 × 1788 losses/30d ≈ +$890/30d
 *                 = ~$30/day at $104 stake (matches +$8.59/day × ~3.5× scale)
 *
 * Geometry: enter SELL at bar i close after 1 up-close (consec=1).
 *   SL = entry + 0.2×ATR(14)  (very tight stop — most trades exit fast)
 *   TP = entry − 10.0×ATR(14) (very wide target — only deep down-drift waves)
 *
 * Per-strategy SL/TP override supported via FastSandboxConfig.perStrategy.
 */
export const boom300nFadeFast: StrategyDescriptor = {
  id: "boom300n_fade_fast",
  name: "BOOM 300N fade-FAST (1m, k=1, ultra-RR 0.2/10)",
  description:
    "1m drift fade on BOOM 300N. Enter SELL after a single up-close. " +
    "ULTRA-asymmetric: SL 0.2×ATR (small loss ~$5/$104), TP 10×ATR (big " +
    "win ~$66/$104). 16% WR — most trades small SL hits, occasional ones " +
    "catch big down-drift waves. ~3 trades/hour, +$30/day at $104 stake.",
  symbols: ["BOOM300N"],
  granularity: 60,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "driftPullback",
    params: d.id === "driftPullback"
      // emitStructural=0 → detector's equidistant kAtr levels are suppressed so
      // the engine falls back to atrSlMult/atrTpMult below (asymmetric RR).
      // The kAtr value still gates the signal trigger (single up-close fade).
      ? { driftDirection: -1, consec: 1, atrPeriod: 14, kAtr: 0.5, emitStructural: 0 }
      : d.params,
  })),
  atrSlMult: 0.2,
  atrTpMult: 10.0,
  costBps: 30.0,
  validation: {
    validatedAt: "2026-05-07",
    sampleDays: 30,
    trades: 2134,
    winRate: 0.161,
    expectancyR: 7.05,
    pnlUsd: 257.7,
    stake: 1,
    multiplier: 100,
    notes: [
      "Retuned 2026-05-07 from 0.3/3.0 → 0.2/10.0 to push R/win from ~3 to ~49.",
      "User feedback: prior config gave $3-7 wins at $104 stake; wanted $60-100/win range.",
      "Verified across 30d at Deriv-real 3% commission. WR 16% intentional — wide TP means few hit but each is big.",
      "+R per trade = +7.05 (asymmetric: -1R losses × 84% + +49R wins × 16% = +7.05R avg).",
      "Hold cap ≥60 bars for sim; live bot holds indefinitely until SL or TP hits.",
    ],
  },
};

// rdbullBreakout SUPERSEDED 2026-05-02 by fast2_rdbull_drift (same detector,
// kAtr=2.5 instead of 2.0, validated on 9 months at 60.9% WR). Removed from
// active list to prevent silent param collision on RDBULL@5m breakoutContinuation.
export const SYNTH_STRATEGIES: StrategyDescriptor[] = [boom300nDrift, boom300nFadeFast];

export function synthStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return SYNTH_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isSynthSymbol(symbol: string): boolean {
  return SYNTH_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

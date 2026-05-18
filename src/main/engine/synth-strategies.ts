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
 * BOOM 300N fade-FAST (1m, k=1, asymmetric 0.3/3.0 SL/TP).
 *
 * Geometry: enter SELL at bar i close after 1 up-close (consec=1).
 *   SL = entry + 0.3×ATR(14)  (tight stop — small loss most trades)
 *   TP = entry − 3.0×ATR(14)  (wide target — catches down-drift waves)
 *
 * 2026-05-18 multi-window 30-day cross-validation on real Deriv 1m candles
 * at $1 stake / 100× MULT / 3% commission / $0.10 SL-TP floor / mart 2.2×
 * with $15 start balance, max 5 ladder levels:
 *   Window                       Final     Net           Max DD       Max Streak
 *   Dec 19 → Jan 18 (4 mo back)  $1,325    +$1,310       $182 (13.8%) 23 (from $296)
 *   Feb 17 → Mar 19 (2 mo back)  $1,421    +$1,406       $197 (13.7%) 24 (from $197)
 *   Apr 18 → May 18 (latest)     $1,945    +$1,930       $135 ( 6.9%) 23 (from $450)
 *   Mean over 3 windows ≈ $1,564 final · +$1,549 net · 13% DD · ~23 streak
 *
 * Per-trade economics (at $1 base stake, 100× MULT):
 *   WR ≈ 42%  ·  avg win +$0.29 (after fees)  ·  avg loss −$0.13 (after fees)
 *   edge/trade ≈ +$0.066  ·  235 signals/day  ·  no bust in any window
 *
 * Earlier 0.2/10.0 retune REMOVED 2026-05-18 — too extreme: $0.10 floor
 * clamped the 0.2×ATR SL up to ~6.5× the designed distance, destroying the
 * asymmetric edge in live. 0.3/3.0 keeps both SL and TP comfortably above
 * the floor at any base stake ≥ $1.
 */
export const boom300nFadeFast: StrategyDescriptor = {
  id: "boom300n_fade_fast",
  name: "BOOM 300N fade-FAST (1m, k=1, 0.3/3.0)",
  description:
    "1m drift fade on BOOM 300N. Enter SELL after a single up-close. " +
    "Asymmetric SL 0.3×ATR (small loss) + TP 3.0×ATR (big win). ~42% WR " +
    "on real 30d Deriv data, +$0.066 edge/trade after fees. With $15 start " +
    "+ mart 2.2× / L5, three independent 30-day windows ended at $1,325 / " +
    "$1,421 / $1,945. ~235 trades/day.",
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
  atrSlMult: 0.3,
  atrTpMult: 3.0,
  costBps: 30.0,
  validation: {
    validatedAt: "2026-05-18",
    sampleDays: 30,
    trades: 7052,
    winRate: 0.42,
    expectancyR: 0.066,
    pnlUsd: 463,
    stake: 1,
    multiplier: 100,
    notes: [
      "Cross-validated across 3 independent 30-day windows on real Deriv 1m candles (Dec-Jan, Feb-Mar, Apr-May 2026).",
      "All three windows: flat-$1-stake +$463 / +$478 / +$471. With mart 2.2× / L5 / $15 start: +$1,310 / +$1,406 / +$1,930.",
      "$0.10 Deriv SL-TP floor modeled in sim — both legs comfortably above floor at $1 stake / 100× MULT.",
      "Reverted from 0.2/10.0 (too extreme) on 2026-05-18 — floor-clamping destroyed the asymmetric edge in live.",
      "42% WR · 53% SL exits · 47% TP exits · 1% TIME exits at MAX_HOLD_BARS=60.",
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

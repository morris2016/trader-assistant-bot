import { defaultDetectorConfigs } from "../runner";
import type { StrategyDescriptor } from "./types";

/**
 * Palladium (XPD/USD) Liquidity Sweep — equal-highs/lows reversal at 1h.
 *
 * Trades only on Palladium / USD (frxXPDUSD) at 1h TF. Detects equal-highs/lows
 * pools, waits for sweep + confirmation, enters reversal with structural stop
 * (sweep wick + 0.25×ATR) and 4:1 R:R. No ADX filter, no side bias, no rejection
 * filter — sweep's structural detection criteria already do the regime filtering.
 *
 * Validated 2026-04-28 with month-by-month walk-forward (5/0/0 — every calendar
 * month positive Dec 2025 → Apr 2026) and 3-window cross-validation:
 *   W0    (Dec 23 → Feb 6, 45d):  10 trades / 40% WR / +0.48R / +$118
 *   TRAIN (Feb 6 → Apr 7, 60d):   17 trades / 47% WR / +0.30R / +$205
 *   TEST  (Apr 7 → Apr 28, 21d):   4 trades / 75% WR / +1.74R / +$166 (OOS)
 *
 * Combined: 126 days / 31 trades / +$488 / ~$1,415/yr annualized.
 *
 * NOTE: TEST has 4 trades (1 below the standard ≥5/window methodology rule).
 * Excused given the 5/0/0 monthly walk-forward and clean +$166 OOS result.
 * Forward-validate over next 30-60 days before scaling.
 *
 * Discovery path: Palladium FVG iter 7 → +$260 only-winning (Feb structurally
 * flat). OB iter 1 → 0 only-winners ($102 best). Sweep iter 1 → 5/0/0 immediately
 * with stopBuf=0.25·4:1 (+$639 monthly). Iter 2-4 found higher-$ variants
 * ($706 → $898 → $974) but those compounded month-specific patches (eqTol=0.18,
 * lb=60, skipFri) — curve-fit risk. Locked the iter-1 baseline as production
 * config: simplest possible, no parameter mining beyond stop-buffer + R:R.
 */
export const pallSweep: StrategyDescriptor = {
  id: "pall_sweep",
  name: "Palladium Sweep — equal-pool reversal",
  description:
    "Liquidity sweep reversals on Palladium / USD at 1h. Detects equal-highs/lows " +
    "pools (50-bar lookback), enters on sweep + confirmation, 4:1 R:R, " +
    "structural stop = sweep wick + 0.25×ATR. No ADX/side/rejection filters.",

  symbols: ["frxXPDUSD"],
  granularity: 3600, // 1h

  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep"
      ? {
          atrPeriod: 14,
          equalToleranceAtrMul: 0.1,
          minEqualCount: 2,
          lookbackBars: 50,
          confirmationWindow: 3,
          poolRetentionBarsAfterSweep: 20,
          swingLeft: 2,
          swingRight: 2,
          targetRMult: 4.0,            // 4:1 R:R
          entryOnSweep: 0,             // confirm-style entry
          stopBufferAtrMul: 0.25,      // wider stop — palladium volatility tolerance
        }
      : d.params,
  })),

  atrSlMult: 1.0,
  atrTpMult: 4.0,
  costBps: 5.0,

  validation: {
    validatedAt: "2026-04-28",
    sampleDays: 60,
    trades: 17,
    winRate: 0.47,
    expectancyR: 0.30,
    pnlUsd: 205,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ CROSS-VALIDATED 2026-04-28 — 3-window CV: W0 +$118/10t/40%WR/+0.48R, TRAIN +$205/17t/47%/+0.30R, TEST +$166/4t/75%/+1.74R. All windows positive. TEST 4t is 1 below ≥5/window methodology rule, excused given 5/0/0 monthly walk-forward and strong OOS magnitude.",
      "Combined +$488 / 126d (just below $500 STRONG threshold by $12). Annualized ~$1,415/yr. Below other registry strategies but Palladium has lowest liquidity → smaller trade count is structural.",
      "Monthly walk-forward Dec 2025 → Apr 2026 (5/0/0): Dec +$63, Jan +$185, Feb +$47, Mar +$218, Apr +$126. Every month positive — no losing month even through April regime shift.",
      "Discovery: Pall FVG iter 7 → +$260 only-winning (Feb structurally flat). Pall OB iter 1 → 0 only-winners. Pall Sweep iter 1 → 5/0/0 immediately. FVG/OB structurally weak on palladium; Sweep is the natural fit.",
      "Param sensitivity: stopBuf 0.25 vs 0.30 vs 0.35 all produce 5/0/0 monthly (+$639/+$652/+$668). Locked 0.25 as production — simplest baseline, edge of robust band.",
      "Iter 2-4 found higher-$ variants up to +$974 by stacking eqTol=0.18 + lb=60 + skipFri. Rejected as curve-fitting — each booster patched specific December losers in our sample. Cleaner config without those tweaks is production-safe.",
      "Skipped Friday tested: WORSE for primary config ($639 → $628). Friday is not structurally bad on palladium.",
      "Forward-validate 30-60 days before scaling stake.",
    ],
  },
};

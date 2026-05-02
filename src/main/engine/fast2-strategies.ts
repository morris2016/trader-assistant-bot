// Fast2 sandbox — parallel to FAST_STRATEGIES, completely independent.
// 4-strategy R-stack:
//   RDBEAR mean-rev fade (5m, SELL on up-pierces)
//   RDBULL mean-rev fade (5m, BUY on down-pierces)
//   RDBEAR drift-follow  (5m, SELL on down-pierces)
//   RDBULL drift-follow  (5m, BUY on up-pierces)
// The mean-rev + drift pair on each Bear/Bull asset captures BOTH pierce
// directions — fade trades up-pierces, drift trades down-pierces (mirror for
// RDBULL). Doubles signal density per asset without conflict.
// 9-month validation totals at $3 stake:
//   RDBEAR fade  +$6,926  /  3,633t / 56% WR
//   RDBEAR drift +$9,204  /  5,112t / 56% WR
//   RDBULL fade  +$10,783 /  3,521t / 61% WR
//   RDBULL drift +$13,539 /  5,598t / 60% WR
//   Combined RDBEAR+RDBULL pair = +$40,452 over 9 months.
// Detector params shared with FAST.

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

const RDBULL_MEANREV_PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 4.0,             // TUNED 2026-05-02: was 2.5. Wider SL/TP captures full
                         // mean-reversion magnitude. 9-month: +$10,783 → +$21,365 (+98%).
                         // Feb 2026 stress: +$2,055 lift, every day still positive.
  momRatio: 0.7,
  sideFilter: 1,         // BUY-only — fade down-pierces (RDBULL's bull-drift)
  effWindow: 24,
  effChopThresh: 1.01,
  minAdx: 0,
};

// Drift-follow params (breakoutContinuation detector) — captures the OTHER
// pierce direction not used by the mean-rev fade strategies.
//   RDBEAR drift SELL: rides down-pierces of 15-bar low with bear-drift
//   RDBULL drift BUY:  rides up-pierces of 15-bar high with bull-drift
const RDBEAR_DRIFT_PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 2.5,
  momRatio: 0.7,
  sideFilter: -1,        // SELL-only on down-pierces (continuation in bear-drift)
};

const RDBULL_DRIFT_PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 2.5,
  momRatio: 0.7,
  sideFilter: 1,         // BUY-only on up-pierces (continuation in bull-drift)
};

const RDBEAR_MEANREV_PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 4.0,             // TUNED 2026-05-02: was 2.5. Wider SL/TP captures full
                         // mean-reversion magnitude. 9-month: +$6,926 → +$15,048 (+117%).
                         // Feb 2026 stress: every day still positive, lift consistent.
  momRatio: 0.7,
  sideFilter: -1,        // SELL-only — fade up-pierces (RDBEAR's bear-drift makes
                         // BUY-fades catch falling knives)
  // REGIME FILTERS DISABLED 2026-05-02 after 152-day pattern study showed every
  // skip-rule HURT net P&L. NO-REGIME version: +$33,404 (89W/0L/63DD/0BUST,
  // 58.9% WR, 10.6 trades/day) vs FILTERED +$16,426 (97W/7L/48DD/0BUST). The
  // efficiency gate was filtering out winners more than losers.
  // (Note: minAdx is decorative in breakoutMeanRev — never applied. Only
  //  effChopThresh was an active gate. Setting > 1.0 disables it since the
  //  Kaufman efficiency ratio is bounded ≤ 1.0.)
  effWindow: 24,
  effChopThresh: 1.01,   // disabled (was 0.30)
  minAdx: 0,             // decorative — never applied
};

export const fast2RdbearMeanRev: StrategyDescriptor = {
  id: "fast2_rdbear_meanrev",
  name: "Fast2 RDBEAR breakout mean-reversion",
  description:
    "5m breakout mean-reversion on RDBEAR (Bear Market Index). Fades up-pierces " +
    "of the prior 15-bar high with SELL signals. NO regime filter (ADX/efficiency " +
    "gates were dropping winners). Equidistant SL/TP at 2.5×ATR.",
  symbols: ["RDBEAR"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? RDBEAR_MEANREV_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-02",
    sampleDays: 152,
    trades: 1610,
    winRate: 0.589,
    expectancyR: 0.36,
    pnlUsd: 33404,
    stake: 30,
    multiplier: 100,
    notes: [
      "152-day Dec 1 2025 → May 2 2026 daily survival study on $200 / $30 / 1.7× × 3L mart / 60% DD-pause.",
      "REGIME FILTERS REMOVED 2026-05-02: 152-day pattern study found every skip-rule HURT net P&L.",
      "  • baseline (filtered): +$16,425.73 (97W/7L/48DD/0BUST)",
      "  • no-regime (stripped): +$33,403.70 (89W/0L/63DD/0BUST, 58.9% WR, 10.6 trades/day)",
      "  • ALL skip-rules tested HURT: skip prevAdx>30 (-$9,524), skip prevDay=DD (-$5,466), skip eff>0.40 (-$3,877).",
      "SELL-only because RDBEAR has bear-side drift — BUY-fades catch falling knives.",
      "Strategy is fully autonomous: detector + 60% DD circuit-breaker, no regime gating needed.",
    ],
  },
};

export const fast2RdbullMeanRev: StrategyDescriptor = {
  id: "fast2_rdbull_meanrev",
  name: "Fast2 RDBULL breakout mean-reversion",
  description:
    "5m breakout mean-reversion on RDBULL (Bull Market Index). Mirror of " +
    "RDBEAR strategy: fades down-pierces of the prior 15-bar low with BUY. " +
    "RDBULL has bull-drift between down-pierces, so BUY-fades catch counter-" +
    "trend exhaustions. NO regime filter. Equidistant SL/TP at 2.5×ATR.",
  symbols: ["RDBULL"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? RDBULL_MEANREV_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-02",
    sampleDays: 225,
    trades: 3521,
    winRate: 0.609,
    expectancyR: 0.62,
    pnlUsd: 10783,
    stake: 3,
    multiplier: 100,
    notes: [
      "Validated 2026-05-02 across 9 months Sep 2025 → May 2026 on $3 flat stake.",
      "3521 trades · 60.9% WR · +$10,782.61 net · +$3.06/trade — STRONGEST mean-rev candidate.",
      "9/9 months positive ($550–$1,662 each). Beats RDBEAR by ~56% per-trade.",
      "Bull-drift makes down-pierces structural exhaustion events — high-quality fade signals.",
      "Detector params match RDBEAR but with sideFilter=+1 (BUY-only mirror).",
    ],
  },
};

export const fast2RdbearDrift: StrategyDescriptor = {
  id: "fast2_rdbear_drift",
  name: "Fast2 RDBEAR drift-follow (breakout continuation)",
  description:
    "5m breakout-continuation on RDBEAR. SELL on confirmed down-pierces of " +
    "the prior 15-bar low — rides the bear-drift continuation. Complementary " +
    "to fast2_rdbear_meanrev (which trades up-pierces with SELL). Together " +
    "they capture both pierce directions on the same asset.",
  symbols: ["RDBEAR"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation" ? RDBEAR_DRIFT_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-02",
    sampleDays: 225,
    trades: 5112,
    winRate: 0.56,
    expectancyR: 0.36,
    pnlUsd: 9204,
    stake: 3,
    multiplier: 100,
    notes: [
      "Validated 2026-05-02 across 9 months Sep 2025 → May 2026 on $3 flat stake.",
      "5112 trades · 56% WR · +$9,204 net · +$1.80/trade · 9/9 months positive.",
      "Captures down-pierces (50% of pierce signals) that mean-rev fade ignores.",
      "Bear-drift makes down-pierces a continuation pattern — ride the move with SELL.",
    ],
  },
};

export const fast2RdbullDrift: StrategyDescriptor = {
  id: "fast2_rdbull_drift",
  name: "Fast2 RDBULL drift-follow (breakout continuation)",
  description:
    "5m breakout-continuation on RDBULL. BUY on confirmed up-pierces of " +
    "the prior 15-bar high — rides the bull-drift continuation. Complementary " +
    "to fast2_rdbull_meanrev (which trades down-pierces with BUY).",
  symbols: ["RDBULL"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation" ? RDBULL_DRIFT_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-02",
    sampleDays: 225,
    trades: 5598,
    winRate: 0.60,
    expectancyR: 0.48,
    pnlUsd: 13539,
    stake: 3,
    multiplier: 100,
    notes: [
      "Validated 2026-05-02 across 9 months Sep 2025 → May 2026 on $3 flat stake.",
      "5598 trades · 60% WR · +$13,539 net · +$2.42/trade · 8/9 months positive.",
      "Captures up-pierces (the OTHER half of pierce signals not used by fade).",
      "Bull-drift makes up-pierces a continuation pattern — ride with BUY.",
    ],
  },
};

export const FAST2_STRATEGIES: StrategyDescriptor[] = [
  fast2RdbearMeanRev,
  fast2RdbullMeanRev,
  fast2RdbearDrift,
  fast2RdbullDrift,
];

export function fast2StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST2_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast2Symbol(symbol: string): boolean {
  return FAST2_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

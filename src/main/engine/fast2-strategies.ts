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

// ─────────────────────────────────────────────────────────────────────────────
// MULTIPLIER-CAPABLE PORT (added 2026-05-03)
// RDBEAR/RDBULL don't have MULTUP/MULTDOWN offered on Deriv — every fast2 LIVE
// placeTrade on those symbols returns OfferingsValidationError. The R-stack
// signal logic was ported to multiplier-capable synthetics validated through
// 3-window CV ($150 acct / $10 stake / 2.0× mart d=3) and continuous April:
//   $250 → $7,436 over April 2026 (2,875%) / 1,064 trades / 0 busts
// All 5 use the same 5m breakout pierce detector but on different symbols,
// each with proven directional bias.
// ─────────────────────────────────────────────────────────────────────────────
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

const BOOM300N_FADE_PARAMS = {
  lookback: 15, atrPeriod: 14, kAtr: FADE_KATR, momRatio: 0.7,
  sideFilter: -1,        // SELL-only on up-pierces (BOOM has up-drift bias on calm bars)
  effWindow: 24, effChopThresh: 1.01, minAdx: 0,
};

const JD75_FADE_UP_PARAMS = {
  lookback: 15, atrPeriod: 14, kAtr: FADE_KATR, momRatio: 0.7,
  sideFilter: -1,        // SELL-only on up-pierces
  effWindow: 24, effChopThresh: 1.01, minAdx: 0,
};

const JD75_FADE_DOWN_PARAMS = {
  lookback: 15, atrPeriod: 14, kAtr: FADE_KATR, momRatio: 0.7,
  sideFilter: 1,         // BUY-only on down-pierces
  effWindow: 24, effChopThresh: 1.01, minAdx: 0,
};

const CRASH300N_FADE_PARAMS = {
  lookback: 15, atrPeriod: 14, kAtr: FADE_KATR, momRatio: 0.7,
  sideFilter: 1,         // BUY-only on down-pierces (CRASH has down-drift on calm bars)
  effWindow: 24, effChopThresh: 1.01, minAdx: 0,
};

const BOOM300N_DRIFT_DOWN_PARAMS = {
  lookback: 15, atrPeriod: 14, kAtr: DRIFT_KATR, momRatio: 0.7,
  sideFilter: -1,        // SELL-only on down-pierces (continuation in bear-correction phase)
};

export const fast2Boom300nFadeUp: StrategyDescriptor = {
  id: "fast2_boom300n_fade_up",
  name: "Fast2 BOOM300N fade up-pierce",
  description:
    "5m breakout mean-reversion on BOOM300N. SELL on up-pierces of the prior " +
    "15-bar high. BOOM300N has an asymmetric structure (frequent small drifts, " +
    "rare large up-spikes); fading routine up-pierces during drift phases " +
    "captures the mean-reversion edge. Equidistant SL/TP at 4.0×ATR.",
  symbols: ["BOOM300N"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? BOOM300N_FADE_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-03",
    sampleDays: 60,
    trades: 356,
    winRate: 0.528,
    expectancyR: 0.05,
    pnlUsd: 974,
    stake: 10,
    multiplier: 100,
    notes: [
      "Validated 2026-05-03 — 60d / 3-window CV all positive at $150/$10/2.0×/d=2.",
      "Continuous April 2026: 181t / 49.7% WR / +$1,601 / 0 bust on $250 acct.",
      "Strongest single-strategy contributor to combined 5-strat book ($7,436 final).",
      "Live-tradable on Deriv (MULTUP/MULTDOWN ★ confirmed via contracts_for).",
    ],
  },
};

export const fast2Jd75FadeUp: StrategyDescriptor = {
  id: "fast2_jd75_fade_up",
  name: "Fast2 JD75 fade up-pierce",
  description:
    "5m breakout mean-reversion on JD75 (Jump 75 Index). SELL on up-pierces. " +
    "Jump indices have symmetric random walks with periodic jumps; pierces are " +
    "exhaustion events that mean-revert. Equidistant SL/TP at 4.0×ATR.",
  symbols: ["JD75"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? JD75_FADE_UP_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-03",
    sampleDays: 60,
    trades: 326,
    winRate: 0.506,
    expectancyR: 0.01,
    pnlUsd: 799,
    stake: 10,
    multiplier: 100,
    notes: [
      "Validated 2026-05-03 — 60d / 3-window CV all positive at $150/$10/2.0×/d=2.",
      "Continuous April 2026: 154t / 45.5% WR / +$1,062 / 0 bust on $250 acct.",
      "Live-tradable on Deriv (MULTUP/MULTDOWN ★ confirmed via contracts_for).",
    ],
  },
};

export const fast2Jd75FadeDown: StrategyDescriptor = {
  id: "fast2_jd75_fade_down",
  name: "Fast2 JD75 fade down-pierce",
  description:
    "5m breakout mean-reversion on JD75 (Jump 75 Index). BUY on down-pierces of " +
    "the prior 15-bar low. Mirror of fast2_jd75_fade_up — together they capture " +
    "both pierce directions. Equidistant SL/TP at 4.0×ATR.",
  symbols: ["JD75"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? JD75_FADE_DOWN_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-03",
    sampleDays: 60,
    trades: 328,
    winRate: 0.491,
    expectancyR: 0.0,
    pnlUsd: 701,
    stake: 10,
    multiplier: 100,
    notes: [
      "Validated 2026-05-03 — 60d / 3-window CV all positive at $150/$10/2.0×/d=2.",
      "Continuous April 2026: 157t / 50.3% WR / +$1,423 / 0 bust on $250 acct.",
      "Live-tradable on Deriv (MULTUP/MULTDOWN ★ confirmed via contracts_for).",
    ],
  },
};

export const fast2Crash300nFadeDown: StrategyDescriptor = {
  id: "fast2_crash300n_fade_down",
  name: "Fast2 CRASH300N fade down-pierce",
  description:
    "5m breakout mean-reversion on CRASH300N. BUY on down-pierces of the prior " +
    "15-bar low. CRASH300N has down-drift on calm bars and rare large down-spikes; " +
    "fading routine down-pierces captures mean-reversion. Equidistant SL/TP at 4.0×ATR.",
  symbols: ["CRASH300N"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutMeanRev",
    params: d.id === "breakoutMeanRev" ? CRASH300N_FADE_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-03",
    sampleDays: 60,
    trades: 355,
    winRate: 0.499,
    expectancyR: -0.0,
    pnlUsd: 1343,
    stake: 10,
    multiplier: 100,
    notes: [
      "Validated 2026-05-03 — 60d / 3-window CV all positive at $150/$10/2.0×/d=2.",
      "Continuous April 2026: 175t / 49.7% WR / +$2,282 / 0 bust on $250 acct (BEST single-strat).",
      "Live-tradable on Deriv (MULTUP/MULTDOWN ★ confirmed via contracts_for).",
    ],
  },
};

export const fast2Boom300nDriftDown: StrategyDescriptor = {
  id: "fast2_boom300n_drift_down",
  name: "Fast2 BOOM300N drift-follow on down-pierces",
  description:
    "5m breakout-continuation on BOOM300N. SELL on down-pierces of the prior " +
    "15-bar low — rides the bear-correction phase between BOOM up-spikes. " +
    "Highest signal density (~38 trades/day). SL/TP at 2.5×ATR.",
  symbols: ["BOOM300N"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation" ? BOOM300N_DRIFT_DOWN_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-05-03",
    sampleDays: 60,
    trades: 808,
    winRate: 0.564,
    expectancyR: 0.13,
    pnlUsd: 444,
    stake: 10,
    multiplier: 100,
    notes: [
      "Validated 2026-05-03 — 60d / 3-window CV all positive at $150/$10/2.0×/d=2.",
      "Continuous April 2026: 397t / 59.2% WR / +$818 / 0 bust on $250 acct.",
      "Highest signal density of the book — drives win-rate stability.",
      "Live-tradable on Deriv (MULTUP/MULTDOWN ★ confirmed via contracts_for).",
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FAST2 REPURPOSED 2026-05-04 → DIGITOVER 0 tick-level book on R_*
//
// Original multiplier R-stack and RDBEAR/RDBULL strategies are kept in this
// file (above) but excluded from the active registry. Fast2 now hosts 3
// tick-level DIGITOVER 0 strategies: betting that the next tick's last
// digit is > 0. R_10/R_25/R_50/R_75 produce digit 0 ~0% (R_*) due to
// quote-precision artifact; Deriv prices the contract as if 0 has 10%
// frequency (1.09× payout) → ~9% mispricing on essentially-guaranteed wins.
//
// Last-hour live measurement (2026-05-04 06:38-07:38 UTC):
//   R_25  1790/1790  100.00% WR  +$161.10/hr  $0 max DD
//   R_50  1790/1790  100.00% WR  +$161.10/hr  $0 max DD
//   R_75  1790/1790  100.00% WR  +$161.10/hr  $0 max DD
//
// Strategy descriptors below carry granularity=0 to mark them as
// tick-level. The bot's fast3 tick handler also dispatches granularity=0
// strategies from FAST2_STRATEGIES tagged sandbox="fast2", with
// contractType=DIGITOVER barrier=0 (parsed from the strategy id suffix
// "_digitover0").
// ─────────────────────────────────────────────────────────────────────────────
const TICK_DIGITOVER0_DETECTOR = "digitOver0";

function makeDigitOver0Strat(symbol: string, validatedWR: number): StrategyDescriptor {
  return {
    id: `fast2_${symbol.toLowerCase().replace(/[^a-z0-9]/g, "_")}_digitover0`,
    name: `Fast2 ${symbol} DIGITOVER 0`,
    description:
      `Tick-level DIGITOVER 0 bet on ${symbol}. Each tick = predict next ` +
      `tick's last digit > 0. Synthetic RNG quote precision essentially ` +
      `never produces digit 0 on R_* family → ~99.9%+ structural WR. ` +
      `Deriv pays 1.09× → ~9% per-tick edge. Configured for 2.2× Paroli.`,
    symbols: [symbol],
    granularity: 0,
    detectors: defaultDetectorConfigs().map((d) => ({ ...d, enabled: false })),
    atrSlMult: 0,
    atrTpMult: 0,
    costBps: 0,
    useMartingale: true,
    validation: {
      validatedAt: "2026-05-04",
      sampleDays: 1,
      trades: -1,
      winRate: validatedWR,
      expectancyR: 0,
      pnlUsd: 0,
      stake: 1,
      multiplier: 1,
      notes: [
        `DIGITOVER barrier=0 on ${symbol}. Win = next tick digit ∈ {1..9}.`,
        `Last-hour live measurement (2026-05-04): ${(validatedWR * 100).toFixed(2)}% WR.`,
        `Edge: structural — R_* family quotes never end in 0 at displayed precision.`,
        `Tick-level strategy: granularity=0, dispatched by fast3 tick handler with sandbox=fast2 tag.`,
        `Paired with 2.2× Paroli (escalate on wins) so a streak of high-WR wins compounds.`,
      ],
    },
  };
}

export const fast2R25DigitOver0 = makeDigitOver0Strat("R_25", 1.0000);
export const fast2R50DigitOver0 = makeDigitOver0Strat("R_50", 1.0000);
export const fast2R75DigitOver0 = makeDigitOver0Strat("R_75", 1.0000);

// FAST2 SANDBOX REMOVED 2026-05-04 — user requested cleanup. The DIGITOVER 0
// experiment showed no real edge (precision-audit revealed JS trailing-zero
// bug inflated apparent P(odd)). Only fast3 (DIGITODD tick book) and the
// real-account candle book (silver/gold/plat) remain active. Re-enable
// any strategy by uncommenting below.
export const FAST2_STRATEGIES: StrategyDescriptor[] = [
  // fast2R25DigitOver0, fast2R50DigitOver0, fast2R75DigitOver0,
  // fast2RdbearMeanRev, fast2RdbullMeanRev, fast2RdbearDrift, fast2RdbullDrift,
  // fast2Boom300nFadeUp, fast2Jd75FadeUp, fast2Jd75FadeDown,
  // fast2Crash300nFadeDown, fast2Boom300nDriftDown,
];

export const FAST2_DIGITOVER0_DETECTOR_TAG = TICK_DIGITOVER0_DETECTOR;

export function fast2StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST2_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast2Symbol(symbol: string): boolean {
  return FAST2_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

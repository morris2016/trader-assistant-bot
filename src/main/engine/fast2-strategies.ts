// Fast2 sandbox — parallel to FAST_STRATEGIES, completely independent.
// Stack: BOOM 300N spike-fade (1m) + RDBEAR breakout-mean-reversion (5m).
// CRASH 300N spike-fade was removed 2026-05-02 in favor of the validated
// RDBEAR mean-rev strategy (120-day Jan→Apr study: 69% daily survival,
// 0% bust, +$12,654 net on $200/$30/1.7×).
// Detector params are shared with FAST_STRATEGIES on (sym, gr=60) so the
// per-key engine merge in bot/index.ts does not collide.

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

const SPIKE_FADE_PARAMS = {
  atrPeriod: 14,
  spikeNAtr: 3.0,
  bufferAtrMul: 0.2,
  tpFracOfSpike: 0.5,
  requireConfirmation: 1,
};

const RDBEAR_MEANREV_PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 2.5,
  momRatio: 0.7,
  sideFilter: -1,        // SELL-only — fade up-pierces (RDBEAR's bear-drift makes
                         // BUY-fades catch falling knives)
  effWindow: 24,         // efficiency-ratio lookback
  effChopThresh: 0.30,   // skip if eff >= this (i.e. trending)
  minAdx: 22,
};

export const fast2Boom300nSpike: StrategyDescriptor = {
  id: "fast2_boom300n_spike",
  name: "Fast2 BOOM 300N spike-fade",
  description:
    "1m spike-fade on BOOM 300N. Martingale-on. After a 3×ATR up-spike, sells " +
    "with structural SL just past spike high and TP at 50% of the spike range.",
  symbols: ["BOOM300N"],
  granularity: 60,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "spikeFade",
    params: d.id === "spikeFade" ? SPIKE_FADE_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-04-30",
    sampleDays: 28,
    trades: 0,
    winRate: 0.56,
    expectancyR: 0.36,
    pnlUsd: 0,
    stake: 1.5,
    multiplier: 300,
    notes: [
      "Validated as part of the Fast2 spike-fade stack on Feb 1-28 + Mar 15-22 + Apr 14-21 + Apr 23-29 windows.",
      "CRASH 300N spike-fade removed 2026-05-02 — replaced by fast2_rdbear_meanrev.",
      "Martingale multiplier and trade leverage are runtime-configurable via Fast2Config.",
    ],
  },
};

export const fast2RdbearMeanRev: StrategyDescriptor = {
  id: "fast2_rdbear_meanrev",
  name: "Fast2 RDBEAR breakout mean-reversion",
  description:
    "5m breakout mean-reversion on RDBEAR (Bear Market Index). Fades up-pierces " +
    "of the prior 15-bar high with SELL signals. Gated by Kaufman efficiency " +
    "ratio < 0.30 (only fires in chop) + minADX 22. Equidistant SL/TP at 2.5×ATR.",
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
    sampleDays: 120,
    trades: 688,
    winRate: 0.573,
    expectancyR: 0.18,
    pnlUsd: 12654,
    stake: 30,
    multiplier: 100,
    notes: [
      "120-day Jan 1 → Apr 30 2026 daily survival study on $200 acct / $30 stake / 1.7× × 3L mart / 60% DD-pause.",
      "Daily outcomes: 83/120 survived (69.2%), 37/120 DD-paused (30.8%), 0 busts.",
      "688 trades · 394W/294L · 57.3% WR · +$12,654 net · avg +$105/day.",
      "SELL-only because RDBEAR has bear-side drift — BUY-fades catch falling knives (Apr 27 clusters cost -$167 each).",
      "Replaces fast2_crash300n_spike in the Fast2 stack (2026-05-02).",
    ],
  },
};

export const FAST2_STRATEGIES: StrategyDescriptor[] = [
  fast2Boom300nSpike,
  fast2RdbearMeanRev,
];

export function fast2StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST2_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast2Symbol(symbol: string): boolean {
  return FAST2_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

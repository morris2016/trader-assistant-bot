// Fast2 sandbox — parallel to FAST_STRATEGIES, completely independent.
// Runs the validated 3-strategy stack (spike-fade BOOM/CRASH 300N at 1m +
// drift-pullback CRASH300N 5m) with user-configurable trade leverage and
// martingale multiplier supplied at runtime via Fast2Config (see storage).
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

const DRIFT_PULLBACK_CRASH_PARAMS = {
  driftDirection: 1, // CRASH = up-drift
  consec: 3,
  atrPeriod: 14,
  kAtr: 1.0,
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
      "Validated as part of the 3-strategy Fast2 stack on Feb 1-28 + Mar 15-22 + Apr 14-21 + Apr 23-29 windows.",
      "Used together with crash300n_spike (1m) and crash300n_drift (5m) in a shared $50 paper account.",
      "Martingale multiplier and trade leverage are runtime-configurable via Fast2Config.",
      "C-7 (200×, 2.0× mart) +1575% / 28d at $50; B-1.7 (100×, 1.7× mart) +562% / 28d at $50.",
    ],
  },
};

export const fast2Crash300nSpike: StrategyDescriptor = {
  id: "fast2_crash300n_spike",
  name: "Fast2 CRASH 300N spike-fade",
  description:
    "Mirror of fast2_boom300n_spike on CRASH 300N — buys after a confirmed " +
    "down-spike. Structural SL past spike low, TP at 50% of spike range.",
  symbols: ["CRASH300N"],
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
    expectancyR: 0.39,
    pnlUsd: 0,
    stake: 1.5,
    multiplier: 300,
    notes: [
      "Slightly higher edge than the BOOM mirror (+0.39R vs +0.36R) — Crash up-drift reinforces post-spike recovery.",
      "Part of the 3-strategy Fast2 stack — see fast2_boom300n_spike notes.",
    ],
  },
};

export const fast2Crash300nDrift: StrategyDescriptor = {
  id: "fast2_crash300n_drift",
  name: "Fast2 CRASH 300N drift-pullback",
  description:
    "5m drift-pullback on CRASH 300N. After 3 consecutive against-drift " +
    "(down) closes, BUY back into up-drift with equidistant SL/TP at 1×ATR. " +
    "R:R = 1:1 — designed for martingale (60% WR + 1:1 RR keeps cycle EV positive).",
  symbols: ["CRASH300N"],
  granularity: 300,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "driftPullback",
    params: d.id === "driftPullback" ? DRIFT_PULLBACK_CRASH_PARAMS : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  useMartingale: true,
  validation: {
    validatedAt: "2026-04-30",
    sampleDays: 31.2,
    trades: 454,
    winRate: 0.59,
    expectancyR: 0.18,
    pnlUsd: 0,
    stake: 1.5,
    multiplier: 300,
    notes: [
      "Standalone validation: 454 trades / 31.2d, WR 59%, R:R 1.00, bust prob 1.19%, cycle EV +$0.24.",
      "Stable across both halves of the window. The high-WR + 1:1 RR is the engine of the Fast2 stack.",
      "Part of the 3-strategy Fast2 stack — see fast2_boom300n_spike notes.",
    ],
  },
};

export const FAST2_STRATEGIES: StrategyDescriptor[] = [
  fast2Boom300nSpike,
  fast2Crash300nSpike,
  fast2Crash300nDrift,
];

export function fast2StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST2_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast2Symbol(symbol: string): boolean {
  return FAST2_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

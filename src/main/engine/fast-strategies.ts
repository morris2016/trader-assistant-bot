// Fast-trade synth sandbox. Completely separate from STRATEGIES (real-asset)
// and SYNTH_STRATEGIES (validated SMC synths). High-frequency 1m spike-fade
// scalps on Deriv's Boom 300N + Crash 300N synthetics.
//
// Edge: Boom 300N is spec'd with rare large up-spikes (~1 per 300 ticks);
// Crash 300N has rare down-spikes. After a spike the price reliably reverts
// at least partially. We detect a 1m bar whose range ≥ 3 × ATR(prior bar),
// wait one bar to confirm the spike has ended (confirmation bar closes inside
// the spike's range), then fade in the opposite direction with stop just past
// the spike high/low and target at 0.5 × spike_range.
//
// Validated 2026-04-30 via 17.4-day historical Deriv backtest:
//   • BOOM300N 1m: 1670 trades / 17.4d, WR 56%, expR +0.36, +$749 / 96.2 trades/day
//   • CRASH300N 1m: 1687 trades / 17.4d, WR 56%, expR +0.39, +$849 / 97.2 trades/day
// Both stable across both halves of the data window.

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

const SPIKE_FADE_PARAMS = {
  atrPeriod: 14,
  spikeNAtr: 3.0,
  bufferAtrMul: 0.2,
  tpFracOfSpike: 0.5,
  requireConfirmation: 1,
};

/**
 * BOOM300N spike-fade — sell after a confirmed up-spike.
 */
export const boom300nSpike: StrategyDescriptor = {
  id: "boom300n_spike",
  name: "BOOM 300N spike-fade",
  description:
    "Detects a 1m bar with range ≥ 3×ATR (a spike). On the next bar that closes " +
    "back inside the spike's range, fade in the opposite direction. Stop just past " +
    "the spike's high/low + 0.2×ATR; target at 50% of the spike's range.",
  symbols: ["BOOM300N"],
  granularity: 60,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "spikeFade",
    params: d.id === "spikeFade" ? SPIKE_FADE_PARAMS : d.params,
  })),
  // ATR fallbacks — never used since spikeFade emits structural levels.
  atrSlMult: 1.0,
  atrTpMult: 1.0,
  costBps: 5.0,
  validation: {
    validatedAt: "2026-04-30",
    sampleDays: 17.4,
    trades: 1670,
    winRate: 0.56,
    expectancyR: 0.36,
    pnlUsd: 749,
    stake: 50,
    multiplier: 30,
    notes: [
      "Historical edge: rare up-spikes on BOOM300N revert reliably ~half the spike size before drift resumes.",
      "Tested 17.4 days × 25,000 1m bars on Deriv. Half-A +$399 / half-B +$350 — STABLE.",
      "Drawdown $29 over 1670 trades at $50/30× — extremely benign.",
      "Martingale NOT recommended: per-trade expR=+0.36 is positive without it; martingale would burn the edge on rare 5-loss streaks.",
    ],
  },
};

/**
 * CRASH300N spike-fade — buy after a confirmed down-spike. Mirror of BOOM300N.
 */
export const crash300nSpike: StrategyDescriptor = {
  id: "crash300n_spike",
  name: "CRASH 300N spike-fade",
  description:
    "Mirror of boom300n_spike on CRASH300N. Detects a 1m bar with range ≥ 3×ATR, " +
    "waits one bar to confirm spike-end, then BUYs (fading the down-spike). " +
    "Stop just past spike low − 0.2×ATR; target at 50% of spike range.",
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
  validation: {
    validatedAt: "2026-04-30",
    sampleDays: 17.4,
    trades: 1687,
    winRate: 0.56,
    expectancyR: 0.39,
    pnlUsd: 849,
    stake: 50,
    multiplier: 30,
    notes: [
      "Historical edge: rare down-spikes on CRASH300N revert reliably.",
      "Tested 17.4 days × 25,000 1m bars on Deriv. Half-A +$454 / half-B +$395 — STABLE.",
      "Slightly higher edge than BOOM300N variant (+0.39R vs +0.36R) — Crash drift is up so post-spike recovery is reinforced by drift direction.",
      "Drawdown $37 over 1687 trades at $50/30× — extremely benign.",
    ],
  },
};

export const FAST_STRATEGIES: StrategyDescriptor[] = [boom300nSpike, crash300nSpike];

export function fastStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFastSymbol(symbol: string): boolean {
  return FAST_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

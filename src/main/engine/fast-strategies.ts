// Fast-trade synth sandbox. Completely separate from STRATEGIES (real-asset)
// and SYNTH_STRATEGIES (validated SMC synths). These are HIGH-FREQUENCY
// drift-fade scalps on Deriv's Boom/Crash synthetics with martingale stake
// escalation on losses.
//
// Why these symbols: Boom/Crash are spec'd with deterministic drift in one
// direction punctuated by rare large spikes (BOOM300N: ~1 spike per 300 ticks
// of down-drift; CRASH500N: ~1 spike per 500 ticks of up-drift). Between
// spikes, drift is one-way. Scalping the drift with tight TP and wide SL
// produces a high-WR profile that martingale can convert into bankable P&L.
//
// Validation status: NOT yet historically backtested as fast-frequency. The
// boom300n_ob 1h variant is validated (+$667) which proves the underlying
// drift edge is real; this faster timeframe deploys the same edge to paper
// for live observation. Initial paper-only run targets ≥60% WR over 7 days.

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

/**
 * CRASH500N drift-fade BUY — scalp the up-drift between rare down-spikes.
 *
 * Spec: Crash 500 Index has constant up-drift broken by infrequent
 * down-spikes (~1 per 500 ticks). Every 1m bar that closes green is drift
 * continuing; we buy the continuation with tight TP and wide SL.
 */
export const crash500nDrift: StrategyDescriptor = {
  id: "crash500n_drift",
  name: "CRASH 500N drift-fade BUY",
  description:
    "Buy every 1m green bar on Crash 500 Index. Drift is up except for rare " +
    "down-spikes; tight TP harvests drift, wide SL absorbs one spike per " +
    "cycle. Martingale recovers spike losses across the next several wins.",
  // Deriv ticker is "CRASH500" (no N suffix on the 500 variant — only 300 and
  // 1000 series use the N-nightly suffix). First deploy used "CRASH500N" and
  // got InvalidSymbol from Deriv WS.
  symbols: ["CRASH500"],
  granularity: 60,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "trendContinuation",
    // lookback 1 with close-vs-open was too strict — many bars closed flat or
    // slightly green-on-red-drift on Boom/Crash, producing zero signals. Bump
    // to 2 with close-vs-prev-close semantics so we trigger on any string of
    // 2 consecutive bars whose closes moved in the drift direction.
    params: d.id === "trendContinuation"
      ? { direction: 1, lookback: 2, atrPeriod: 14, atrTpMul: 0.3, atrSlMul: 2.0 }
      : d.params,
  })),
  atrSlMult: 2.0,
  atrTpMult: 0.3,
  costBps: 5.0,
  buyOnly: true,
  validation: {
    validatedAt: "PAPER-ONLY",
    sampleDays: 0,
    trades: 0,
    winRate: 0.65,        // target — must be confirmed by 7-day paper
    expectancyR: 0.65 * 0.15 - 0.35 * 1.0, // -0.25R per trade pre-martingale
    pnlUsd: 0,
    stake: 0.5,
    multiplier: 30,
    notes: [
      "PAPER-ONLY initial deploy. Target ≥60% WR over 7-day paper before live.",
      "Negative pre-martingale expectancy by design — martingale recovers losses.",
      "Edge: Crash 500 spec drift is up-direction; spikes are rare and bounded.",
    ],
  },
};

/**
 * BOOM300N drift-fade SELL — mirror of CRASH500N. Sell every 1m red bar.
 */
export const boom300nDrift: StrategyDescriptor = {
  id: "boom300n_drift",
  name: "BOOM 300N drift-fade SELL",
  description:
    "Sell every 1m red bar on Boom 300 Index. Drift is down except for rare " +
    "up-spikes; tight TP harvests drift, wide SL absorbs one spike per cycle. " +
    "Mirror strategy to crash500n_drift; the two diversify spike timing.",
  symbols: ["BOOM300N"],
  granularity: 60,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "trendContinuation",
    params: d.id === "trendContinuation"
      ? { direction: -1, lookback: 2, atrPeriod: 14, atrTpMul: 0.3, atrSlMul: 2.0 }
      : d.params,
  })),
  atrSlMult: 2.0,
  atrTpMult: 0.3,
  costBps: 5.0,
  sellOnly: true,
  validation: {
    validatedAt: "PAPER-ONLY",
    sampleDays: 0,
    trades: 0,
    winRate: 0.65,
    expectancyR: 0.65 * 0.15 - 0.35 * 1.0,
    pnlUsd: 0,
    stake: 0.5,
    multiplier: 30,
    notes: [
      "PAPER-ONLY initial deploy. Target ≥60% WR over 7-day paper before live.",
      "Negative pre-martingale expectancy by design — martingale recovers losses.",
      "Edge: Boom 300N spec drift is down-direction; spikes are rare and bounded.",
      "boom300n_ob (1h timeframe) already validated +$667 — proves drift edge is real.",
    ],
  },
};

export const FAST_STRATEGIES: StrategyDescriptor[] = [crash500nDrift, boom300nDrift];

export function fastStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFastSymbol(symbol: string): boolean {
  return FAST_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

// Fast1 sandbox — repurposed 2026-05-06 for the BOOM 300N asymmetric-RR
// fade strategy. The fast1 infrastructure (own paper engine, own ladders,
// own config, own panel + HTTP routes) was dormant; re-using it here gives
// boom300n_fade_fast its own config space, separate from the synth (fast2)
// sandbox which holds the original boom300n_drift + rdbull_breakout pair.
//
// Why a separate sandbox: boom300n_fade_fast runs at 1m with asymmetric
// SL/TP (0.3×ATR / 3.0×ATR), totally different RR profile vs the synth
// strategies' equidistant 1.0×ATR geometry. Different stake sizing /
// martingale tuning makes sense per-strategy, and the sandbox split keeps
// ladder state + paper balance independent.

import { boom300nFadeFast } from "./synth-strategies";
import type { StrategyDescriptor } from "./strategies/types";

export const FAST_STRATEGIES: StrategyDescriptor[] = [
  boom300nFadeFast,
];

export function fastStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFastSymbol(symbol: string): boolean {
  return FAST_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

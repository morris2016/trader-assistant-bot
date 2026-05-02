// Fast1 sandbox — PAPER-ONLY shadow of Fast2.
// Runs the same R-stack (RDBEAR + RDBULL × fade + drift) but in paper mode
// so we can compare paper-vs-live performance side by side. Useful for
// detecting live-execution drag (slippage, latency, fill quality).
//
// Replaced 2026-05-02 — old BOOM/CRASH 300N spike-fade descriptors deleted
// (those strategies migrated to Fast2 in earlier session, then removed entirely
// when user opted to focus on R-stack only).
//
// Each strategy is a clone of its Fast2 sibling with a "fast1_" id prefix so
// the dispatch router and per-strategy ladder/balance state stay distinct.

import {
  fast2RdbearMeanRev,
  fast2RdbullMeanRev,
  fast2RdbearDrift,
  fast2RdbullDrift,
} from "./fast2-strategies";
import type { StrategyDescriptor } from "./strategies/types";

export const fast1RdbearMeanRev: StrategyDescriptor = {
  ...fast2RdbearMeanRev,
  id: "fast1_rdbear_meanrev",
  name: "Fast1 RDBEAR mean-rev fade (paper shadow)",
  description:
    "Paper-only shadow of fast2_rdbear_meanrev. Identical detector params; runs " +
    "in the Fast1 sandbox for paper-vs-live comparison.",
};

export const fast1RdbullMeanRev: StrategyDescriptor = {
  ...fast2RdbullMeanRev,
  id: "fast1_rdbull_meanrev",
  name: "Fast1 RDBULL mean-rev fade (paper shadow)",
  description: "Paper-only shadow of fast2_rdbull_meanrev.",
};

export const fast1RdbearDrift: StrategyDescriptor = {
  ...fast2RdbearDrift,
  id: "fast1_rdbear_drift",
  name: "Fast1 RDBEAR drift-follow (paper shadow)",
  description: "Paper-only shadow of fast2_rdbear_drift.",
};

export const fast1RdbullDrift: StrategyDescriptor = {
  ...fast2RdbullDrift,
  id: "fast1_rdbull_drift",
  name: "Fast1 RDBULL drift-follow (paper shadow)",
  description: "Paper-only shadow of fast2_rdbull_drift.",
};

export const FAST_STRATEGIES: StrategyDescriptor[] = [
  fast1RdbearMeanRev,
  fast1RdbullMeanRev,
  fast1RdbearDrift,
  fast1RdbullDrift,
];

export function fastStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFastSymbol(symbol: string): boolean {
  return FAST_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

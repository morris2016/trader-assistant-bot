// Fast3 — DIGIT-family tick-level book on Deriv synthetic indices.
//
// EXPANDED 2026-05-04 — was DIGITODD-only, now generates strategies for the
// full DIGIT contract family across all the tick-streaming synthetics. The
// idea: ship the universe in paper mode and let the operator prune the
// underperformers from the UI's per-strategy enable toggle.
//
// Per tick, for each enabled strategy, the bot dispatches one DIGIT contract:
//   DIGITODD  — wins if the next tick's last digit is odd  (~1.95×)
//   DIGITEVEN — wins if the next tick's last digit is even (~1.95×)
//   DIGITOVER 0 — wins if next digit > 0 (any nonzero, ~1.10×)
//   DIGITUNDER 9 — wins if next digit < 9 (~1.10×)
// The structural edge story for DIGITODD on synthetics ("no digit 0 → P(odd)
// = 5/9") was found to be wrong on 2026-05-04 once the trailing-zero parser
// bug in fast3LastDigitFor was fixed (paper had been overestimating odds by
// 5-9pp). The expanded registry treats every (symbol, contract-type) pair as
// a candidate to be empirically validated rather than presumed.
//
// granularity=0 marks these as tick-level — they don't run through the
// candle/detector pipeline. The bot's tick handler dispatches per-strategy
// based on `digitContractType` + `digitBarrier`.

import type { StrategyDescriptor } from "./strategies/types";
import { defaultDetectorConfigs } from "./runner";

// All Fast3 strategies share the "digitOdd" detector tag so the existing
// signal/strategy bookkeeping has something to key on. Actual win logic is
// in the bot tick dispatcher (per-strategy contractType + barrier).
const TICK_DIGIT_DETECTOR = "digitOdd";

// Symbols that have tick-level streams suitable for DIGIT contracts. Ordered
// loosely by validated 2026-05-03 DIGITODD performance — the operator can
// re-prioritise via per-strategy enable toggle.
const FAST3_TICK_SYMBOLS = [
  "1HZ100V",
  "1HZ75V",
  "1HZ50V",
  "1HZ25V",
  "1HZ10V",
  "R_100",
  "R_75",
  "R_50",
  "R_25",
  "R_10",
  "JD100",
  "JD75",
  "JD50",
  "JD25",
  "JD10",
  "RDBULL",
  "RDBEAR",
];

// (contractType, barrier?) variants generated for every symbol. Keep the
// universe small enough that the per-strategy enable UI stays scannable.
type DigitVariant = {
  type: "DIGITODD" | "DIGITEVEN" | "DIGITOVER" | "DIGITUNDER";
  barrier?: number;
  suffix: string;
  shortLabel: string;
  longLabel: string;
};

const DIGIT_VARIANTS: DigitVariant[] = [
  { type: "DIGITODD",   suffix: "odd",      shortLabel: "ODD",       longLabel: "DIGITODD (last digit odd, ~1.95× payout)" },
  { type: "DIGITEVEN",  suffix: "even",     shortLabel: "EVEN",      longLabel: "DIGITEVEN (last digit even, ~1.95× payout)" },
  { type: "DIGITOVER",  barrier: 0, suffix: "over0",  shortLabel: "OVER 0",  longLabel: "DIGITOVER 0 (last digit > 0, ~1.10× payout)" },
  { type: "DIGITUNDER", barrier: 9, suffix: "under9", shortLabel: "UNDER 9", longLabel: "DIGITUNDER 9 (last digit < 9, ~1.10× payout)" },
];

function makeStrat(symbol: string, variant: DigitVariant): StrategyDescriptor {
  const id = `fast3_${symbol.toLowerCase().replace(/[^a-z0-9]/g, "_")}_${variant.suffix}`;
  return {
    id,
    name: `Fast3 ${symbol} ${variant.shortLabel}`,
    description:
      `Tick-level ${variant.longLabel} on ${symbol}. One contract per tick, ` +
      `paper sim uses Deriv's display-decimals to read the next tick's last ` +
      `digit (post-fix for trailing-zero parser bug). Enable/disable per ` +
      `strategy from the Fast3 panel.`,
    symbols: [symbol],
    granularity: 0,
    detectors: defaultDetectorConfigs().map((d) => ({ ...d, enabled: false })),
    atrSlMult: 0,
    atrTpMult: 0,
    costBps: 0,
    useMartingale: true,
    digitContractType: variant.type,
    digitBarrier: variant.barrier,
    validation: {
      validatedAt: "2026-05-04",
      sampleDays: 0,
      trades: -1,
      winRate: 0,
      expectancyR: 0,
      pnlUsd: 0,
      stake: 1,
      multiplier: 1,
      notes: [
        `Ships in paper mode across the full DIGIT family for empirical screening.`,
        `Old DIGITODD-only registry assumed a "P(odd)=5/9" structural edge that turned out to be a parser bug; treat every (symbol, contract) pair as a fresh candidate.`,
        `Use the per-strategy enable toggle to prune underperformers after ~24h of paper data.`,
      ],
    },
  };
}

const ALL: StrategyDescriptor[] = [];
for (const sym of FAST3_TICK_SYMBOLS) {
  for (const variant of DIGIT_VARIANTS) {
    ALL.push(makeStrat(sym, variant));
  }
}

export const FAST3_STRATEGIES: StrategyDescriptor[] = ALL;

export const FAST3_DETECTOR_TAG = TICK_DIGIT_DETECTOR;

export function fast3StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST3_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast3Symbol(symbol: string): boolean {
  return FAST3_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

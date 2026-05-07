// Fast4 — DIGITODD/EVEN tick-level book on Deriv synthetic indices, parallel
// to Fast3 but with a "loss-streak probe" circuit breaker. After N consecutive
// losses on the base side, the dispatcher flips to the OPPOSITE digit side
// for M trades (continuing the martingale ladder through the probe), then
// resumes the base side. The probe doesn't reset the ladder by itself — a
// probe win still advances/resets the ladder per the normal mart rules.
//
// This is an independent copy of fast3-strategies.ts so experiments here
// can't perturb the live fast3 setup. ids are prefixed `fast4_` to keep
// martingale/state isolated end-to-end.
//
// User-discovered pattern (2026-05-07): after 3 consecutive losses on a
// digit side (e.g. ODD), 2 opposite-side trades may catch the tail of the
// streak before the martingale ladder bankrupts the account.

import type { StrategyDescriptor } from "./strategies/types";
import { defaultDetectorConfigs } from "./runner";

const TICK_DIGITODD_DETECTOR = "digitOddF4";

function makeStrat(symbol: string, validatedWR: number, validatedNet: number): StrategyDescriptor {
  return {
    id: `fast4_${symbol.toLowerCase().replace(/[^a-z0-9]/g, "_")}_digitodd`,
    name: `Fast4 ${symbol} DIGITODD (probe-protected)`,
    description:
      `Tick-level DIGITODD bet on ${symbol}, with loss-streak probe circuit ` +
      `breaker. After N consecutive base-side losses, flip to the opposite ` +
      `digit side for M trades (continuing the ladder), then resume. ` +
      `Independent copy of Fast3 — own ladders, balance, config.`,
    symbols: [symbol],
    granularity: 0,  // tick-level
    detectors: defaultDetectorConfigs().map((d) => ({ ...d, enabled: false })),
    atrSlMult: 0,
    atrTpMult: 0,
    costBps: 0,
    useMartingale: true,
    validation: {
      validatedAt: "2026-05-07",
      sampleDays: 0,
      trades: -1,
      winRate: validatedWR,
      expectancyR: 0,
      pnlUsd: validatedNet,
      stake: 1,
      multiplier: 1,
      notes: [
        `Fast4 — Fast3 baseline + opposite-side probe after 3 base losses.`,
        `Independent from Fast3 (own ids/ladders/balance) so probe experiments`,
        `cannot perturb the live Fast3 sandbox.`,
      ],
    },
  };
}

export const fast4R50DigitOdd     = makeStrat("R_50",     0.5591, 95);
export const fast4R75DigitOdd     = makeStrat("R_75",     0.5532, 129);
export const fast4R100DigitOdd: StrategyDescriptor = {
  ...makeStrat("R_100", 0.5513, 0),
  digitContractType: "DIGITODD",
};
export const fast4RDBearDigitOdd  = makeStrat("RDBEAR",   0.5550, 0);
export const fast4RDBullDigitOdd  = makeStrat("RDBULL",   0.5546, 79);
export const fast4JD75DigitOdd    = makeStrat("JD75",     0.5518, 203);
export const fast4HZ50VDigitOdd   = makeStrat("1HZ50V",   0.5524, 110);
export const fast4HZ100VDigitOdd  = makeStrat("1HZ100V",  0.5511, 344);

export const FAST4_STRATEGIES: StrategyDescriptor[] = [
  fast4HZ100VDigitOdd,
  fast4HZ50VDigitOdd,
  fast4JD75DigitOdd,
  fast4RDBullDigitOdd,
  fast4R75DigitOdd,
  fast4R50DigitOdd,
  fast4RDBearDigitOdd,
  fast4R100DigitOdd,
];

export const FAST4_DETECTOR_TAG = TICK_DIGITODD_DETECTOR;

export function fast4StrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return FAST4_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isFast4Symbol(symbol: string): boolean {
  return FAST4_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

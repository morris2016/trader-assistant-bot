import type { DetectorConfig, Granularity, SymbolCode } from "@shared/types";

/**
 * A self-contained, validated trading strategy. Each entry in the strategies
 * folder bundles everything needed to reproduce the live behavior: which
 * detectors run with which parameters, regime gates, cost assumptions, and
 * the asset universe the strategy was validated on.
 *
 * New strategies are added by dropping a new file alongside this one and
 * exporting from `./index.ts`. The validation block records exactly when and
 * how the strategy cleared the recommendable bar so we can spot-check claims
 * later instead of trusting label.
 */
export type StrategyDescriptor = {
  /** Stable id, snake_case. Use for routing / persistence. */
  id: string;
  /** Human-friendly name. */
  name: string;
  /** One-paragraph description: what setup it captures, why it works. */
  description: string;

  /** Assets this strategy is whitelisted for. Other symbols will not be traded by it. */
  symbols: SymbolCode[];
  /** Timeframe the validation was performed on. */
  granularity: Granularity;

  /** Detector configs (only the enabled ones will run). */
  detectors: DetectorConfig[];

  /** Fallback ATR-based stop/target multipliers when a detector does not emit
   *  structural levels. Structural stops (e.g. OB wick) take precedence when present. */
  atrSlMult: number;
  atrTpMult: number;

  /** Round-trip transaction cost assumption used during validation. */
  costBps: number;

  /** Optional regime gates — see BacktestRequest for semantics. */
  maxAdx?: number;
  minAdx?: number;
  withTrendOnlyAboveAdx?: number;
  skipDaysOfWeekUtc?: number[];
  buyOnly?: boolean;
  sellOnly?: boolean;
  /** Fast-trade sandbox flag: when true, the bot routes signals through the
   *  per-strategy martingale ladder (escalating stake on losses). When false
   *  or unset, the fast path uses a flat baseStake regardless of W/L history.
   *  Strategies with positive raw expectancy should keep this OFF — martingale
   *  would burn the edge by amplifying rare losing streaks. */
  useMartingale?: boolean;

  /** Optional override for tick-level DIGIT strategies (granularity===0). When
   *  unset, the fast3 dispatcher defaults to DIGITODD. Setting "DIGITEVEN" on
   *  one strategy lets the operator screen even-digit performance on a single
   *  symbol without changing any other strategy's behavior. */
  digitContractType?: "DIGITODD" | "DIGITEVEN";

  /** When true (DIGIT strategies only), flip the contract type after every
   *  loss. The starting side is `digitContractType` (or DIGITODD if unset);
   *  after a losing tick the runtime side toggles to the opposite, and stays
   *  there until the next loss flips it back. The intent is to sit on the
   *  side that just won and only switch when the parity-streak that caused
   *  the loss broke. Memoryless-RNG math says this doesn't improve WR, but
   *  it can change ladder dynamics noticeably. */
  flipOnLoss?: boolean;

  /** Snapshot of the validation run that promoted this strategy from "tuning" to "tradeable". */
  validation: {
    /** ISO date (YYYY-MM-DD) of the validation run. */
    validatedAt: string;
    /** How many days of historical data were used. */
    sampleDays: number;
    /** Total trades in the sample. */
    trades: number;
    /** 0..1 win rate. */
    winRate: number;
    /** Per-trade R-multiple expectancy. */
    expectancyR: number;
    /** Total USD P&L on the validation sample at the recorded stake/multiplier. */
    pnlUsd: number;
    /** Stake per trade (USD) used in the USD calculation. */
    stake: number;
    /** Leverage multiplier (Deriv MULTIPLIER) used. */
    multiplier: number;
    /** Free-form notes — prior failures, rejected variants, caveats. */
    notes?: string[];
  };
};

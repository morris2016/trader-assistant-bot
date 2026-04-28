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

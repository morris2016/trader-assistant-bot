// Risk guardrails (safety nets only — edge filters that hurt P&L were
// removed 2026-05-25 after the 199K-trade factor-mining backtest).
//
// REMOVED (didn't help in factor mining):
//   - htfTrendFilter  (Elder Triple Screen)  — cut +$716 → +$129
//   - efficiencyRatioMin (Kaufman ER)        — +$327 (worse than baseline)
//   - volumeMinMultOfSma (Williams VSA)      — superseded by qualityFilter
//                                              (uses percentile-rolling
//                                              volume rather than fixed
//                                              SMA-ratio threshold)
//
// KEPT (safety nets — prevent catastrophic events, not edge filters):
//   - maxConcurrentPositions  (Vantage: ≤3 across book)
//   - maxPositionsPerBucket   (Vantage: 1 per correlation bucket)
//   - monthlyLossCircuitBreakerPct (Elder: halt at -6% MTD)
//   - perTradeRiskPctOfEquity (Elder: 2% rule)
//
// All gates remain OFF by default for live (no behavior change unless
// operator opts in). Paper engine's risk-rules also default OFF per the
// 2026-05-24 instruction.

export type RiskRulesConfig = {
  /** Master switch — when false, every gate auto-passes. */
  enabled: boolean;
  /** Refuse new entries when total open positions ≥ this number. */
  maxConcurrentPositions?: number;
  /** Refuse new entries when ≥ this many positions are open in the same
   *  correlation bucket. */
  maxPositionsPerBucket?: number;
  /** Halt all entries when month-to-date realized P&L < −X% of month-start
   *  equity. Default 0.06 (6%) when enabled. */
  monthlyLossCircuitBreakerPct?: number;
  /** Refuse any trade whose worst-case loss (1×ATR stop) > X% of equity.
   *  Default 0.02 = 2% when enabled. */
  perTradeRiskPctOfEquity?: number;
};

/** Correlation buckets for the 15 USDT-perp universe. */
export const ASSET_BUCKETS: Record<string, string> = {
  BTCUSDT: "BTC", ETHUSDT: "BTC", BCHUSDT: "BTC",
  SOLUSDT: "SOL_L1", AVAXUSDT: "SOL_L1", BNBUSDT: "SOL_L1",
  LDOUSDT: "DEFI", AAVEUSDT: "DEFI", UNIUSDT: "DEFI", LINKUSDT: "DEFI",
  XRPUSDT: "ALT_L1", ADAUSDT: "ALT_L1", DOTUSDT: "ALT_L1", POLUSDT: "ALT_L1",
  DOGEUSDT: "MEME",
};
export function bucketOf(asset: string): string { return ASSET_BUCKETS[asset] ?? "OTHER"; }

export type RiskGateInput = {
  signal: { asset: string; pattern: string; side: string; entryPrice: number };
  config: RiskRulesConfig;
  openTrades: Array<{ asset: string; pattern: string; side: string }>;
  monthStartEquity: number;
  monthRealizedPnl: number;
  signalAtr?: number;
  proposedStake?: number;
  proposedLeverage?: number;
  currentEquity?: number;
};

export type RiskGateResult = { ok: true } | { ok: false; reason: string };

export function evaluateRiskGate(opts: RiskGateInput): RiskGateResult {
  const { config } = opts;
  if (!config.enabled) return { ok: true };

  if (config.maxConcurrentPositions != null && opts.openTrades.length >= config.maxConcurrentPositions) {
    return { ok: false, reason: `risk: max concurrent (${config.maxConcurrentPositions}) reached — ${opts.openTrades.length} open` };
  }

  if (config.maxPositionsPerBucket != null) {
    const bucket = bucketOf(opts.signal.asset);
    const inBucket = opts.openTrades.filter((t) => bucketOf(t.asset) === bucket);
    if (inBucket.length >= config.maxPositionsPerBucket) {
      return {
        ok: false,
        reason: `risk: bucket ${bucket} cap (${config.maxPositionsPerBucket}) reached — already in ${inBucket.map((t) => t.asset).join(",")}`,
      };
    }
  }

  if (config.monthlyLossCircuitBreakerPct != null && opts.monthStartEquity > 0) {
    const lossPct = -opts.monthRealizedPnl / opts.monthStartEquity;
    if (lossPct >= config.monthlyLossCircuitBreakerPct) {
      return {
        ok: false,
        reason: `risk: monthly loss ${(lossPct * 100).toFixed(1)}% ≥ cap ${(config.monthlyLossCircuitBreakerPct * 100).toFixed(1)}% — paused for the month`,
      };
    }
  }

  if (
    config.perTradeRiskPctOfEquity != null &&
    opts.signalAtr != null && opts.signalAtr > 0 &&
    opts.proposedStake != null && opts.proposedLeverage != null &&
    opts.currentEquity != null && opts.currentEquity > 0
  ) {
    const stopDistPct = opts.signalAtr / opts.signal.entryPrice;
    const riskDollars = opts.proposedStake * opts.proposedLeverage * stopDistPct;
    const riskPct = riskDollars / opts.currentEquity;
    if (riskPct > config.perTradeRiskPctOfEquity) {
      return {
        ok: false,
        reason: `risk: per-trade risk ${(riskPct * 100).toFixed(2)}% > cap ${(config.perTradeRiskPctOfEquity * 100).toFixed(2)}% (stake $${opts.proposedStake} × ${opts.proposedLeverage}× × ${(stopDistPct * 100).toFixed(2)}% stop = $${riskDollars.toFixed(2)} on $${opts.currentEquity.toFixed(2)} equity)`,
      };
    }
  }

  return { ok: true };
}

export const DEFAULT_RISK_RULES: RiskRulesConfig = { enabled: false };

// ─────────────────────────────────────────────────────────────────────────
// HF quality filter — separate from generic risk-rules because it needs
// per-asset rolling-percentile bar context. Validated 2026-05-25 via 199K-
// trade factor mining: filtered subset shows 27/27 months profitable at
// per-asset max lev, vs 27/29 baseline. Edge: bbWidth top 50% + volume top
// 50% + hour ∈ [12-22 UTC] yields +$1.43/trade vs +$0.32 baseline.
// ─────────────────────────────────────────────────────────────────────────

export type HfQualityFilterConfig = {
  enabled: boolean;
  /** Allowed entry hours (UTC). Default [12..22]. Empty array = all hours. */
  hoursUtc?: number[];
  /** Minimum bbWidth percentile vs recent window. 0.5 = require top 50%
   *  of recent bars by bbWidth. Set to 0 to disable. */
  minBbWidthPercentile?: number;
  /** Minimum volume percentile vs recent window. Used as "market activity"
   *  proxy since Kline doesn't include trades count. Default 0.5. */
  minVolumePercentile?: number;
  /** Rolling window size for percentile computation (in 15m bars).
   *  Default 200 = ~50 hours. */
  rollingWindowBars?: number;
};

export const DEFAULT_HF_QUALITY_FILTER: HfQualityFilterConfig = { enabled: false };

export const RECOMMENDED_HF_QUALITY_FILTER: HfQualityFilterConfig = {
  enabled: true,
  hoursUtc: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
  minBbWidthPercentile: 0.5,
  minVolumePercentile: 0.5,
  rollingWindowBars: 200,
};

/** Quality filter for HF signals. Called from checkHfSignalsFor with the
 *  current bar's context + recent bar history. */
export function evaluateHfQualityFilter(opts: {
  config: HfQualityFilterConfig;
  hourUtc: number;
  currentBbWidth: number;       // (upper - lower) / mid of current bar
  currentVolume: number;
  recentBbWidths: number[];     // last N bars' bbWidth
  recentVolumes: number[];      // last N bars' volume
}): RiskGateResult {
  const { config } = opts;
  if (!config.enabled) return { ok: true };

  // Hours filter
  if (config.hoursUtc && config.hoursUtc.length > 0) {
    if (!config.hoursUtc.includes(opts.hourUtc)) {
      return { ok: false, reason: `hf-quality: hour ${opts.hourUtc} UTC not in allowed window [${config.hoursUtc.join(",")}]` };
    }
  }

  // bbWidth percentile
  if (config.minBbWidthPercentile != null && config.minBbWidthPercentile > 0 && opts.recentBbWidths.length >= 20) {
    const sorted = opts.recentBbWidths.slice().sort((a, b) => a - b);
    const thresholdIdx = Math.floor(sorted.length * config.minBbWidthPercentile);
    const threshold = sorted[thresholdIdx];
    if (opts.currentBbWidth < threshold) {
      return { ok: false, reason: `hf-quality: bbWidth ${opts.currentBbWidth.toFixed(5)} below ${(config.minBbWidthPercentile * 100).toFixed(0)}-pctile ${threshold.toFixed(5)} of last ${opts.recentBbWidths.length} bars` };
    }
  }

  // Volume percentile
  if (config.minVolumePercentile != null && config.minVolumePercentile > 0 && opts.recentVolumes.length >= 20) {
    const sorted = opts.recentVolumes.slice().sort((a, b) => a - b);
    const thresholdIdx = Math.floor(sorted.length * config.minVolumePercentile);
    const threshold = sorted[thresholdIdx];
    if (opts.currentVolume < threshold) {
      return { ok: false, reason: `hf-quality: volume ${opts.currentVolume.toFixed(2)} below ${(config.minVolumePercentile * 100).toFixed(0)}-pctile ${threshold.toFixed(2)} of last ${opts.recentVolumes.length} bars` };
    }
  }

  return { ok: true };
}

/** Per-asset max leverage on Binance USDT-M Perpetuals at the lowest
 *  notional bracket ($0-50K). Used as the default for hf.perAssetLeverage
 *  so each symbol uses its full exchange-allowed lev rather than being
 *  capped by the lowest common denominator. */
export const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75,
  LINKUSDT: 75, ADAUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};

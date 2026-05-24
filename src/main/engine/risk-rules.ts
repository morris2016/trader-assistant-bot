// Risk guardrails distilled from 6 trading books surveyed 2026-05-24:
// Elder's "Trading for a Living" (2% / 6% rules), Williams' "Master the
// Markets" VSA (volume confirmation), Vantage's correlation cap, and
// Kaufman's Trading Systems and Methods (portfolio-level limits).
//
// All gates are OFF by default in live config — opt-in only after paper
// validation. Paper config defaults them ON so we observe the impact on
// the same signal stream as live.
//
// Each gate returns `{ ok: false, reason }` to short-circuit the entry.
// Reasons are logged so the operator can see exactly which rule fired.

export type RiskRulesConfig = {
  /** Master switch — when false, every gate auto-passes. */
  enabled: boolean;
  /** Refuse new entries when total open positions ≥ this number.
   *  Vantage rule: "never have more than two or three positions open at
   *  the same time". Default 3 when enabled. */
  maxConcurrentPositions?: number;
  /** Refuse new entries when ≥ this many positions are open in the same
   *  correlation bucket. Vantage: correlated longs = 4% risk per pair.
   *  Default 1 when enabled (one trade per bucket). */
  maxPositionsPerBucket?: number;
  /** Halt all entries when month-to-date realized P&L < −X% of month-start
   *  equity. Elder: "If you are trading to create the best track record,
   *  you will not want to show more than a 6 percent or 8 percent monthly
   *  loss. When you hit that limit, stop trading for the rest of the month."
   *  Default 0.06 (6%) when enabled. */
  monthlyLossCircuitBreakerPct?: number;
  /** Require the most recent bar's volume ≥ this × SMA(volume, 20). Williams:
   *  "wide spread up bar on heavy volume" confirms institutional displacement.
   *  Default 1.2 when enabled (modest filter; raise to 1.5 for stricter). */
  volumeMinMultOfSma?: number;
  /** Elder's Triple Screen veto applied to HF (15m) entries: HF LONG requires
   *  the corresponding 1h close > EMA(50); HF SHORT requires < EMA(50).
   *  Directly addresses the HF LONG -$13 bleed observed live (BB-reversal
   *  longs taken in a 1h downtrend — Elder's exact "premature buy signal").
   *  Modes: "off" | "hfOnly" | "all" (apply to SMC entries too). */
  htfTrendFilter?: "off" | "hfOnly" | "all";
  /** Kaufman's Efficiency Ratio on the entry TF: ER ≥ threshold means
   *  trending market; < threshold means chop. Default 0.3 when enabled.
   *  Applied to SMC entries (which assume trend continuation). */
  efficiencyRatioMin?: number;
  /** Elder F1: cap the dollar risk per trade as a fraction of current equity.
   *  Computed as `stake × leverage × (atr / entryPrice)` (the 1-ATR stop
   *  distance the engine already uses). Default 0.02 = 2% when enabled.
   *  Refuses any trade whose worst-case loss would exceed equity × this. */
  perTradeRiskPctOfEquity?: number;
};

/** Correlation buckets for the 15 USDT-perp universe. Built from observed
 *  30-day return correlation clusters. When `maxPositionsPerBucket=1`, the
 *  bot won't double up on (e.g.) BTC + ETH + BCH at the same time — they
 *  all move together in a crypto-wide flush. */
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
  /** Month-start equity baseline. For paper = paperWallet at month start;
   *  for live = wallet balance at month start (synced from broker). */
  monthStartEquity: number;
  /** Sum of realized P&L this month (negative when losing). */
  monthRealizedPnl: number;
  /** Recent volume series (oldest → newest) for the signal's TF. Must
   *  contain at least 21 entries to evaluate volume gate; otherwise the
   *  gate auto-passes (insufficient data). */
  recentVolumes?: number[];
  /** Closes on the signal's entry TF — last 11 entries minimum to compute
   *  Efficiency Ratio (period=10). Gate auto-passes if missing. */
  recentEntryCloses?: number[];
  /** 1h closes (HTF) — last 50 entries minimum to compute EMA(50) for the
   *  Triple Screen HTF trend filter. Gate auto-passes if missing. */
  recent1hCloses?: number[];
  /** ATR (1×) used as the bot's stop distance — needed for per-trade
   *  risk-pct computation. Gate auto-passes if missing. */
  signalAtr?: number;
  /** Proposed trade sizing — used by the per-trade risk gate to compute
   *  expected $-risk at the configured stop distance. */
  proposedStake?: number;
  proposedLeverage?: number;
  /** Current account equity in USDT — for paper = paperWallet; for live =
   *  cached wallet balance. Per-trade risk gate auto-passes if ≤ 0. */
  currentEquity?: number;
};

/** Compute exponential moving average of the last N values. Standard
 *  smoothing constant k = 2/(N+1). */
function ema(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const k = 2 / (n + 1);
  let e = values[values.length - n];
  for (let i = values.length - n + 1; i < values.length; i++) {
    e = values[i] * k + e * (1 - k);
  }
  return e;
}

/** Kaufman's Efficiency Ratio (period n): |last − first| / sum(|Δ|).
 *  1.0 = perfect trend; 0.0 = pure chop. Threshold 0.3 separates the two. */
function efficiencyRatio(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const slice = closes.slice(-(n + 1));
  const netMove = Math.abs(slice[slice.length - 1] - slice[0]);
  let pathLength = 0;
  for (let i = 1; i < slice.length; i++) pathLength += Math.abs(slice[i] - slice[i - 1]);
  if (pathLength === 0) return 0;
  return netMove / pathLength;
}

export type RiskGateResult = { ok: true } | { ok: false; reason: string };

export function evaluateRiskGate(opts: RiskGateInput): RiskGateResult {
  const { config } = opts;
  if (!config.enabled) return { ok: true };

  // Max concurrent positions
  if (config.maxConcurrentPositions != null) {
    if (opts.openTrades.length >= config.maxConcurrentPositions) {
      return { ok: false, reason: `risk: max concurrent (${config.maxConcurrentPositions}) reached — ${opts.openTrades.length} open` };
    }
  }

  // Per-bucket cap (correlation control)
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

  // Monthly loss circuit breaker
  if (config.monthlyLossCircuitBreakerPct != null && opts.monthStartEquity > 0) {
    const lossPct = -opts.monthRealizedPnl / opts.monthStartEquity;  // positive when net loss
    if (lossPct >= config.monthlyLossCircuitBreakerPct) {
      return {
        ok: false,
        reason: `risk: monthly loss ${(lossPct * 100).toFixed(1)}% ≥ cap ${(config.monthlyLossCircuitBreakerPct * 100).toFixed(1)}% — paused for the month`,
      };
    }
  }

  // Volume gate — requires recent-volume series
  if (config.volumeMinMultOfSma != null && opts.recentVolumes && opts.recentVolumes.length >= 21) {
    const vols = opts.recentVolumes;
    const recent = vols[vols.length - 1];
    const prev20 = vols.slice(-21, -1);
    const smaVol = prev20.reduce((s, v) => s + v, 0) / prev20.length;
    if (smaVol > 0 && recent < config.volumeMinMultOfSma * smaVol) {
      return {
        ok: false,
        reason: `risk: volume ${recent.toFixed(2)} < ${config.volumeMinMultOfSma}× SMA(20) ${smaVol.toFixed(2)}`,
      };
    }
  }

  // Elder Triple Screen — HTF trend filter
  // hfOnly: applies to HF patterns (BB_*); all: applies to every entry.
  if (config.htfTrendFilter && config.htfTrendFilter !== "off") {
    const isHf = opts.signal.pattern.startsWith("BB_");
    const applies = config.htfTrendFilter === "all" || (config.htfTrendFilter === "hfOnly" && isHf);
    if (applies && opts.recent1hCloses) {
      const e = ema(opts.recent1hCloses, 50);
      const last1h = opts.recent1hCloses[opts.recent1hCloses.length - 1];
      if (e !== null && last1h !== undefined) {
        const htfBull = last1h > e;
        const wantLong = opts.signal.side === "LONG";
        // LONG entry needs HTF bull; SHORT entry needs HTF bear.
        if (wantLong !== htfBull) {
          return {
            ok: false,
            reason: `risk: HTF trend filter — ${opts.signal.side} signal but 1h close ${last1h.toFixed(4)} ${htfBull ? ">" : "<"} EMA(50) ${e.toFixed(4)}`,
          };
        }
      }
    }
  }

  // Efficiency Ratio — Kaufman's trend-vs-chop separator
  if (config.efficiencyRatioMin != null && opts.recentEntryCloses) {
    const er = efficiencyRatio(opts.recentEntryCloses, 10);
    if (er !== null && er < config.efficiencyRatioMin) {
      return {
        ok: false,
        reason: `risk: ER(10) ${er.toFixed(3)} < min ${config.efficiencyRatioMin} — market too choppy for this setup`,
      };
    }
  }

  // Per-trade risk cap (Elder F1)
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

/** Default config — every gate OFF. Caller opts in per-gate. */
export const DEFAULT_RISK_RULES: RiskRulesConfig = { enabled: false };

/** Recommended starting config for paper trading: all gates on with
 *  consensus thresholds from the surveyed books. */
export const PAPER_DEFAULT_RISK_RULES: RiskRulesConfig = {
  enabled: true,
  maxConcurrentPositions: 3,
  maxPositionsPerBucket: 1,
  monthlyLossCircuitBreakerPct: 0.06,
  volumeMinMultOfSma: 1.2,
  htfTrendFilter: "hfOnly",
  efficiencyRatioMin: 0.3,
  perTradeRiskPctOfEquity: 0.02,
};

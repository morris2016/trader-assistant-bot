/**
 * Deriv market symbol code. Kept as `string` so we can support any symbol
 * Deriv exposes (FX pairs, metals, crypto, synthetics, indices, commodities)
 * without having to maintain a closed union type.
 */
export type SymbolCode = string;

export type ContractFamily = "CALL_PUT" | "MULTIPLIER" | "DIGIT";

export type Granularity = 60 | 120 | 180 | 300 | 600 | 900 | 1800 | 3600 | 7200 | 14400 | 28800 | 86400;

export type Tick = {
  symbol: SymbolCode;
  epoch: number;
  quote: number;
};

export type Candle = {
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type SignalAction = "BUY" | "SELL";

export type Signal = {
  id: string;
  ts: number;
  symbol: SymbolCode;
  detector: string;
  action: SignalAction;
  confidence: number;
  reason: string;
  price: number;
  /** Optional structural stop level (e.g. OB wickBottom for BULL). If present
   *  the backtest/live engine should prefer this over ATR-based stops. */
  stopPrice?: number;
  /** Optional structural take-profit level. */
  targetPrice?: number;
};

export type OrderBlock = {
  id: string;
  symbol: SymbolCode;
  /** "ob" = classic Order Block, "fvg" = Fair Value Gap / Imbalance. */
  kind?: "ob" | "fvg";
  side: "BULL" | "BEAR";
  /** Drawn zone's top — body or wick based on zoneStyle. */
  top: number;
  /** Drawn zone's bottom — body or wick based on zoneStyle. */
  bottom: number;
  /** OB candle's full wick top, for stop placement (OB detector only). */
  wickTop?: number;
  /** OB candle's full wick bottom, for stop placement. */
  wickBottom?: number;
  startEpoch: number;
  endEpoch: number | null;
  mitigated: boolean;
};

export type LiquidityPool = {
  id: string;
  symbol: SymbolCode;
  /** "EQH" = equal highs (sell-side liquidity above), "EQL" = equal lows (buy-side liquidity below). */
  side: "EQH" | "EQL";
  /** The liquidity level — max of equal highs for EQH, min of equal lows for EQL. */
  price: number;
  /** Epoch of the first equal swing point in the cluster. */
  firstEpoch: number;
  /** Epoch of the last equal swing point (or current bar if extending). */
  lastEpoch: number;
  /** Number of equal swing points in this cluster. */
  taps: number;
  /** Epoch when the pool was swept (wick above/below + close back through). Null if untouched. */
  sweptEpoch: number | null;
};

export type StructureMark = {
  id: string;
  symbol: SymbolCode;
  /** "BOS" = continuation in trend, "CHoCH" = reversal. */
  kind: "BOS" | "CHoCH";
  /** Direction of the break — "up" = price broke a swing high, "down" = broke a swing low. */
  side: "up" | "down";
  /** The swing level that was broken. */
  price: number;
  /** Epoch of the swing bar (line's left edge). */
  swingEpoch: number;
  /** Epoch of the bar on which the break occurred (label position). */
  breakEpoch: number;
};

export type ChartOverlay =
  | { kind: "orderBlock"; block: OrderBlock }
  | { kind: "signalMarker"; signal: Signal }
  | { kind: "structureMark"; mark: StructureMark };

export type PaperPosition = {
  id: string;
  symbol: SymbolCode;
  side: "BUY" | "SELL";
  entryPrice: number;
  openedAt: number;
  stake: number;
  detector: string;
};

export type ClosedPaperPosition = PaperPosition & {
  closedAt: number;
  exitPrice: number;
  pnlPct: number;
  pnl: number;
  exitReason: "tp" | "sl" | "manual" | "opposite_signal";
};

export type PaperStats = {
  totalClosed: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  totalPnlPct: number;
  openCount: number;
};

export type PaperState = {
  open: PaperPosition[];
  closed: ClosedPaperPosition[];
  stats: PaperStats;
};

export type WatcherStatus = {
  wsConnected: boolean;
  activeSymbol: SymbolCode | null;
  watching: boolean;
  tokenConfigured: boolean;
  realModeEnabled: boolean;
  account: AccountInfo | null;
};

export type AccountInfo = {
  loginid: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  fullname?: string;
  email?: string;
};

export type RealTradeSide = "BUY" | "SELL";

export type RealTrade = {
  id: string;                   // local id
  contractId: number;           // Deriv contract_id
  symbol: SymbolCode;
  side: RealTradeSide;
  family: ContractFamily;       // "CALL_PUT" (binary) or "MULTIPLIER"
  contractType: "CALL" | "PUT" | "MULTUP" | "MULTDOWN" | "DIGITODD" | "DIGITEVEN" | "DIGITOVER" | "DIGITUNDER" | "DIGITMATCH" | "DIGITDIFF";
  stake: number;
  currency: string;
  entrySpot: number | null;
  exitSpot: number | null;
  buyPrice: number;
  payout: number | null;
  // CALL_PUT only
  durationSec?: number;
  durationTicks?: number;
  // Multiplier only
  multiplier?: number;
  takeProfit?: number | null;   // absolute profit in currency (sent to Deriv)
  stopLoss?: number | null;     // absolute loss in currency (sent to Deriv, positive number)
  /** Bot-managed take-profit threshold in $. When the designed TP$ falls
   *  below Deriv's minimum (Deriv rejects too-tight TP/SL on MULT contracts
   *  for certain symbols, e.g. BOOM300N requires ≥$0.61), the bot sends a
   *  Deriv-compliant wider TP to satisfy the broker, but TICK-watches and
   *  manually sells when currentProfit ≥ botManagedTp$. Preserves the
   *  validated SL/TP geometry from the strategy descriptor regardless of
   *  Deriv's contract-level minimums. Null = Deriv's TP is the only stop. */
  botManagedTakeProfit?: number | null;
  /** Bot-managed stop-loss threshold in $ (positive). Same pattern as
   *  botManagedTakeProfit but for the loss side. Bot sells when
   *  currentProfit ≤ -botManagedSl$. */
  botManagedStopLoss?: number | null;
  /** Initial profit value at trade open (essentially negative the commission
   *  for MULTIPLIER contracts, since Deriv reports profit = bid - buy_price
   *  and ask=bid at open). Used as a baseline so bot-managed SL/TP compare
   *  PRICE-MOVEMENT only, not the commission overhead. */
  openProfit?: number | null;
  /** Peak profit seen on this contract (for trailing-exit logic). */
  peakProfit?: number | null;
  /** True once peakProfit crossed the trail-arm threshold. */
  trailArmed?: boolean;
  /** Trailing-exit ON/OFF for this trade — captured at placeTrade so a
   *  mid-trade config change doesn't toggle behavior. */
  trailingExitEnabled?: boolean;
  /** Arm threshold as fraction of designed TP$ (e.g. 0.95 = arm at 95% of TP). */
  trailingArmPct?: number;
  /** Retracement from peak that triggers manual sell (e.g. 0.20 = 20%). */
  trailingRetracePct?: number;
  /** Latest broker-side TP$ pushed via contract_update. Used to ratchet
   *  the Deriv take_profit upward as peak grows so a single-tick spike
   *  (e.g. BOOM 300N boom event) auto-closes at the broker-side threshold
   *  instead of skipping it during the tick gap. Server-side execution
   *  closes the contract the moment profit crosses this level, regardless
   *  of when the next bot tick arrives. */
  brokerTpAmount?: number | null;
  /** Current broker-side stop_loss order amount (positive value, loss
   *  magnitude). Set on order open from clampForDeriv(slDesigned).
   *  Tightened on trail-arm to Deriv's $0.10 floor — once the trade is
   *  profitable enough to arm, the original wide SL is no longer needed
   *  and a tighter SL caps post-arm catastrophic spike-down losses. */
  brokerSlAmount?: number | null;
  openedAt: number;
  closedAt: number | null;
  status: "open" | "won" | "lost" | "cancelled";
  profit: number | null;        // in account currency (final, set on settlement)
  /** Live unrealized P&L for an OPEN contract — updated from each
   *  proposal_open_contract tick. Null until first POC message arrives, and
   *  stale (still set to last value) after the trade settles. UIs should
   *  prefer `profit` once `closedAt != null`. */
  currentProfit?: number | null;
  detector: string;             // "manual" for user-initiated
  // ── Production telemetry (paper-vs-live drift diagnostics) ────────────
  /** Wall-clock ms when the signal fired (bar close). null for manual trades. */
  signalFiredAt?: number | null;
  /** Expected entry price as known at signal time (typically the close that
   *  triggered the signal). Used with entrySpot to compute live slippage. */
  signalEntry?: number | null;
  /** Wall-clock ms when buy_price came back from Deriv (contract opened). */
  contractOpenedAt?: number | null;
  /** Signed slippage from signalEntry → entrySpot, in absolute price units.
   *  Positive when the fill was adverse to the side (BUY filled higher,
   *  SELL filled lower). Null until entry_spot arrives via the contract
   *  update stream. */
  entrySlippage?: number | null;
  /** Total round-trip latency in ms from signalFiredAt to contractOpenedAt. */
  openLatencyMs?: number | null;
  /** Which sandbox routed this trade. "real" = registered real-asset
   *  strategy (silver/gold/plat/pall/etc). "fast2" = Fast2 sandbox running
   *  live (signals route to real.placeTrade instead of fast2Paper). Used at
   *  settle time to advance the correct martingale ladder. Defaults to
   *  "real" when undefined for backward compatibility with existing trades. */
  sandbox?: "real" | "fast" | "fast2" | "fast3";
  /** Strategy id within the sandbox (e.g. "fast2_rdbear_meanrev"). Lets
   *  the settle handler look up the right ladder without re-deriving from
   *  symbol+detector. */
  sandboxStrategyId?: string;
};

export type RealState = {
  open: RealTrade[];
  closed: RealTrade[];
  stats: {
    totalClosed: number;
    wins: number;
    winRate: number;
    totalProfit: number;
    currency: string | null;
  };
  daily: {
    date: string;               // YYYY-MM-DD (UTC)
    profit: number;
    tradesOpened: number;
    capHit: boolean;
  };
};

export type RealModeGate = {
  canEnable: boolean;
  reasons: string[];            // human readable missing prerequisites
};

export type DetectorConfig = {
  id: string;
  label: string;
  enabled: boolean;
  params: Record<string, number>;
};

export type StrategyMode = "raw" | "confluence" | "trend-confluence";

export type StrategyConfig = {
  mode: StrategyMode;
  /** Minimum ADX reading for a bar to count as "trending". */
  adxThreshold: number;
  /** How many bars back to look when checking for confluence. */
  confluenceWindowBars: number;
};

/** Which engine emits the actual trading signal that triggers paper/real
 *  fills. Detectors continue to run for chart overlays regardless. */
export type SignalSource = "deepseek" | "detectors" | "consensus";

export type Settings = {
  activeSymbol: SymbolCode;
  granularity: Granularity;
  detectors: DetectorConfig[];
  strategy: StrategyConfig;
  /** Default "deepseek" — DeepSeek is the primary decision-maker. */
  signalSource: SignalSource;
  /** Minimum DeepSeek confidence to fire a signal (0..1). Default 0.55. */
  deepseekMinConfidence: number;
  risk: {
    perTradeMaxStake: number;
    dailyMaxLoss: number;
    realModeConfirmed: boolean;
  };
  realTrading: {
    contractFamily: ContractFamily;   // "CALL_PUT" (Rise/Fall) or "MULTIPLIER"
    durationTicks: number;            // used when family === "CALL_PUT"
    multiplier: number;               // used when family === "MULTIPLIER"
    // TP / SL configuration — EITHER percent-of-stake OR ATR-multiple:
    tpSlMode: "percent" | "atr";
    takeProfitPct: number;            // used when tpSlMode === "percent" (0 = no TP)
    stopLossPct: number;              // used when tpSlMode === "percent" (0 = no SL)
    atrTpMult: number;                // used when tpSlMode === "atr" (0 = no TP)
    atrSlMult: number;                // used when tpSlMode === "atr" (0 = no SL)
    autoTradeOnSignal: boolean;
  };
};

export type BacktestRequest = {
  symbol: SymbolCode;
  granularity: Granularity;
  count: number;
  endEpoch?: number | "latest";
  /** Stop-loss distance in ATR(14) multiples. Default 1.0. */
  atrSlMult?: number;
  /** Take-profit distance in ATR(14) multiples. Default 2.0 → 2:1 R:R. */
  atrTpMult?: number;
  /** Round-trip transaction cost in basis points (1 bps = 0.01%). Default 2.0
   * — typical FX major spread on hourly bars. Metals/crypto often 5–15. */
  costBps?: number;
  /** Trail the stop to entry once MFE reaches this many R. 0 disables.
   *  E.g. 1.0 → "move SL to breakeven at +1R favorable excursion". */
  breakevenAtRMul?: number;
  /** Drop signals whose ADX(14) at signal-bar exceeds this. Useful for OB
   *  on assets where the strategy works in ranging regimes only. */
  maxAdx?: number;
  /** Drop signals whose ADX(14) at signal-bar is below this. Inverse of
   *  maxAdx — for trend-following detectors. */
  minAdx?: number;
  /** When set, in trending regimes (ADX ≥ adxThresholdForTrend) only allow
   *  signals whose direction matches the trend (BUY in uptrend, SELL in
   *  downtrend). Below the threshold, signals pass freely. Use together
   *  with maxAdx > adxThresholdForTrend to also accept ranging-mode signals. */
  withTrendOnlyAboveAdx?: number;
  /** Drop signals that fire on these UTC days-of-week. 0=Sun..6=Sat.
   *  Useful for skipping low-liquidity weekend hours on crypto. */
  skipDaysOfWeekUtc?: number[];
  /** Drop SELL signals (only allow BUY). For symbols with strong directional bias. */
  buyOnly?: boolean;
  /** Drop BUY signals (only allow SELL). Mirror of buyOnly. */
  sellOnly?: boolean;
  /** Dynamic regime side-bias: when set, computes SMA over this many bars and
   *  drops SELLs when price > SMA (bullish regime) and BUYs when price < SMA
   *  (bearish regime). Auto-flips between BUY-only and SELL-only based on trend. */
  dynamicSideBySma?: number;
  /** AI mode: "off" runs detectors only (default + scan default).
   *  "primary" samples DeepSeek every `aiIntervalBars` bars and drives signals.
   *  "consensus" calls DeepSeek only on detector signals to ratify or veto. */
  aiMode?: "off" | "primary" | "consensus";
  /** Bars between DeepSeek samples in primary mode. Default 30. */
  aiIntervalBars?: number;
  /** Min confidence (0..1) for DeepSeek to fire/ratify. Default 0.55. */
  aiMinConfidence?: number;
  detectors: DetectorConfig[];
  strategy?: StrategyConfig;
};

export type BacktestProgress = {
  symbol: SymbolCode;
  /** AI calls completed so far (running totals). */
  aiCalls: number;
  /** Approximate USD cost so far (~$0.0005/call estimate). */
  aiCostUsd: number;
};

export type BacktestTrade = {
  id: string;
  symbol: SymbolCode;
  detector: string;
  side: "BUY" | "SELL";
  openedAtIndex: number;
  closedAtIndex: number;
  entryPrice: number;
  exitPrice: number;
  pnlPct: number;
  exitReason: "tp" | "sl" | "opposite_signal" | "run_end";
  /** Absolute stop level set at entry (entry ± atrSlMult × ATR). */
  stopPrice: number;
  /** Absolute target level set at entry (entry ± atrTpMult × ATR). */
  targetPrice: number;
  /** ATR(14) sampled at entry — for R-multiple analysis. */
  atrAtEntry: number;
};

export type BacktestResult = {
  request: BacktestRequest;
  candles: Candle[];
  // Per-bar outputs, aligned by index with candles[].
  signalsAt: Signal[][];
  blocksCreatedAt: OrderBlock[][];
  blocksMitigatedAt: string[][];
  // All detected blocks (so renderer can reveal them progressively).
  blocks: OrderBlock[];
  // BOS/CHoCH structure marks indexed by bar.
  structureMarksAt: StructureMark[][];
  // Liquidity pools created / swept / removed per bar.
  poolsCreatedAt: LiquidityPool[][];
  poolsSweptAt: Array<{ id: string; sweptEpoch: number }>[];
  poolsRemovedAt: string[][];
  // Simulated paper trades.
  trades: BacktestTrade[];
  equityByIndex: number[]; // cumulative pnlPct after each bar
  /** Per-detector diagnostic counters for why signals/zones were rejected. */
  detectorDiagnostics?: Record<string, Record<string, number>>;
  /** Number of DeepSeek calls made during this run (0 when aiMode = "off"). */
  aiCalls?: number;
  /** Approximate USD cost for the AI calls (~$0.0005 per call). */
  aiCostUsd?: number;
  /** Counts of how DeepSeek voted on detector signals in consensus mode. */
  aiConsensus?: { ratified: number; vetoed: number; abstained: number };
  stats: {
    totalClosed: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlPct: number;
    byDetector: Record<string, { totalClosed: number; wins: number; winRate: number; totalPnlPct: number }>;
  };
};

export type SymbolMeta = {
  code: SymbolCode;
  displayName: string;
  market: string;
  submarket: string;
  pipSize: number;
  displayDecimals: number;
  exchangeOpen: boolean;
};

/**
 * Per-bar snapshot of a detector's internal state, for debugging why
 * signals/zones aren't firing. Emitted on every bar close.
 */
export type DetectorDiagnostics = {
  symbol: SymbolCode;
  detector: string;
  /** Cumulative rejection counts by reason since seed. */
  rejections: Record<string, number>;
  /** Candidates awaiting promotion (e.g. OBs in 4-candle validation). */
  provisional: number;
  /** Zones currently live on the chart. */
  active: number;
};

export type RegimeSnapshot = {
  symbol: SymbolCode;
  adx: number;
  direction: "up" | "down" | "flat";
  trending: boolean;
  threshold: number;
  atr: number;
};

export type MainEvent =
  | { type: "candle"; symbol: SymbolCode; candle: Candle; isNew: boolean }
  | { type: "tick"; tick: Tick }
  | { type: "signal"; signal: Signal }
  | { type: "orderBlock"; block: OrderBlock }
  | { type: "orderBlockMitigated"; id: string }
  | { type: "liquidityPool"; pool: LiquidityPool }
  | { type: "liquidityPoolSwept"; id: string; sweptEpoch: number }
  | { type: "liquidityPoolRemoved"; id: string }
  | { type: "structureMark"; mark: StructureMark }
  | { type: "regime"; regime: RegimeSnapshot }
  | { type: "detectorDiagnostics"; diagnostics: DetectorDiagnostics }
  | { type: "deepseekAdvice"; symbol: SymbolCode; action: "BUY" | "SELL" | "HOLD"; confidence: number; reason: string; tsMs: number }
  | { type: "status"; status: WatcherStatus }
  | { type: "paper"; state: PaperState }
  | { type: "real"; state: RealState }
  | { type: "realTradeOpened"; trade: RealTrade }
  | { type: "realTradeSettled"; trade: RealTrade }
  | { type: "realCapHit"; dailyLoss: number; cap: number }
  | { type: "realError"; message: string };

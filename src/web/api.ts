// API client for the bot dashboard. Same-origin, no CORS, no base URL.

export type AdaptiveShiftState = {
  consecLosses: number;
  buyHistory: ("W" | "L")[];
  sellHistory: ("W" | "L")[];
  metalsLossEpochs: number[];
  metalsThrottleUntil: number;
};

export type Daily = { date: string; profit: number; tradesOpened: number; capHit: boolean };

export type Account = {
  loginid: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  fullname?: string;
  email?: string;
} | null;

export type Health = { wsConnected: boolean; authorized: boolean; uptimeSec: number };

export type RealConfig = {
  liveTradingEnabled: boolean;
  baseStake: number;
  multiplier: number;
  dailyMaxLoss: number;
};

export type RealTrade = {
  id: string;
  contractId: number;
  symbol: string;
  side: "BUY" | "SELL";
  family: string;
  contractType: string;
  stake: number;
  currency: string;
  entrySpot: number | null;
  exitSpot: number | null;
  buyPrice: number;
  payout?: number | null;
  multiplier?: number;
  takeProfit?: number | null;
  stopLoss?: number | null;
  openedAt: number;
  closedAt: number | null;
  status: string;
  profit: number | null;
  /** Live unrealized P&L while the contract is open (updated each
   *  proposal_open_contract tick). After settle, prefer `profit`. */
  currentProfit?: number | null;
  detector: string;
  /** Origin sandbox: "real" (default), "fast", "fast2", "fast3", or "fast4". */
  sandbox?: "real" | "fast" | "fast2" | "fast3" | "fast4";
  sandboxStrategyId?: string;
  signalFiredAt?: number | null;
  signalEntry?: number | null;
  contractOpenedAt?: number | null;
  entrySlippage?: number | null;
  openLatencyMs?: number | null;
};

export type StateResp = {
  daily: Daily;
  open: RealTrade[];
  openCount: number;
  totalClosed: number;
  adaptiveShift: AdaptiveShiftState;
  adaptiveShiftDescription: string;
  paused: boolean;
  account: Account;
  health: Health;
};

export type Signal = {
  id: string;
  symbol: string;
  detector: string;
  action: "BUY" | "SELL";
  confidence: number;
  reason: string;
  candleEpoch: number;
  emittedAt: number;
};

export type StrategyStats = {
  id: string;
  name: string;
  description: string;
  symbols: string[];
  granularity: number;
  validation: { expectancyR?: number; winRate?: number; pnlUsd?: number; trades?: number };
  live: {
    signals: number;
    trades: number;
    wins: number;
    losses: number;
    pnlUsd: number;
    winRate: number;
    expectancyR: number;
    lastSignalAt: number | null;
    lastTradeAt: number | null;
    barsSeen: number;
    lastBarSeenAt: number | null;
  };
};

export type Subscription = { symbol: string; granularity: number; bars: number };

export type Candle = { epoch: number; open: number; high: number; low: number; close: number };

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: "POST", headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  // Don't throw on 4xx — let caller inspect ok/error
  return res.json() as Promise<T>;
}

export type PaperPosition = {
  id: string; signalId: string; symbol: string; side: "BUY" | "SELL"; detector: string;
  stake: number; multiplier: number; entryPrice: number; stopPrice: number; takeProfitPrice: number;
  openedAt: number; openedAtCandleEpoch: number; granularity: number;
  appliedShiftMultiplier: number; appliedShiftReasons: string;
  /** Deriv-style commission charged at open (present on Fast/Fast2 trades). */
  commission?: number;
  /** Adverse entry-spread amount applied to the entry price at open. */
  entrySpread?: number;
};
export type ClosedPaperPosition = PaperPosition & {
  closedAt: number; closedAtCandleEpoch: number; exitPrice: number;
  result: "won" | "lost"; pnl: number; rMultiple: number;
  /** DIGIT-side tag for Fast3/Fast4 trades. UI shows ODD/EVEN per row so
   *  the operator can spot when a Fast4 probe phase fired. Undefined for
   *  non-DIGIT trades. */
  digitSide?: "DIGITODD" | "DIGITEVEN";
  /** True when this trade fired during a Fast4 probe phase. */
  isProbe?: boolean;
  /** Fast4 phase-machine kind at dispatch (normal/probe/interleave/exit). */
  phaseKind?: "normal" | "probe" | "interleave" | "exit";
};
export type PaperResp = {
  stats: { startingBalance: number; balance: number; totalPnl: number; pnlPct: number;
    trades: number; wins: number; losses: number; winRate: number; avgR: number;
    peak: number; ddPct: number; open: number };
  startingBalance: number; balance: number;
  daily: Daily;
  open: PaperPosition[];
  adaptiveShift: AdaptiveShiftState;
};
export type EquityPoint = { ts: number; balance: number };

export type FastMartingaleSnapshot = {
  level: number;
  wins: number;
  losses: number;
  circuitBreakers: number;
  lastCircuitBreakerAt: number;
  nextStake: number;
};

export type FastSandboxConfig = {
  tradeMultiplier: number;
  martingaleMultiplier: number;
  baseStake: number;
  maxLevels: number;
  perTradeCap: number;
  commissionPct: number;
  entrySpreadBps: number;
  /** Adverse SL fill slippage in bps. Models Deriv's next-tick SL fill on
   *  synthetic spikes — a 5bps default means SL fills 0.05% past the stop. */
  slSlippageBps: number;
  /** UI override: when true, every strategy in the sandbox runs the martingale
   *  ladder regardless of its per-strategy `useMartingale` flag in the registry. */
  forceMartingale: boolean;
  /** Trade-side filter at signal routing. "both" lets every signal through. */
  sideFilter: "both" | "BUY" | "SELL";
  /** "classic" = escalate on loss, reset on win. "anti" = escalate on win,
   *  reset on loss (Paroli system). Telemetry counters always reflect actual
   *  outcomes; only the ladder advance behavior changes. */
  martingaleMode: "classic" | "anti";
  /** When true, this sandbox routes signals to LIVE trading (real money on
   *  Deriv) instead of paper. Sandbox-scoped — flipping Fast2 live keeps
   *  Fast on paper. */
  liveTradingEnabled: boolean;
  /** Per-strategy kill switch. Only meaningful in a perStrategy override:
   *  set to false to silence one strategy without removing it from the
   *  registry. Defaults to true/undefined (active). */
  enabled?: boolean;
  /** Trailing-exit (ratcheted TP). When true, the bot doesn't auto-close
   *  at designed TP; it tracks peak profit and exits when retraced. */
  trailingExitEnabled?: boolean;
  trailingArmPct?: number;
  trailingRetracePct?: number;
  perStrategy?: Record<string, Partial<FastSandboxConfig>>;
};
export type Fast1Config = FastSandboxConfig;
export type Fast2Config = FastSandboxConfig;

export type FastPaperResp = {
  stats: { startingBalance: number; balance: number; totalPnl: number; pnlPct: number;
    trades: number; wins: number; losses: number; winRate: number; avgR: number;
    peak: number; ddPct: number; open: number };
  startingBalance: number; balance: number;
  daily: Daily;
  open: PaperPosition[];
  martingale: Record<string, FastMartingaleSnapshot>;
  config: Fast1Config;
  /** Last-known close price per symbol with an open position. Used by the
   *  UI to render live unrealized P&L + SL/TP progress per row. */
  prices?: Record<string, number>;
};

export type Fast2PaperResp = Omit<FastPaperResp, "config"> & {
  config: Fast2Config;
  /** Last-known close price per symbol with an open position. Used by the
   *  UI to render live unrealized P&L + SL/TP progress per row. */
  prices?: Record<string, number>;
};
export type Fast3Config = FastSandboxConfig;
export type Fast3PaperResp = Omit<FastPaperResp, "config"> & {
  config: Fast3Config;
};
export type Fast4Config = FastSandboxConfig & {
  probeEnabled: boolean;
  lossStreakTrigger: number;
  /** Named probe pattern (see Fast4 panel dropdown values). May be a
   *  registry name OR an entry from `customPatterns`. */
  probePattern: string;
  /** Hard cap on ladder advancement (freeze level). 0 = disabled. */
  hardCap: number;
  /** User-saved custom probe patterns (raw strings). */
  customPatterns: string[];
  /** Trade-frequency throttle unit. */
  tradeIntervalUnit: "ticks" | "seconds";
  /** Trade-frequency throttle interval (>=1). */
  tradeInterval: number;
};
export type Fast4ProbeState = { baseLossStreak: number; probeRemaining: number; probesFired: number };
export type Fast4PaperResp = Omit<FastPaperResp, "config"> & {
  config: Fast4Config;
  /** Per-strategy probe-circuit state. Keys are strategy ids. */
  probeState?: Record<string, Fast4ProbeState>;
};

export type LogEntry = {
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error";
  msg: string;
  [key: string]: unknown;
};

export const api = {
  state: () => get<StateResp>("/api/state"),
  trades: (limit = 100, sandbox?: string) => get<{ trades: RealTrade[] }>(`/api/trades?limit=${limit}${sandbox ? `&sandbox=${sandbox}` : ""}`),
  signals: (limit = 100) => get<{ signals: Signal[] }>(`/api/signals?limit=${limit}`),
  strategies: () => get<{ strategies: StrategyStats[] }>("/api/strategies"),
  subscriptions: () => get<{ subscriptions: Subscription[] }>("/api/subscriptions"),
  config: () => get<{ config: Record<string, unknown> }>("/api/config"),
  candles: (symbol: string, granularity: number, limit = 500) =>
    get<{ symbol: string; granularity: number; candles: Candle[] }>(
      `/api/candles?symbol=${encodeURIComponent(symbol)}&granularity=${granularity}&limit=${limit}`,
    ),
  paper: () => get<PaperResp>("/api/paper"),
  paperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/paper/trades?limit=${limit}`),
  paperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/paper/equity"),
  // Fast-trade sandbox — own paper account, own martingale ladders, own
  // strategy registry.
  fastPaper: () => get<FastPaperResp>("/api/fast-paper"),
  fastPaperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/fast-paper/trades?limit=${limit}`),
  fastPaperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/fast-paper/equity"),
  fastStrategies: () => get<{ strategies: StrategyStats[]; martingale: Record<string, FastMartingaleSnapshot>; config: Fast1Config }>("/api/fast-strategies"),
  fastSignals: (limit = 100) => get<{ signals: Signal[] }>(`/api/fast-signals?limit=${limit}`),
  fastConfig: () => get<{ config: Fast1Config }>("/api/fast-config"),
  resetFastPaper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-fast-paper${balance ? `?balance=${balance}` : ""}`),
  updateFast1Config: (patch: Partial<Fast1Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast1-config?${p.toString()}`);
  },
  // Fast2 sandbox — independent of Fast: 3-strategy spike+drift stack with
  // user-selectable trade leverage (100/200/300/400/500) and martingale
  // multiplier (1.7/2.0/2.2). Own paper account, ladders, and config.
  fast2Paper: () => get<Fast2PaperResp>("/api/fast2-paper"),
  fast2PaperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/fast2-paper/trades?limit=${limit}`),
  fast2PaperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/fast2-paper/equity"),
  fast2Strategies: () => get<{ strategies: StrategyStats[]; martingale: Record<string, FastMartingaleSnapshot>; config: Fast2Config }>("/api/fast2-strategies"),
  fast2Signals: (limit = 100) => get<{ signals: Signal[] }>(`/api/fast2-signals?limit=${limit}`),
  fast2Config: () => get<{ config: Fast2Config }>("/api/fast2-config"),
  resetFast2Paper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-fast2-paper${balance ? `?balance=${balance}` : ""}`),
  updateFast2Config: (patch: Partial<Fast2Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "perStrategy") continue; // handled separately
      if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast2-config?${p.toString()}`);
  },
  /** Manually close an open Fast2 position. `mode` is "paper" or "live"
   *  depending on which sandbox owns the position. */
  closeFast2Position: (id: string, mode: "paper" | "live") => {
    const p = new URLSearchParams();
    p.set("id", id);
    p.set("mode", mode);
    return post<{ ok: boolean }>(`/api/control/close-fast2-position?${p.toString()}`);
  },
  /** Update or clear a per-strategy override under fast2Config.perStrategy.
   *  Pass `clear: true` to remove the override (strategy falls back to general). */
  updateFast2StrategyConfig: (strategyId: string, patch: Partial<Fast2Config> | null) => {
    const p = new URLSearchParams();
    p.set("strategyId", strategyId);
    if (patch === null) {
      p.set("clear", "1");
    } else {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "perStrategy" || k === "liveTradingEnabled") continue;
        if (typeof v === "boolean") p.set(k, String(v));
        else if (typeof v === "string") p.set(k, v);
        else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
      }
    }
    return post<{ ok: boolean }>(`/api/control/update-fast2-config?${p.toString()}`);
  },
  // ── Real-strategy book (silver/gold/plat candle book) runtime config ──
  realConfig: () => get<{ config: RealConfig }>("/api/real-config"),
  updateRealConfig: (patch: Partial<RealConfig>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (typeof v === "boolean") p.set(k, String(v));
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-real-config?${p.toString()}`);
  },
  // ── Fast3 (DIGITODD tick-level) ──
  fast3Paper: () => get<Fast3PaperResp>("/api/fast3-paper"),
  fast3PaperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/fast3-paper/trades?limit=${limit}`),
  fast3PaperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/fast3-paper/equity"),
  fast3Strategies: () => get<{ strategies: StrategyStats[]; martingale: Record<string, FastMartingaleSnapshot>; config: Fast3Config }>("/api/fast3-strategies"),
  fast3Config: () => get<{ config: Fast3Config }>("/api/fast3-config"),
  resetFast3Paper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-fast3-paper${balance ? `?balance=${balance}` : ""}`),
  updateFast3Config: (patch: Partial<Fast3Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "perStrategy") continue;
      if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast3-config?${p.toString()}`);
  },
  updateFast3StrategyConfig: (strategyId: string, patch: Partial<Fast3Config> | null) => {
    const p = new URLSearchParams();
    p.set("strategyId", strategyId);
    if (patch === null) {
      p.set("clear", "1");
    } else {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "perStrategy" || k === "liveTradingEnabled") continue;
        if (typeof v === "boolean") p.set(k, String(v));
        else if (typeof v === "string") p.set(k, v);
        else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
      }
    }
    return post<{ ok: boolean }>(`/api/control/update-fast3-config?${p.toString()}`);
  },
  // ── Fast4 (Fast3 + opposite-side probe circuit breaker) ──
  fast4Paper: () => get<Fast4PaperResp>("/api/fast4-paper"),
  fast4PaperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/fast4-paper/trades?limit=${limit}`),
  fast4PaperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/fast4-paper/equity"),
  fast4Strategies: () => get<{ strategies: StrategyStats[]; martingale: Record<string, FastMartingaleSnapshot>; config: Fast4Config }>("/api/fast4-strategies"),
  fast4Config: () => get<{ config: Fast4Config }>("/api/fast4-config"),
  resetFast4Paper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-fast4-paper${balance ? `?balance=${balance}` : ""}`),
  updateFast4Config: (patch: Partial<Fast4Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "perStrategy") continue;
      if (Array.isArray(v)) p.set(k, JSON.stringify(v));
      else if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast4-config?${p.toString()}`);
  },
  updateFast4StrategyConfig: (strategyId: string, patch: Partial<Fast4Config> | null) => {
    const p = new URLSearchParams();
    p.set("strategyId", strategyId);
    if (patch === null) {
      p.set("clear", "1");
    } else {
      for (const [k, v] of Object.entries(patch)) {
        if (k === "perStrategy" || k === "liveTradingEnabled") continue;
        if (typeof v === "boolean") p.set(k, String(v));
        else if (typeof v === "string") p.set(k, v);
        else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
      }
    }
    return post<{ ok: boolean }>(`/api/control/update-fast4-config?${p.toString()}`);
  },
  logs: (opts: { limit?: number; level?: string; q?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.limit) p.set("limit", String(opts.limit));
    if (opts.level) p.set("level", opts.level);
    if (opts.q) p.set("q", opts.q);
    const qs = p.toString();
    return get<{ logs: LogEntry[]; totalBuffered: number }>(`/api/logs${qs ? `?${qs}` : ""}`);
  },
  diag: () => get<{ diagnostics: Array<{ key: string; symbol: string; granularity: number; lastCandleAtMs: number | null; engine: { bars: number; lastEpoch: number | null; barIndex: number; atr: number; detectors: Record<string, { enabled: boolean; activeCount: number; unmitigatedCount: number }> } }> }>("/api/diag"),
  pause: () => post<{ ok: boolean }>("/api/control/pause"),
  resume: () => post<{ ok: boolean }>("/api/control/resume"),
  resetAdaptive: () => post<{ ok: boolean }>("/api/control/reset-adaptive"),
  resetDaily: () => post<{ ok: boolean }>("/api/control/reset-daily"),
  resetPaper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-paper${balance ? `?balance=${balance}` : ""}`),

  // ── Auth ────────────────────────────────────────────────────────────────
  authCheck: () => get<{ hasAdmin: boolean; authenticated: boolean }>("/api/auth/check"),
  authSetup: (username: string, password: string) =>
    postJson<{ ok: boolean; error?: string }>("/api/auth/setup", { username, password }),
  authLogin: (username: string, password: string) =>
    postJson<{ ok: boolean; error?: string }>("/api/auth/login", { username, password }),
  authLogout: () => post<{ ok: boolean }>("/api/auth/logout"),

  // ── Binance Futures ──────────────────────────────────────────────────────
  binanceState: () => get<{ hasCreds: boolean; running: boolean; state: any; testnet: boolean }>("/api/binance/state"),
  binanceSetCreds: (apiKey: string, apiSecret: string, testnet: boolean) =>
    postJson<{ ok: boolean; error?: string }>("/api/binance/set-creds", { apiKey, apiSecret, testnet }),
  binanceClearCreds: () => post<{ ok: boolean }>("/api/binance/clear-creds"),
  binanceTest: () => post<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string }>("/api/binance/test"),
  binanceStart: () => post<{ ok: boolean; error?: string }>("/api/binance/start"),
  binanceStop: () => post<{ ok: boolean }>("/api/binance/stop"),
  binanceConfig: () => get<{ config: BinanceConfig }>("/api/binance/config"),
  binanceUpdateConfig: (patch: Partial<BinanceConfig>) =>
    postJson<{ ok: boolean; config?: BinanceConfig; error?: string }>("/api/binance/update-config", patch),
  binanceCancelTrade: (tradeId: string) =>
    postJson<{ ok: boolean; error?: string }>("/api/binance/cancel-trade", { tradeId }),
  binanceWalletPnl: () =>
    get<{ realized: number; commission: number; unrealized: number; wallet: number; events: number; sinceMs: number }>("/api/binance/wallet-pnl"),
  binanceExternalPositions: () =>
    get<{ positions: Array<{
      symbol: string; positionSide: "LONG" | "SHORT";
      qty: number; entryPrice: number; markPrice: number;
      unRealizedProfit: number; leverage: number;
      liquidationPrice: number; updateTime: number;
      botQty: number; externalQty: number;
    }> }>("/api/binance/external-positions"),
  binanceCloseExternal: (symbol: string, side: "LONG" | "SHORT", qty: number) =>
    postJson<{ ok: boolean; error?: string }>("/api/binance/close-external", { symbol, side, qty }),
  binanceDiag: () => get<{ stateDir: string; stateDirExists: boolean; files: Array<{ file: string; exists: boolean; sizeBytes?: number; mtime?: string }>; note: string }>("/api/binance/diag"),

  // ── Binance Paper trading (parallel engine, no real exchange calls) ──
  binancePaperState: () =>
    get<{ running: boolean; state: any; paperWallet: number }>("/api/binance/paper/state"),
  binancePaperConfig: () => get<{ config: BinanceConfig }>("/api/binance/paper/config"),
  binancePaperStart: () => post<{ ok: boolean; error?: string }>("/api/binance/paper/start"),
  binancePaperStop: () => post<{ ok: boolean }>("/api/binance/paper/stop"),
  binancePaperUpdateConfig: (patch: Partial<BinanceConfig>) =>
    postJson<{ ok: boolean; config?: BinanceConfig; error?: string }>("/api/binance/paper/update-config", patch),
  binancePaperCancelTrade: (tradeId: string) =>
    postJson<{ ok: boolean; error?: string }>("/api/binance/paper/cancel-trade", { tradeId }),
  binancePaperResetWallet: (balance: number) =>
    postJson<{ ok: boolean }>("/api/binance/paper/reset-wallet", { balance }),
};

export type BinanceHfConfig = {
  enabled: boolean;
  stake: number;
  stakeMode?: "fixed" | "percent";
  stakePct?: number;
  leverage: number;
  allowMultiplePerKey: boolean;
  perPatternEnabled: { M1: boolean; M2: boolean; M3: boolean; M4: boolean; M5: boolean };
  perAssetEnabled: Record<string, boolean>;
};

export type BinanceMartingaleConfig = {
  mode: "off" | "anti";
  multiplier: number;
  maxLevels: number;
};

export type BinanceConfig = {
  stake: number;
  leverage: number;
  dailyMaxLoss: number;
  perTradeMaxStake: number;
  perAssetEnabled: Record<string, boolean>;
  perPatternEnabled: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean };
  autoStart?: boolean;
  martingale: BinanceMartingaleConfig;
  hf: BinanceHfConfig;
};

export function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

export function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

// ── EAT (East Africa Time, UTC+3) formatters for the Binance panels ──────
// Uses Intl with timeZone="Africa/Nairobi". Stable across DST changes
// (EAT has no DST, so practically: +03:00 always).
const EAT_TZ = "Africa/Nairobi";
export function fmtEatTime(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
    timeZone: EAT_TZ, hour: "2-digit", minute: "2-digit", hour12: false,
  });
}
export function fmtEatTimeSec(epochSec: number): string {
  if (!epochSec) return "—";
  return new Date(epochSec * 1000).toLocaleTimeString("en-GB", {
    timeZone: EAT_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}
export function fmtEatDateTime(epochSec: number): string {
  if (!epochSec) return "—";
  const d = new Date(epochSec * 1000);
  const date = d.toLocaleDateString("en-CA", { timeZone: EAT_TZ }); // YYYY-MM-DD
  const time = d.toLocaleTimeString("en-GB", { timeZone: EAT_TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  return `${date.slice(5)} ${time}`; // "MM-DD HH:MM"
}
export function eatToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: EAT_TZ });
}
export function eatDateOf(epochSec: number): string {
  return new Date(epochSec * 1000).toLocaleDateString("en-CA", { timeZone: EAT_TZ });
}
/** Reformat a server-side log ISO timestamp (UTC) into EAT HH:MM:SS. */
export function isoToEatHms(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(11, 19); // fallback
  return d.toLocaleTimeString("en-GB", { timeZone: EAT_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

export function fmtGranularity(gr: number): string {
  if (gr === 60) return "1m";
  if (gr === 300) return "5m";
  if (gr === 900) return "15m";
  if (gr === 1800) return "30m";
  if (gr === 3600) return "1h";
  if (gr === 14400) return "4h";
  if (gr === 86400) return "1d";
  return `${gr}s`;
}

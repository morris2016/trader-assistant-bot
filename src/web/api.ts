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
  detector: string;
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
};

export type Fast2PaperResp = Omit<FastPaperResp, "config"> & {
  config: Fast2Config;
};

export type LogEntry = {
  ts: string;
  level: "trace" | "debug" | "info" | "warn" | "error";
  msg: string;
  [key: string]: unknown;
};

export const api = {
  state: () => get<StateResp>("/api/state"),
  trades: (limit = 100) => get<{ trades: RealTrade[] }>(`/api/trades?limit=${limit}`),
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
  // Synth sandbox — completely isolated paper-trading for the 3 synth strategies
  synthPaper: () => get<PaperResp>("/api/synth-paper"),
  synthPaperTrades: (limit = 200) => get<{ trades: ClosedPaperPosition[] }>(`/api/synth-paper/trades?limit=${limit}`),
  synthPaperEquity: () => get<{ equity: EquityPoint[]; startingBalance: number }>("/api/synth-paper/equity"),
  synthStrategies: () => get<{ strategies: StrategyStats[] }>("/api/synth-strategies"),
  synthSignals: (limit = 100) => get<{ signals: Signal[] }>(`/api/synth-signals?limit=${limit}`),
  // Fast-trade sandbox — own paper account, own martingale ladders, own
  // strategy registry (CRASH500N + BOOM300N drift-fade scalping).
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
      if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
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
      if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast2-config?${p.toString()}`);
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
  resetSynthPaper: (balance?: number) => post<{ ok: boolean }>(`/api/control/reset-synth-paper${balance ? `?balance=${balance}` : ""}`),
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

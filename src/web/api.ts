// Tiny API client for the bot dashboard.
// Same-origin requests — no CORS, no base URL config.

export type AdaptiveShiftState = {
  consecLosses: number;
  buyHistory: ("W" | "L")[];
  sellHistory: ("W" | "L")[];
  metalsLossEpochs: number[];
  metalsThrottleUntil: number;
};

export type Daily = {
  date: string;
  profit: number;
  tradesOpened: number;
  capHit: boolean;
};

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

export const api = {
  state: () => get<StateResp>("/api/state"),
  trades: (limit = 100) => get<{ trades: RealTrade[] }>(`/api/trades?limit=${limit}`),
  signals: (limit = 100) => get<{ signals: Signal[] }>(`/api/signals?limit=${limit}`),
  pause: () => post<{ ok: boolean }>("/api/control/pause"),
  resume: () => post<{ ok: boolean }>("/api/control/resume"),
  resetAdaptive: () => post<{ ok: boolean }>("/api/control/reset-adaptive"),
  resetDaily: () => post<{ ok: boolean }>("/api/control/reset-daily"),
};

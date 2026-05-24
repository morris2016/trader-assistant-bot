// Binance Futures REST + WebSocket client.
//
// Handles:
//   - HMAC-SHA256 signing for authenticated REST endpoints
//   - WebSocket user-data stream (account updates, order fills, position changes)
//   - Public market klines fetch (for signal detection)
//   - listenKey lifecycle (create + keep-alive every 30 min)
//   - Auto-reconnect with exponential backoff
//   - Rate-limit aware (parse X-MBX-USED-WEIGHT headers, throttle if approaching cap)
//
// Two environments toggled by `testnet` flag:
//   - Live:    fapi.binance.com    / fstream.binance.com
//   - Testnet: testnet.binancefuture.com / stream.binancefuture.com

import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import WebSocket from "ws";

export type BinanceEnv = { testnet: boolean };
export type BinanceCreds = { apiKey: string; apiSecret: string };

const HOSTS = {
  live: { rest: "https://fapi.binance.com", ws: "wss://fstream.binance.com" },
  testnet: { rest: "https://testnet.binancefuture.com", ws: "wss://stream.binancefuture.com" },
};

export type OrderSide = "BUY" | "SELL";
export type PositionSide = "BOTH" | "LONG" | "SHORT";

export type Kline = { epoch: number; open: number; high: number; low: number; close: number; volume: number };

export type SymbolFilters = {
  stepSize: number;
  tickSize: number;
  minQty: number;
  minNotional: number;
  quantityPrecision: number;
  pricePrecision: number;
};

export type AccountBalance = { asset: string; balance: number; availableBalance: number };
export type Position = {
  symbol: string;
  positionAmt: number;
  entryPrice: number;
  unRealizedProfit: number;
  leverage: number;
  positionSide: PositionSide;
  markPrice: number;
  liquidationPrice: number;
  /** Server-side updateTime in epoch ms (when the position was last modified). */
  updateTime: number;
};

export type OrderResponse = {
  orderId: number;
  symbol: string;
  status: string;
  clientOrderId: string;
  price: string;
  avgPrice: string;
  origQty: string;
  executedQty: string;
  cumQuote: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: string;
  reduceOnly: boolean;
  closePosition: boolean;
  stopPrice?: string;
  updateTime: number;
};

export type UserDataEvent =
  | { e: "ACCOUNT_UPDATE"; T: number; a: { B: Array<{ a: string; wb: string; cw: string }>; P: Array<{ s: string; pa: string; ep: string; up: string; ps: PositionSide }> } }
  | { e: "ORDER_TRADE_UPDATE"; T: number; o: any }
  | { e: "MARGIN_CALL"; T: number; p: any[] }
  | { e: "listenKeyExpired"; E: number };

export type BinanceEvents = {
  userEvent: [UserDataEvent];
  connected: [];
  disconnected: [Error | null];
  error: [Error];
};

export class BinanceClient extends EventEmitter {
  private creds: BinanceCreds | null = null;
  private testnet = false;
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private wsClosedByUser = false;
  private reconnectAttempt = 0;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private serverTimeOffset = 0; // serverTime - localTime, in ms

  configure(creds: BinanceCreds | null, env: BinanceEnv) {
    this.creds = creds;
    this.testnet = env.testnet;
  }

  private hosts() { return this.testnet ? HOSTS.testnet : HOSTS.live; }

  // ─── Rate-limit / IP-ban suspension ──────────────────────────────────────
  // Production hit cascading HTTP 418 bans on 2026-05-24: bot kept hammering
  // the API during a ban, which extended it. Now: on 418/429, parse the
  // "banned until {epoch}" timestamp from the error body, store it, and
  // short-circuit every subsequent request until ban expires.
  private bannedUntilMs = 0;
  isBanned(): boolean { return Date.now() < this.bannedUntilMs; }
  bannedFor(): number { return Math.max(0, this.bannedUntilMs - Date.now()); }
  private parseBanUntil(body: string): number | null {
    // Body format: {"code":-1003,"msg":"Way too many requests; IP(x.x.x.x) banned until 1779621288626. ..."}
    const m = body.match(/banned until (\d+)/);
    return m ? +m[1] : null;
  }
  private throwIfBanned(method: string, path: string) {
    if (this.isBanned()) {
      throw new Error(`Binance ${method} ${path} suspended: IP banned for ${Math.ceil(this.bannedFor() / 1000)}s more`);
    }
  }

  // ─── Signing helpers ─────────────────────────────────────────────────────

  private sign(query: string): string {
    if (!this.creds?.apiSecret) throw new Error("No API secret configured");
    return createHmac("sha256", this.creds.apiSecret).update(query).digest("hex");
  }

  private async signedRequest(method: "GET" | "POST" | "PUT" | "DELETE", path: string, params: Record<string, string | number | boolean> = {}): Promise<any> {
    this.throwIfBanned(method, path);
    if (!this.creds?.apiKey) throw new Error("No API key configured");
    const timestamp = Date.now() + this.serverTimeOffset;
    const merged: Record<string, string | number | boolean> = { ...params, timestamp, recvWindow: 5000 };
    const query = Object.entries(merged)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const signature = this.sign(query);
    const url = `${this.hosts().rest}${path}?${query}&signature=${signature}`;
    const r = await fetch(url, {
      method,
      headers: { "X-MBX-APIKEY": this.creds.apiKey },
    });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 418 || r.status === 429) {
        const until = this.parseBanUntil(text);
        if (until) {
          this.bannedUntilMs = Math.max(this.bannedUntilMs, until + 5000); // +5s buffer
        } else {
          // No timestamp parsed — suspend for 60s as a safe default.
          this.bannedUntilMs = Math.max(this.bannedUntilMs, Date.now() + 60_000);
        }
      }
      throw new Error(`Binance ${method} ${path} HTTP ${r.status}: ${text}`);
    }
    return r.json();
  }

  private async publicRequest(method: "GET", path: string, params: Record<string, string | number> = {}): Promise<any> {
    this.throwIfBanned(method, path);
    const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
    const url = `${this.hosts().rest}${path}${query ? "?" + query : ""}`;
    const r = await fetch(url, { method });
    if (!r.ok) {
      const text = await r.text();
      if (r.status === 418 || r.status === 429) {
        const until = this.parseBanUntil(text);
        if (until) {
          this.bannedUntilMs = Math.max(this.bannedUntilMs, until + 5000);
        } else {
          this.bannedUntilMs = Math.max(this.bannedUntilMs, Date.now() + 60_000);
        }
      }
      throw new Error(`Binance ${method} ${path} HTTP ${r.status}: ${text}`);
    }
    return r.json();
  }

  // ─── Time sync ───────────────────────────────────────────────────────────

  async syncTime() {
    const r = await this.publicRequest("GET", "/fapi/v1/time");
    this.serverTimeOffset = (r.serverTime as number) - Date.now();
  }

  // ─── Account / balance ───────────────────────────────────────────────────

  async getBalances(): Promise<AccountBalance[]> {
    const data = await this.signedRequest("GET", "/fapi/v2/balance");
    return (data as any[]).map(b => ({ asset: b.asset, balance: +b.balance, availableBalance: +b.availableBalance }));
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.signedRequest("GET", "/fapi/v2/positionRisk");
    return (data as any[]).map(p => ({
      symbol: p.symbol, positionAmt: +p.positionAmt, entryPrice: +p.entryPrice,
      unRealizedProfit: +p.unRealizedProfit, leverage: +p.leverage, positionSide: p.positionSide,
      markPrice: +p.markPrice, liquidationPrice: +p.liquidationPrice,
      updateTime: +p.updateTime,
    }));
  }

  /** Sum of REALIZED_PNL and COMMISSION income since `sinceMs`. Returns net
   *  realized P&L (income minus commissions). Used by the UI to show
   *  wallet-truth daily P&L instead of the bot's local `closed[]` view which
   *  misses external cancellations. */
  async getRealizedIncomeSince(sinceMs: number): Promise<{ realizedPnl: number; commission: number; events: number }> {
    let realizedPnl = 0, commission = 0, events = 0;
    for (const incomeType of ["REALIZED_PNL", "COMMISSION"]) {
      const data = await this.signedRequest("GET", "/fapi/v1/income", { incomeType, startTime: sinceMs, limit: 1000 });
      for (const ev of (data as any[])) {
        events++;
        if (incomeType === "REALIZED_PNL") realizedPnl += +ev.income;
        else commission += +ev.income; // commission is negative
      }
    }
    return { realizedPnl, commission, events };
  }

  /** Per-event income history since `sinceMs`. Returns the raw events so the
   *  caller can attribute REALIZED_PNL/COMMISSION to specific trades by
   *  symbol+time window. Used by the engine's income reconciler to backfill
   *  exchange-truth P&L on trades the user-data stream missed. */
  async getIncomeHistory(sinceMs: number): Promise<Array<{ symbol: string; incomeType: string; income: number; timeMs: number; info: string; tradeId: string }>> {
    const out: Array<{ symbol: string; incomeType: string; income: number; timeMs: number; info: string; tradeId: string }> = [];
    for (const incomeType of ["REALIZED_PNL", "COMMISSION"]) {
      const data = await this.signedRequest("GET", "/fapi/v1/income", { incomeType, startTime: sinceMs, limit: 1000 });
      for (const ev of (data as any[])) {
        out.push({
          symbol: ev.symbol ?? "",
          incomeType: ev.incomeType ?? incomeType,
          income: +ev.income,
          timeMs: +ev.time,
          info: ev.info ?? "",
          tradeId: ev.tradeId ?? "",
        });
      }
    }
    return out;
  }

  // ─── Market data ─────────────────────────────────────────────────────────

  /** Per-symbol filters: rounding rules for quantity, price, and minimum
   *  notional. Cached on first call; refresh on rate-limit / mismatch. */
  async getExchangeInfo(): Promise<Record<string, SymbolFilters>> {
    const data = await this.publicRequest("GET", "/fapi/v1/exchangeInfo");
    const out: Record<string, SymbolFilters> = {};
    for (const s of (data as any).symbols ?? []) {
      const lot = s.filters.find((f: any) => f.filterType === "LOT_SIZE");
      const price = s.filters.find((f: any) => f.filterType === "PRICE_FILTER");
      const minNotional = s.filters.find((f: any) => f.filterType === "MIN_NOTIONAL");
      out[s.symbol] = {
        stepSize: lot ? +lot.stepSize : 0.001,
        tickSize: price ? +price.tickSize : 0.01,
        minQty: lot ? +lot.minQty : 0,
        minNotional: minNotional ? +minNotional.notional : 0,
        quantityPrecision: s.quantityPrecision ?? 3,
        pricePrecision: s.pricePrecision ?? 2,
      };
    }
    return out;
  }

  async getKlines(symbol: string, interval: string, limit = 500, endTime?: number): Promise<Kline[]> {
    const params: Record<string, string | number> = { symbol, interval, limit };
    if (endTime) params.endTime = endTime;
    const data = await this.publicRequest("GET", "/fapi/v1/klines", params);
    return (data as any[][]).map(k => ({
      epoch: Math.floor(Number(k[0]) / 1000),
      open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
    }));
  }

  // ─── Orders ──────────────────────────────────────────────────────────────

  async setLeverage(symbol: string, leverage: number) {
    return this.signedRequest("POST", "/fapi/v1/leverage", { symbol, leverage });
  }

  async setMarginType(symbol: string, marginType: "ISOLATED" | "CROSSED") {
    try {
      return await this.signedRequest("POST", "/fapi/v1/marginType", { symbol, marginType });
    } catch (e: any) {
      // -4046 = "No need to change margin type" — safe to ignore
      if (!/4046/.test(String(e?.message ?? ""))) throw e;
      return null;
    }
  }

  async placeMarketOrder(opts: { symbol: string; side: OrderSide; quantity: number; positionSide?: PositionSide; reduceOnly?: boolean; clientOrderId?: string }): Promise<OrderResponse> {
    const params: Record<string, string | number | boolean> = {
      symbol: opts.symbol, side: opts.side, type: "MARKET", quantity: opts.quantity,
    };
    if (opts.positionSide) params.positionSide = opts.positionSide;
    if (opts.reduceOnly && opts.positionSide !== "LONG" && opts.positionSide !== "SHORT") params.reduceOnly = "true";
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;
    return this.signedRequest("POST", "/fapi/v1/order", params);
  }

  async placeStopMarketTP(opts: { symbol: string; side: OrderSide; stopPrice: number; quantity: number; positionSide?: PositionSide; clientOrderId?: string }): Promise<OrderResponse> {
    // STOP_MARKET in the trail direction, with reduceOnly + closePosition=false (only close `quantity`)
    const params: Record<string, string | number | boolean> = {
      symbol: opts.symbol, side: opts.side, type: "STOP_MARKET",
      stopPrice: opts.stopPrice, quantity: opts.quantity,
      reduceOnly: "true", workingType: "MARK_PRICE", timeInForce: "GTC",
    };
    if (opts.positionSide) {
      params.positionSide = opts.positionSide;
      delete params.reduceOnly; // hedge mode rejects reduceOnly w/ positionSide
    }
    if (opts.clientOrderId) params.newClientOrderId = opts.clientOrderId;
    return this.signedRequest("POST", "/fapi/v1/order", params);
  }

  async cancelOrder(symbol: string, orderId: number): Promise<OrderResponse> {
    return this.signedRequest("DELETE", "/fapi/v1/order", { symbol, orderId });
  }

  async cancelAllOrders(symbol: string) {
    return this.signedRequest("DELETE", "/fapi/v1/allOpenOrders", { symbol });
  }

  // ─── User data stream (WebSocket) ────────────────────────────────────────

  async startUserDataStream() {
    const r = await this.signedRequest("POST", "/fapi/v1/listenKey");
    this.listenKey = (r as any).listenKey;
    this.connectWS();
    this.startKeepAlive();
  }

  private connectWS() {
    if (!this.listenKey) return;
    this.wsClosedByUser = false;
    const url = `${this.hosts().ws}/ws/${this.listenKey}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("connected");
    });
    ws.on("message", (raw) => {
      try {
        const ev = JSON.parse(String(raw)) as UserDataEvent;
        this.emit("userEvent", ev);
      } catch (e) {
        this.emit("error", e as Error);
      }
    });
    ws.on("close", () => {
      this.ws = null;
      this.emit("disconnected", null);
      if (!this.wsClosedByUser) this.scheduleReconnect();
    });
    ws.on("error", (e) => {
      this.emit("error", e as Error);
    });
  }

  private scheduleReconnect() {
    const delay = Math.min(30_000, 1000 * Math.pow(2, this.reconnectAttempt++));
    setTimeout(() => this.connectWS(), delay);
  }

  private startKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = setInterval(async () => {
      try { await this.signedRequest("PUT", "/fapi/v1/listenKey"); } catch (e) { this.emit("error", e as Error); }
    }, 30 * 60 * 1000); // every 30 minutes (key expires after 60)
  }

  async stop() {
    this.wsClosedByUser = true;
    if (this.keepAliveTimer) { clearInterval(this.keepAliveTimer); this.keepAliveTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    if (this.listenKey) {
      try { await this.signedRequest("DELETE", "/fapi/v1/listenKey"); } catch {}
      this.listenKey = null;
    }
  }

  on<K extends keyof BinanceEvents>(event: K, listener: (...args: BinanceEvents[K]) => void): this { return super.on(event, listener as any); }
  emit<K extends keyof BinanceEvents>(event: K, ...args: BinanceEvents[K]): boolean { return super.emit(event, ...args); }
}

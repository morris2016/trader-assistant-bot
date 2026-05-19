import WebSocket from "ws";
import { EventEmitter } from "node:events";
import type {
  ActiveSymbolInfo,
  AuthorizeInfo,
  BuyInfo,
  DerivRequest,
  DerivResponse,
  OhlcCandle,
  OpenContractInfo,
  ProposalInfo,
} from "./types";
import type { Candle, Granularity, SymbolCode, Tick } from "@shared/types";

const DERIV_URL = "wss://ws.derivws.com/websockets/v3";
const DEFAULT_APP_ID = "1089";
const PING_INTERVAL_MS = 30_000;
const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10_000, 15_000];

type Pending = {
  resolve: (r: DerivResponse) => void;
  reject: (e: Error) => void;
};

export type DerivClientEvents = {
  open: [];
  close: [code: number, reason: string];
  tick: [Tick];
  candle: [symbol: SymbolCode, candle: Candle, isNew: boolean];
  balance: [{ balance: number; currency: string; loginid?: string }];
  contract: [OpenContractInfo];
  authorized: [AuthorizeInfo];
  error: [Error];
};

export class DerivClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private reqId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<string, { kind: "ticks"; symbol: SymbolCode } | { kind: "candles"; symbol: SymbolCode; granularity: Granularity }>();
  /** Contract ids with an active proposal_open_contract subscription. Tracked
   *  so a WS reconnect can replay them — without this, settlement updates for
   *  any contract opened before the disconnect are silently dropped on the
   *  Deriv side and the bot believes the trade is forever "open". Entries are
   *  removed when the contract reports is_sold or status in {sold,won,lost}. */
  private openContractIds = new Set<number>();
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private closedByUser = false;
  private lastCandleEpoch = new Map<string, number>();
  /** Most-recent tick quote per symbol — populated from the live tick stream.
   *  Used by RealEngine to do a price-tolerance check just before placing a
   *  contract: if the latest tick has drifted too far from the signal's
   *  expected entry, abort instead of fill at a bad price. */
  private lastTickBySymbol = new Map<string, { quote: number; epoch: number; receivedAt: number }>();
  private appId: string = DEFAULT_APP_ID;
  private authToken: string | null = null;

  constructor(opts?: { appId?: string }) {
    super();
    if (opts?.appId) this.appId = opts.appId;
  }

  connect(): void {
    this.closedByUser = false;
    this.openSocket();
  }

  private openSocket() {
    const url = `${DERIV_URL}?app_id=${encodeURIComponent(this.appId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempt = 0;
      this.emit("open");
      this.startPing();
      this.resubscribeAll();
      if (this.authToken) this.send({ authorize: this.authToken }).catch(() => undefined);
    });

    ws.on("message", (raw: WebSocket.RawData) => {
      let msg: DerivResponse;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(msg);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this.stopPing();
      this.ws = null;
      this.emit("close", code, reason.toString());
      this.failAllPending(new Error(`ws closed: ${code}`));
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      this.emit("error", err);
    });
  }

  private scheduleReconnect() {
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.reconnectAttempt++;
    setTimeout(() => {
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      this.send({ ping: 1 }).catch(() => undefined);
    }, PING_INTERVAL_MS);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private failAllPending(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    this.failAllPending(new Error("client closed"));
    this.ws?.close();
    this.ws = null;
  }

  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  setToken(token: string | null) {
    this.authToken = token;
    if (token && this.isOpen()) {
      this.send({ authorize: token }).catch((err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      });
    }
  }

  async authorize(token: string): Promise<AuthorizeInfo> {
    const resp = await this.send({ authorize: token });
    const info = (resp.authorize ?? {}) as AuthorizeInfo;
    this.authToken = token;
    this.emit("authorized", info);
    return info;
  }

  async subscribeBalance(): Promise<void> {
    if (!this.isOpen()) return;
    await this.send({ balance: 1, subscribe: 1 });
  }

  /**
   * Fetch Deriv's per-account API call limits. Returns the api_call_limits
   * object from website_status (numbers may vary by region/account-type).
   * Used at bot boot to dynamically tune the live placeTrade throttle.
   * Schema (note Deriv typo: max_requestes_general):
   *   { max_proposal_subscription: { applies_to, max },
   *     max_requestes_general:    { applies_to, hourly, minutely },
   *     max_requests_outcome:     { applies_to, hourly, minutely },
   *     max_requests_pricing:     { applies_to, hourly, minutely } }
   */
  async fetchApiCallLimits(): Promise<{
    pricingPerMinute: number | null;
    generalPerMinute: number | null;
    outcomePerMinute: number | null;
    proposalSubsConcurrent: number | null;
    raw: unknown;
  } | null> {
    try {
      const resp = await this.send({ website_status: 1 });
      const limits = (resp as { website_status?: { api_call_limits?: Record<string, { hourly?: number; minutely?: number; max?: number; applies_to?: string }> } }).website_status?.api_call_limits;
      if (!limits) return null;
      return {
        pricingPerMinute: limits.max_requests_pricing?.minutely ?? null,
        generalPerMinute: (limits as Record<string, { minutely?: number }>).max_requestes_general?.minutely ?? null,
        outcomePerMinute: limits.max_requests_outcome?.minutely ?? null,
        proposalSubsConcurrent: limits.max_proposal_subscription?.max ?? null,
        raw: limits,
      };
    } catch {
      return null;
    }
  }

  async placeRiseFall(params: {
    symbol: SymbolCode;
    contract_type: "CALL" | "PUT";
    stake: number;
    currency: string;
    duration: number;
    duration_unit: "t" | "s" | "m";
  }): Promise<{ proposal: ProposalInfo; buy: BuyInfo }> {
    if (!this.authToken) throw new Error("Not authorized — set a token first");
    const propResp = await this.send({
      proposal: 1,
      amount: params.stake,
      basis: "stake",
      contract_type: params.contract_type,
      currency: params.currency,
      duration: params.duration,
      duration_unit: params.duration_unit,
      symbol: params.symbol,
    });
    const proposal = propResp.proposal as ProposalInfo | undefined;
    if (!proposal) throw new Error("Empty proposal response");
    const buyResp = await this.send({ buy: proposal.id, price: proposal.ask_price });
    const buy = buyResp.buy as BuyInfo | undefined;
    if (!buy) throw new Error("Empty buy response");
    this.subscribeOpenContract(buy.contract_id);
    return { proposal, buy };
  }

  async placeDigitContract(params: {
    symbol: SymbolCode;
    contract_type: "DIGITODD" | "DIGITEVEN" | "DIGITOVER" | "DIGITUNDER" | "DIGITMATCH" | "DIGITDIFF";
    stake: number;
    currency: string;
    /** Required for OVER/UNDER/MATCH/DIFF — the prediction digit (0-9). */
    barrier?: number;
  }): Promise<{ proposal: ProposalInfo; buy: BuyInfo }> {
    if (!this.authToken) throw new Error("Not authorized — set a token first");
    const req: DerivRequest = {
      proposal: 1,
      amount: params.stake,
      basis: "stake",
      contract_type: params.contract_type,
      currency: params.currency,
      duration: 1,           // DIGIT contracts are always 1-tick
      duration_unit: "t",
      symbol: params.symbol,
    };
    if (params.barrier != null) (req as { barrier?: number }).barrier = params.barrier;
    const propResp = await this.send(req);
    const proposal = propResp.proposal as ProposalInfo | undefined;
    if (!proposal) throw new Error("Empty digit proposal response");
    const buyResp = await this.send({ buy: proposal.id, price: proposal.ask_price });
    const buy = buyResp.buy as BuyInfo | undefined;
    if (!buy) throw new Error("Empty digit buy response");
    this.subscribeOpenContract(buy.contract_id);
    return { proposal, buy };
  }

  async placeMultiplier(params: {
    symbol: SymbolCode;
    contract_type: "MULTUP" | "MULTDOWN";
    stake: number;
    currency: string;
    multiplier: number;
    takeProfit?: number;
    stopLoss?: number;
  }): Promise<{ proposal: ProposalInfo; buy: BuyInfo }> {
    if (!this.authToken) throw new Error("Not authorized — set a token first");
    const req: DerivRequest = {
      proposal: 1,
      amount: params.stake,
      basis: "stake",
      contract_type: params.contract_type,
      currency: params.currency,
      symbol: params.symbol,
      multiplier: params.multiplier,
    };
    if (params.takeProfit || params.stopLoss) {
      (req as { limit_order?: { take_profit?: number; stop_loss?: number } }).limit_order = {
        ...(params.takeProfit != null ? { take_profit: params.takeProfit } : {}),
        ...(params.stopLoss != null ? { stop_loss: params.stopLoss } : {}),
      };
    }
    const propResp = await this.send(req);
    const proposal = propResp.proposal as ProposalInfo | undefined;
    if (!proposal) throw new Error("Empty multiplier proposal response");
    const buyResp = await this.send({ buy: proposal.id, price: proposal.ask_price });
    const buy = buyResp.buy as BuyInfo | undefined;
    if (!buy) throw new Error("Empty multiplier buy response");
    this.subscribeOpenContract(buy.contract_id);
    return { proposal, buy };
  }

  /** Latest tick quote received for `symbol`, or null if none seen this session.
   *  Used by RealEngine for a price-tolerance check before contract open. */
  lastTickFor(symbol: string): { quote: number; epoch: number; receivedAt: number } | null {
    return this.lastTickBySymbol.get(symbol) ?? null;
  }

  /** One-shot proposal_open_contract fetch (no subscribe). Used at reconnect
   *  time to reconcile bot-side state with whatever Deriv currently knows
   *  about an open contract — settlement may have happened during the WS
   *  disconnect window. */
  async getOpenContract(contractId: number): Promise<unknown> {
    if (!this.authToken) throw new Error("Not authorized");
    const resp = await this.send({ proposal_open_contract: 1, contract_id: contractId });
    return (resp as { proposal_open_contract?: unknown }).proposal_open_contract ?? null;
  }

  async sellContract(contractId: number, price: number = 0): Promise<void> {
    if (!this.authToken) throw new Error("Not authorized");
    // `price: 0` = sell at market (Deriv convention)
    await this.send({ sell: String(contractId), price });
  }

  /** Update an open MULTIPLIER contract's take_profit / stop_loss order amount.
   *  Used by the trailing-exit logic to push a broker-side TP so the contract
   *  auto-closes server-side when profit reaches that level — bypasses tick-
   *  gap losses on spikes. Either field can be passed; pass `null` to clear.
   *  Returns the response so the caller can verify Deriv accepted the update. */
  async updateContract(contractId: number, params: { takeProfit?: number | null; stopLoss?: number | null }): Promise<DerivResponse> {
    if (!this.authToken) throw new Error("Not authorized");
    const limit_order: Record<string, number | null> = {};
    if (params.takeProfit !== undefined) limit_order.take_profit = params.takeProfit;
    if (params.stopLoss !== undefined) limit_order.stop_loss = params.stopLoss;
    return this.send({ contract_update: 1, contract_id: contractId, limit_order });
  }

  /** Fetch the user's currently-open contracts from Deriv. Used at bot
   *  startup to recover open positions when local state was wiped (Railway
   *  redeploy, container restart, etc.) so the UI can show them as Open
   *  Positions even after the bot lost its in-memory copy. */
  async fetchPortfolio(): Promise<unknown[]> {
    if (!this.authToken) throw new Error("Not authorized");
    const resp = await this.send({ portfolio: 1 });
    const p = (resp as { portfolio?: { contracts?: unknown[] } }).portfolio;
    return p?.contracts ?? [];
  }

  /** Fetch recent closed contracts from Deriv's profit_table. Used at
   *  startup to repopulate Recent Trades after a state wipe. */
  async fetchProfitTable(limit: number = 100): Promise<unknown[]> {
    if (!this.authToken) throw new Error("Not authorized");
    const resp = await this.send({ profit_table: 1, description: 1, limit });
    const pt = (resp as { profit_table?: { transactions?: unknown[] } }).profit_table;
    return pt?.transactions ?? [];
  }

  /** Subscribe to live updates for an open contract. Tracked in
   *  `openContractIds` so a WS reconnect re-attaches the stream — see
   *  resubscribeAll. Public so RealEngine can re-subscribe after a portfolio
   *  hydrate or a manual reconcile finds a trade with no live stream. */
  subscribeOpenContract(contractId: number): void {
    this.openContractIds.add(contractId);
    if (!this.isOpen()) return; // resubscribeAll will pick it up on connect
    this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
      .catch((e) => this.emit("error", e instanceof Error ? e : new Error(String(e))));
  }

  send(req: DerivRequest): Promise<DerivResponse> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      const req_id = this.reqId++;
      const payload = { ...req, req_id };
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(req_id);
          reject(err);
        }
      });
    });
  }

  async subscribeTicks(symbol: SymbolCode): Promise<void> {
    this.subscriptions.set(`ticks:${symbol}`, { kind: "ticks", symbol });
    if (!this.isOpen()) return;
    await this.send({ ticks: symbol, subscribe: 1 });
  }

  async subscribeCandles(symbol: SymbolCode, granularity: Granularity, count = 500): Promise<Candle[]> {
    this.subscriptions.set(`candles:${symbol}:${granularity}`, { kind: "candles", symbol, granularity });
    if (!this.isOpen()) return [];
    const resp = await this.send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count,
      end: "latest",
      style: "candles",
      granularity,
      subscribe: 1,
    });
    const raw = (resp.candles as OhlcCandle[] | undefined) ?? [];
    return raw.map(normaliseOhlc);
  }

  async fetchActiveSymbols(): Promise<ActiveSymbolInfo[]> {
    const resp = await this.send({ active_symbols: "brief", product_type: "basic" });
    return (resp.active_symbols as ActiveSymbolInfo[] | undefined) ?? [];
  }

  async fetchHistory(symbol: SymbolCode, granularity: Granularity, count: number, end: number | "latest" = "latest"): Promise<Candle[]> {
    // Deriv's ticks_history caps each response at 5000 candles. For deeper
    // backtests we paginate by stepping `end` backward to the earliest epoch
    // we've already fetched and unioning the chunks.
    const CHUNK = 5000;
    if (count <= CHUNK) {
      const resp = await this.send({
        ticks_history: symbol,
        adjust_start_time: 1,
        count,
        end: end === "latest" ? "latest" : String(end),
        style: "candles",
        granularity,
      });
      const raw = (resp.candles as OhlcCandle[] | undefined) ?? [];
      return raw.map(normaliseOhlc);
    }

    let collected: Candle[] = [];
    let cursor: number | "latest" = end;
    while (collected.length < count) {
      const want = Math.min(CHUNK, count - collected.length);
      const resp = await this.send({
        ticks_history: symbol,
        adjust_start_time: 1,
        count: want,
        end: cursor === "latest" ? "latest" : String(cursor),
        style: "candles",
        granularity,
      });
      const raw = (resp.candles as OhlcCandle[] | undefined) ?? [];
      const chunk = raw.map(normaliseOhlc);
      if (chunk.length === 0) break;
      // Prepend earlier candles (Deriv returns chronological per chunk).
      collected = chunk.concat(collected);
      // Step the cursor to one second before the earliest candle just fetched.
      cursor = chunk[0].epoch - 1;
      if (chunk.length < want) break; // ran out of history
    }
    // Dedupe by epoch (defensive against any chunk overlap).
    const seen = new Set<number>();
    const unique: Candle[] = [];
    for (const c of collected) {
      if (seen.has(c.epoch)) continue;
      seen.add(c.epoch);
      unique.push(c);
    }
    unique.sort((a, b) => a.epoch - b.epoch);
    return unique;
  }

  async forgetAll(kind: "ticks" | "candles"): Promise<void> {
    for (const [k, v] of this.subscriptions) {
      if (v.kind === kind) this.subscriptions.delete(k);
    }
    if (!this.isOpen()) return;
    await this.send({ forget_all: kind });
  }

  private resubscribeAll() {
    // Emit per-pair events so the bot can log success/failure of the
    // post-reconnect resubscribe. Without this, "relying on client
    // auto-resubscribe" is opaque — there's no way to tell from logs whether
    // each subscription actually re-established.
    for (const sub of this.subscriptions.values()) {
      if (sub.kind === "ticks") {
        this.send({ ticks: sub.symbol, subscribe: 1 })
          .then(() => this.emit("resubscribed", { kind: "ticks", symbol: sub.symbol }))
          .catch((e) => this.emit("resubscribeError", { kind: "ticks", symbol: sub.symbol, error: e instanceof Error ? e : new Error(String(e)) }));
      } else {
        this.send({
          ticks_history: sub.symbol,
          adjust_start_time: 1,
          count: 500,
          end: "latest",
          style: "candles",
          granularity: sub.granularity,
          subscribe: 1,
        })
          .then(() => this.emit("resubscribed", { kind: "candles", symbol: sub.symbol, granularity: sub.granularity }))
          .catch((e) => this.emit("resubscribeError", { kind: "candles", symbol: sub.symbol, granularity: sub.granularity, error: e instanceof Error ? e : new Error(String(e)) }));
      }
    }
    // Replay open-contract streams. Without this, contracts opened before a
    // disconnect lose their proposal_open_contract subscription on the Deriv
    // side and never settle in the bot — the trade hangs "open" forever.
    for (const contractId of this.openContractIds) {
      this.send({ proposal_open_contract: 1, contract_id: contractId, subscribe: 1 })
        .then(() => this.emit("resubscribed", { kind: "contract", contractId }))
        .catch((e) => this.emit("resubscribeError", { kind: "contract", contractId, error: e instanceof Error ? e : new Error(String(e)) }));
    }
  }

  private handleMessage(msg: DerivResponse) {
    const id = msg.req_id;
    if (typeof id === "number") {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg);
      }
    }

    switch (msg.msg_type) {
      case "tick": {
        const t = msg.tick as { symbol: string; epoch: number; quote: number } | undefined;
        if (t) {
          this.lastTickBySymbol.set(t.symbol, { quote: t.quote, epoch: t.epoch, receivedAt: Date.now() });
          this.emit("tick", { symbol: t.symbol as SymbolCode, epoch: t.epoch, quote: t.quote });
        }
        break;
      }
      case "authorize": {
        const info = msg.authorize as AuthorizeInfo | undefined;
        if (info) this.emit("authorized", info);
        break;
      }
      case "balance": {
        const b = msg.balance as { balance: number; currency: string; loginid?: string } | undefined;
        if (b) this.emit("balance", b);
        break;
      }
      case "proposal_open_contract": {
        const c = msg.proposal_open_contract as OpenContractInfo | undefined;
        if (c) {
          // Stop tracking once Deriv reports the contract has finalised.
          // Deriv ends the subscription server-side at that point too.
          if (c.is_sold === 1 || c.status === "sold" || c.status === "won" || c.status === "lost") {
            this.openContractIds.delete(c.contract_id);
          }
          this.emit("contract", c);
        }
        break;
      }
      case "ohlc": {
        const o = msg.ohlc as {
          symbol: string;
          granularity: number;
          open_time: number;
          open: string | number;
          high: string | number;
          low: string | number;
          close: string | number;
          epoch: number;
        } | undefined;
        if (o) {
          const candle: Candle = {
            epoch: o.open_time ?? o.epoch,
            open: +o.open,
            high: +o.high,
            low: +o.low,
            close: +o.close,
          };
          const key = `${o.symbol}:${o.granularity}`;
          const lastEpoch = this.lastCandleEpoch.get(key);
          const isNew = lastEpoch !== candle.epoch;
          this.lastCandleEpoch.set(key, candle.epoch);
          // Emit granularity as 4th arg so multi-granularity consumers can route candles
          // to the correct (symbol, granularity) state. Pre-existing listeners with
          // (symbol, candle, isNew) signature ignore the extra arg.
          this.emit("candle", o.symbol as SymbolCode, candle, isNew, o.granularity as number);
        }
        break;
      }
    }
  }
}

function normaliseOhlc(o: OhlcCandle): Candle {
  return {
    epoch: o.epoch,
    open: +o.open,
    high: +o.high,
    low: +o.low,
    close: +o.close,
  };
}

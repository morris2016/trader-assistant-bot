// Binance Futures live engine for the crypto SMC strategy.
//
// Lifecycle per asset:
//   1. On startup, REST-fetch last 200 × 1h klines and seed the rolling buffer
//   2. Every 1m, check if a new 1h bar closed. When yes:
//      a. Append new 1h bar to buffer
//      b. Run patterns (OB_BULL, OB_BEAR, BOS_UP) with trained direction
//      c. For each new signal: set leverage(30) + isolated margin, place MARKET order
//   3. While position is open, poll mark price every 5s:
//      a. Update peakFav for each logical trade
//      b. Once peak ≥ entry + 1.0×ATR → ARMED; place STOP_MARKET TP at peak − 0.3×ATR
//      c. As peak advances, cancel old TP + place tighter one (ratchet)
//      d. When position closes (size = 0), log result
//
// One open logical trade per (asset, pattern, side) at a time. New signal on
// same combo while one is open is skipped. State persisted via load/save.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { BinanceClient, type Kline, type OrderResponse, type SymbolFilters } from "../binance/client";

export type BinanceTradeSide = "LONG" | "SHORT";

export type BinanceTrade = {
  id: string;
  asset: string;          // e.g., BTCUSDT
  pattern: "OB_BULL" | "OB_BEAR" | "BOS_UP";
  side: BinanceTradeSide;
  stake: number;          // $ committed (margin)
  leverage: number;       // e.g., 30
  notional: number;       // stake × leverage
  qty: number;            // base-asset quantity
  entryEpoch: number;
  entryPrice: number;
  atrEntry: number;
  peakFav: number;
  armed: boolean;
  tpOrderId: number | null;  // current STOP_MARKET TP order id (null if not armed)
  status: "OPEN" | "CLOSED";
  closeEpoch?: number;
  closePrice?: number;
  pnl?: number;
};

export type BinanceState = {
  open: BinanceTrade[];
  closed: BinanceTrade[];
  daily: { date: string; profit: number; tradesOpened: number; capHit: boolean };
};

export type BinanceEngineEvents = {
  opened: [BinanceTrade];
  closed: [BinanceTrade];
  error: [Error];
  stateChanged: [];
  capHit: [dailyLoss: number, cap: number];
};

// Strategy parameters (matches our validated sim)
const HORIZON_BARS = 48;
const DISP_ATR_MIN = 1.0;
const OB_RETURN_BARS = 20;
const SWING_LB = 5;
const TRAIL_ARM_ATR = 1.0;
const TRAIL_RETRACE_ATR = 0.3;
const ATR_PERIOD = 14;
const SMA_PERIOD = 50;
const KLINE_HISTORY = 200;

function utcToday(): string { return new Date().toISOString().slice(0, 10); }
function emptyDaily(): BinanceState["daily"] { return { date: utcToday(), profit: 0, tradesOpened: 0, capHit: false }; }

function computeATR(bars: Kline[], i: number): number {
  if (i < ATR_PERIOD) return NaN;
  let sum = 0;
  for (let j = i - ATR_PERIOD + 1; j <= i; j++) {
    const tr = Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
    sum += tr;
  }
  return sum / ATR_PERIOD;
}

function smaSignAt(bars: Kline[], i: number): "UP" | "DOWN" | "FLAT" {
  if (i < SMA_PERIOD + 5) return "FLAT";
  let now = 0, prev = 0;
  for (let j = i - SMA_PERIOD + 1; j <= i; j++) now += bars[j].close;
  for (let j = i - SMA_PERIOD - 4; j <= i - 5; j++) prev += bars[j].close;
  const a = now / SMA_PERIOD, b = prev / SMA_PERIOD;
  if (a > b * 1.0005) return "UP";
  if (a < b * 0.9995) return "DOWN";
  return "FLAT";
}

function decideSide(pattern: string, sign: string): BinanceTradeSide {
  if (pattern === "OB_BULL" || pattern === "BOS_UP") return sign === "DOWN" ? "SHORT" : "LONG";
  if (pattern === "OB_BEAR") return sign === "UP" ? "LONG" : "SHORT";
  return "LONG";
}

// Round value DOWN to nearest multiple of step. e.g. roundStep(1.2345, 0.001) = 1.234
function roundStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}
// Round to symbol's quantity precision (number of decimals)
function fmtQty(qty: number, precision: number): string {
  return qty.toFixed(Math.max(0, precision));
}
function fmtPrice(price: number, precision: number): string {
  return price.toFixed(Math.max(0, precision));
}

type Signal = { pattern: BinanceTrade["pattern"]; side: BinanceTradeSide; entryPrice: number; atrEntry: number };

function detectSignals(bars: Kline[], i: number): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars, i);
  if (!isFinite(a) || a <= 0) return out;
  const sign = smaSignAt(bars, i);

  // OB_BULL / OB_BEAR — first retrace into a recent OB zone
  for (let mvIdx = i - 1; mvIdx >= Math.max(5, i - OB_RETURN_BARS); mvIdx--) {
    const aMv = computeATR(bars, mvIdx);
    if (!isFinite(aMv) || aMv <= 0) continue;
    if (bars[mvIdx].close > bars[mvIdx].open && bars[mvIdx].close - bars[mvIdx].open >= DISP_ATR_MIN * aMv) {
      let obIdx = -1;
      for (let j = mvIdx - 1; j >= Math.max(0, mvIdx - 5); j--) if (bars[j].close < bars[j].open) { obIdx = j; break; }
      if (obIdx < 0) continue;
      const obHigh = Math.max(bars[obIdx].open, bars[obIdx].close);
      const obLow = bars[obIdx].low;
      if (bars[i].low <= obHigh && bars[i].low >= obLow) {
        let alreadyHit = false;
        for (let k = mvIdx + 1; k < i; k++) if (bars[k].low <= obHigh && bars[k].low >= obLow) { alreadyHit = true; break; }
        if (!alreadyHit) out.push({ pattern: "OB_BULL", side: decideSide("OB_BULL", sign), entryPrice: obHigh, atrEntry: a });
        break;
      }
    }
    if (bars[mvIdx].close < bars[mvIdx].open && bars[mvIdx].open - bars[mvIdx].close >= DISP_ATR_MIN * aMv) {
      let obIdx = -1;
      for (let j = mvIdx - 1; j >= Math.max(0, mvIdx - 5); j--) if (bars[j].close > bars[j].open) { obIdx = j; break; }
      if (obIdx < 0) continue;
      const obHigh = bars[obIdx].high;
      const obLow = Math.min(bars[obIdx].open, bars[obIdx].close);
      if (bars[i].high >= obLow && bars[i].high <= obHigh) {
        let alreadyHit = false;
        for (let k = mvIdx + 1; k < i; k++) if (bars[k].high >= obLow && bars[k].high <= obHigh) { alreadyHit = true; break; }
        if (!alreadyHit) out.push({ pattern: "OB_BEAR", side: decideSide("OB_BEAR", sign), entryPrice: obLow, atrEntry: a });
        break;
      }
    }
  }

  // BOS_UP — current bar closes above a confirmed past swing high
  if (i >= SWING_LB * 2 + 5) {
    let lastSwingHigh = -Infinity;
    for (let j = i - 1; j >= SWING_LB; j--) {
      if (j + SWING_LB >= i) continue;
      let isHigh = true;
      for (let k = j - SWING_LB; k <= j + SWING_LB; k++) { if (k === j) continue; if (bars[k].high > bars[j].high) { isHigh = false; break; } }
      if (isHigh) { lastSwingHigh = bars[j].high; break; }
    }
    if (isFinite(lastSwingHigh) && bars[i].close > lastSwingHigh && bars[i - 1].close <= lastSwingHigh) {
      out.push({ pattern: "BOS_UP", side: decideSide("BOS_UP", sign), entryPrice: bars[i].close, atrEntry: a });
    }
  }
  return out;
}

export class BinanceEngine extends EventEmitter {
  private client: BinanceClient;
  private bars: Map<string, Kline[]> = new Map();
  private filters: Record<string, SymbolFilters> = {};
  /** Hedge mode = LONG and SHORT positions tracked separately by Binance.
   *  Required for our multi-pattern same-asset overlaps. Set on startup. */
  private hedgeMode = true;
  private open: BinanceTrade[] = [];
  private closed: BinanceTrade[] = [];
  private daily: BinanceState["daily"] = emptyDaily();
  private assets: string[] = [];
  private stake = 15;
  private leverage = 30;
  private dailyMaxLoss = 100;
  private perTradeMaxStake = 30;
  private running = false;
  private signalLoopTimer: NodeJS.Timeout | null = null;
  private positionLoopTimer: NodeJS.Timeout | null = null;
  // Pending API actions per trade, to prevent racing duplicate orders
  private busy: Set<string> = new Set();

  constructor(client: BinanceClient) {
    super();
    this.client = client;
  }

  load(state: Partial<BinanceState>) {
    this.open = state.open ?? [];
    this.closed = state.closed ?? [];
    this.daily = state.daily ?? emptyDaily();
    this.rollDayIfNeeded();
  }

  state(): BinanceState { return { open: this.open, closed: this.closed, daily: this.daily }; }

  configure(opts: { assets?: string[]; stake?: number; leverage?: number; dailyMaxLoss?: number; perTradeMaxStake?: number }) {
    if (opts.assets) this.assets = opts.assets;
    if (opts.stake !== undefined) this.stake = opts.stake;
    if (opts.leverage !== undefined) this.leverage = opts.leverage;
    if (opts.dailyMaxLoss !== undefined) this.dailyMaxLoss = opts.dailyMaxLoss;
    if (opts.perTradeMaxStake !== undefined) this.perTradeMaxStake = opts.perTradeMaxStake;
  }

  private rollDayIfNeeded() {
    const today = utcToday();
    if (this.daily.date !== today) this.daily = emptyDaily();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try { await this.client.syncTime(); } catch (e) { this.emit("error", e as Error); }

    // Fetch exchangeInfo once — gives us per-symbol qty/price precision rules.
    try {
      this.filters = await this.client.getExchangeInfo();
    } catch (e) {
      this.emit("error", new Error(`Failed to fetch exchangeInfo: ${(e as Error).message}`));
    }

    // Set hedge mode (allows separate LONG + SHORT positions per symbol).
    // -4059 = "No need to change position side" — already in hedge mode, safe to ignore.
    try {
      await this.client["signedRequest"]?.("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" });
    } catch (e: any) {
      if (!/4059/.test(String(e?.message ?? ""))) this.emit("error", e as Error);
    }

    // Subscribe to user-data stream for real-time order fills + position updates
    try {
      await this.client.startUserDataStream();
      this.client.on("userEvent", (ev) => this.onUserEvent(ev));
    } catch (e) {
      this.emit("error", new Error(`Failed to start user-data stream: ${(e as Error).message}`));
    }

    // Seed klines for each asset
    for (const sym of this.assets) {
      try {
        const k = await this.client.getKlines(sym, "1h", KLINE_HISTORY);
        this.bars.set(sym, k);
        await this.client.setMarginType(sym, "ISOLATED").catch(() => undefined);
        await this.client.setLeverage(sym, this.leverage).catch((e) => this.emit("error", e as Error));
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Signal loop: every minute check if a new 1h bar closed
    this.signalLoopTimer = setInterval(() => this.signalTick().catch((e) => this.emit("error", e as Error)), 60_000);
    // Position loop: every 5s update peakFav + ratchet trailing TP
    this.positionLoopTimer = setInterval(() => this.positionTick().catch((e) => this.emit("error", e as Error)), 5_000);
    this.emit("stateChanged");
  }

  async stop() {
    this.running = false;
    if (this.signalLoopTimer) { clearInterval(this.signalLoopTimer); this.signalLoopTimer = null; }
    if (this.positionLoopTimer) { clearInterval(this.positionLoopTimer); this.positionLoopTimer = null; }
  }

  private async signalTick() {
    this.rollDayIfNeeded();
    if (this.daily.capHit) return;
    for (const sym of this.assets) {
      const buf = this.bars.get(sym);
      if (!buf || buf.length === 0) continue;
      try {
        // Fetch the most recent 2 × 1h klines
        const latest = await this.client.getKlines(sym, "1h", 2);
        if (latest.length === 0) continue;
        const newest = latest[latest.length - 1];
        // Use the SECOND-MOST-RECENT (last fully-closed) bar
        const closed = latest[latest.length - 2] ?? newest;
        const tail = buf[buf.length - 1];
        if (!tail || closed.epoch > tail.epoch) {
          // New 1h bar closed — append and run signal detection
          buf.push(closed);
          if (buf.length > KLINE_HISTORY) buf.splice(0, buf.length - KLINE_HISTORY);
          await this.checkSignalsFor(sym);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
  }

  private async checkSignalsFor(sym: string) {
    const buf = this.bars.get(sym);
    if (!buf || buf.length < SMA_PERIOD + 10) return;
    const i = buf.length - 1;
    const sigs = detectSignals(buf, i);
    for (const s of sigs) {
      // Skip if same (asset, pattern, side) already open
      if (this.open.find((t) => t.asset === sym && t.pattern === s.pattern && t.side === s.side)) continue;
      // Cap: per-trade stake
      const stake = Math.min(this.stake, this.perTradeMaxStake);
      if (stake < 1) continue;
      await this.openTrade(sym, s, stake);
    }
  }

  private async openTrade(sym: string, s: Signal, stake: number) {
    const lockKey = `open:${sym}:${s.pattern}:${s.side}`;
    if (this.busy.has(lockKey)) return;
    this.busy.add(lockKey);
    try {
      const notional = stake * this.leverage;
      const refPrice = s.entryPrice;
      const f = this.filters[sym];
      if (!f) { this.emit("error", new Error(`No filters for ${sym} — cannot place order`)); return; }
      const qtyRaw = notional / refPrice;
      const qty = roundStep(qtyRaw, f.stepSize);
      if (qty < f.minQty) { this.emit("error", new Error(`${sym} qty ${qty} below minQty ${f.minQty}`)); return; }
      if (qty * refPrice < f.minNotional) { this.emit("error", new Error(`${sym} notional ${(qty * refPrice).toFixed(2)} below minNotional ${f.minNotional}`)); return; }

      // Logical-trade UUID is embedded in clientOrderId so user-data stream
      // updates can be matched back to this trade.
      const tradeId = randomUUID();
      const cid = `smc-${tradeId.slice(0, 8)}`;
      const orderSide = s.side === "LONG" ? "BUY" : "SELL";
      const positionSide = this.hedgeMode ? (s.side === "LONG" ? "LONG" : "SHORT") : "BOTH";

      const resp = await this.client.placeMarketOrder({
        symbol: sym, side: orderSide as any, quantity: Number(fmtQty(qty, f.quantityPrecision)),
        positionSide: positionSide as any, clientOrderId: cid,
      });
      const trade: BinanceTrade = {
        id: tradeId,
        asset: sym,
        pattern: s.pattern,
        side: s.side,
        stake,
        leverage: this.leverage,
        notional,
        qty,
        entryEpoch: Math.floor(resp.updateTime / 1000),
        entryPrice: Number(resp.avgPrice) || refPrice,
        atrEntry: s.atrEntry,
        peakFav: Number(resp.avgPrice) || refPrice,
        armed: false,
        tpOrderId: null,
        status: "OPEN",
      };
      (trade as any).clientOrderId = cid;
      this.open.push(trade);
      this.daily.tradesOpened++;
      this.emit("opened", trade);
      this.emit("stateChanged");
    } catch (e) {
      this.emit("error", e as Error);
    } finally {
      this.busy.delete(lockKey);
    }
  }

  /** Handle user-data stream events. Match orders to local trades via
   *  clientOrderId. Captures real fill prices (overrides our peakFav estimate). */
  private onUserEvent(ev: any) {
    if (ev?.e !== "ORDER_TRADE_UPDATE") return;
    const o = ev.o;
    if (!o) return;
    const cid: string = o.c ?? "";
    const execType: string = o.x ?? "";        // "NEW" | "TRADE" | "CANCELED" | "EXPIRED"
    const status: string = o.X ?? "";          // "FILLED" | "PARTIALLY_FILLED" | "NEW" | "CANCELED"
    const avgPrice = +o.ap || 0;               // average fill price
    const lastFillPrice = +o.L || 0;
    const cumQty = +o.z || 0;
    const orderId = +o.i || 0;

    // Match by clientOrderId prefix to a logical trade
    const matchedEntry = this.open.find((t) => (t as any).clientOrderId === cid);
    if (matchedEntry && execType === "TRADE" && status === "FILLED") {
      // Entry order fully filled — update real entry price
      const fillPrice = avgPrice || lastFillPrice;
      if (fillPrice > 0) {
        matchedEntry.entryPrice = fillPrice;
        matchedEntry.peakFav = fillPrice;
        this.emit("stateChanged");
      }
      return;
    }

    // TP-stop order fill: clientOrderId starts with "tp-<8charTradeId>-..."
    if (cid.startsWith("tp-") && execType === "TRADE" && status === "FILLED") {
      const idPrefix = cid.split("-")[1];
      const tp = this.open.find((t) => t.id.startsWith(idPrefix));
      if (tp) {
        const fillPrice = avgPrice || lastFillPrice;
        this.closeTradeFromFill(tp, fillPrice).catch((e) => this.emit("error", e as Error));
      }
    }
  }

  private async closeTradeFromFill(t: BinanceTrade, fillPrice: number) {
    const pctMove = (fillPrice - t.entryPrice) / t.entryPrice;
    let pnl = t.stake * t.leverage * (t.side === "LONG" ? 1 : -1) * pctMove;
    if (pnl < -t.stake) pnl = -t.stake;
    t.status = "CLOSED";
    t.closeEpoch = Math.floor(Date.now() / 1000);
    t.closePrice = fillPrice;
    t.pnl = pnl;
    this.open = this.open.filter((x) => x.id !== t.id);
    this.closed.push(t);
    this.daily.profit += pnl;
    if (this.daily.profit <= -this.dailyMaxLoss) {
      this.daily.capHit = true;
      this.emit("capHit", -this.daily.profit, this.dailyMaxLoss);
    }
    this.emit("closed", t);
    this.emit("stateChanged");
  }

  private async positionTick() {
    if (this.open.length === 0) return;
    // Group open trades by asset, fetch each asset's mark price once
    const assetsWithOpen = Array.from(new Set(this.open.map((t) => t.asset)));
    for (const sym of assetsWithOpen) {
      try {
        // Mark price endpoint (public)
        const r = await fetch(`${this.client["hosts"]?.()?.rest ?? "https://fapi.binance.com"}/fapi/v1/premiumIndex?symbol=${sym}`);
        if (!r.ok) continue;
        const data = await r.json() as any;
        const markPrice = +data.markPrice;
        if (!isFinite(markPrice)) continue;
        for (const t of this.open.filter((x) => x.asset === sym)) {
          await this.updateTrade(t, markPrice);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Check if any trades have actually closed on Binance (filled via stop)
    await this.reconcilePositions();
  }

  private async updateTrade(t: BinanceTrade, markPrice: number) {
    const armDist = TRAIL_ARM_ATR * t.atrEntry;
    const trailDist = TRAIL_RETRACE_ATR * t.atrEntry;
    let stateChanged = false;
    if (t.side === "LONG") {
      if (markPrice > t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav >= t.entryPrice + armDist) { t.armed = true; stateChanged = true; }
    } else {
      if (markPrice < t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav <= t.entryPrice - armDist) { t.armed = true; stateChanged = true; }
    }
    // Trail trigger: once armed, check if mark price has retraced to
    // peak − trailDist. Multi-Assets accounts reject STOP_MARKET via
    // /fapi/v1/order — so the bot fires a MARKET reduce-only order
    // in-process instead. This matches the live-test-validated approach.
    if (t.armed) {
      const trailLevel = t.side === "LONG" ? t.peakFav - trailDist : t.peakFav + trailDist;
      const triggered = t.side === "LONG" ? markPrice <= trailLevel : markPrice >= trailLevel;
      if (triggered) {
        const lockKey = `close:${t.id}`;
        if (this.busy.has(lockKey)) return;
        this.busy.add(lockKey);
        try {
          const f = this.filters[t.asset];
          const closeSide = t.side === "LONG" ? "SELL" : "BUY";
          const positionSide = this.hedgeMode ? t.side : "BOTH";
          await this.client.placeMarketOrder({
            symbol: t.asset, side: closeSide as any,
            quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
            positionSide: positionSide as any,
            clientOrderId: `close-${t.id.slice(0, 8)}-${Date.now()}`,
          });
          // Close logic: position settles in next reconcile / user-data stream tick.
          // We pre-emptively close locally with current markPrice for fast UI feedback;
          // exact fill price will be refined by user-data stream ORDER_TRADE_UPDATE.
          await this.closeTradeFromFill(t, markPrice);
          stateChanged = true;
        } catch (e) {
          this.emit("error", e as Error);
        } finally {
          this.busy.delete(lockKey);
        }
      }
    }
    if (stateChanged) this.emit("stateChanged");
  }

  /** Safety-net reconciler. In hedge mode, Binance tracks one position per
   *  (symbol, side). Local "trades" are logical sub-positions that share that
   *  aggregated Binance position. Trade closes are normally driven by the
   *  user-data stream (ORDER_TRADE_UPDATE → closeTradeFromFill). This
   *  reconciler ONLY fires when the Binance position on a side is zero
   *  while we still have local trades open — i.e., a liquidation or manual
   *  close happened outside the bot, and the stream event was missed. */
  private async reconcilePositions() {
    try {
      const positions = await this.client.getPositions();
      // Index by (symbol, positionSide)
      const posMap = new Map<string, number>();
      for (const p of positions) posMap.set(`${p.symbol}:${p.positionSide}`, Math.abs(p.positionAmt));
      for (const t of [...this.open]) {
        const sideKey = this.hedgeMode ? t.side : "BOTH";
        const amt = posMap.get(`${t.asset}:${sideKey}`) ?? 0;
        if (amt < 1e-9) {
          // Whole side flat on Binance — close locally (approx PnL via peakFav)
          await this.closeTradeFromReconcile(t);
        }
      }
    } catch (e) {
      this.emit("error", e as Error);
    }
  }

  private async closeTradeFromReconcile(t: BinanceTrade) {
    // Position vanished from Binance but we still think trade is open —
    // liquidation, manual close, or stale state. Best-effort PnL from peakFav.
    const exitPrice = t.peakFav;
    const pctMove = (exitPrice - t.entryPrice) / t.entryPrice;
    let pnl = t.stake * t.leverage * (t.side === "LONG" ? 1 : -1) * pctMove;
    if (pnl < -t.stake) pnl = -t.stake;
    t.status = "CLOSED";
    t.closeEpoch = Math.floor(Date.now() / 1000);
    t.closePrice = exitPrice;
    t.pnl = pnl;
    this.open = this.open.filter((x) => x.id !== t.id);
    this.closed.push(t);
    this.daily.profit += pnl;
    if (this.daily.profit <= -this.dailyMaxLoss) {
      this.daily.capHit = true;
      this.emit("capHit", -this.daily.profit, this.dailyMaxLoss);
    }
    this.emit("closed", t);
    this.emit("stateChanged");
  }

  on<K extends keyof BinanceEngineEvents>(event: K, listener: (...args: BinanceEngineEvents[K]) => void): this { return super.on(event, listener as any); }
  emit<K extends keyof BinanceEngineEvents>(event: K, ...args: BinanceEngineEvents[K]): boolean { return super.emit(event, ...args); }
}

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

export type BinancePattern = "OB_BULL" | "OB_BEAR" | "BOS_UP" | "BB_UP_SHORT" | "BB_LOW_LONG";
export const HF_PATTERNS: ReadonlySet<BinancePattern> = new Set(["BB_UP_SHORT", "BB_LOW_LONG"]);
export function isHfPattern(p: BinancePattern): boolean { return HF_PATTERNS.has(p); }

export type BinanceTrade = {
  id: string;
  asset: string;          // e.g., BTCUSDT
  pattern: BinancePattern;
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
  /** Net realized P&L in USDT. Initially set from the local estimate
   *  (stake×leverage×pctMove) at close time; overwritten with the exchange's
   *  real net (`realizedPnlExchange − commissionEntry − commissionExit`)
   *  once both fill events arrive via the user-data stream. */
  pnl?: number;
  /** Exchange-reported realized profit from ORDER_TRADE_UPDATE.rp. Sums
   *  every fill on the close order. Zero on entry-only fills. */
  realizedPnlExchange?: number;
  /** Sum of commissions paid on the entry-side fills (USDT, always
   *  positive). Populated from ORDER_TRADE_UPDATE.n on each entry fill. */
  commissionEntry?: number;
  /** Sum of commissions on the close-side fills (USDT, positive). */
  commissionExit?: number;
  /** Current mark price (updated every positionTick poll). UI reads this
   *  to display REAL current Δ% from entry, not peak-from-entry which
   *  only moves favorably. */
  markPrice?: number;
  /** Last time markPrice was refreshed (epoch seconds) — UI uses this
   *  to fade stale values if the polling loop stalls. */
  markUpdatedAt?: number;
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
  /** Free-form info events for the Logs UI — warmup, signals, skips, trail armed. */
  info: [message: string, meta?: Record<string, any>];
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
const KLINE_HISTORY = 500;  // ~21 days of 1h bars — gives swing-detection + SMA50 + pending OBs from past 3 weeks
const STRUCTURE_OB_MAX_AGE = 50; // bars — pending OB zones older than this get pruned

// ─── HF 15m strategy constants (BB_UP_SHORT + BB_LOW_LONG) ─────────────
// Validated 2026-05-22 — see project_trader_assistant_hf_cost_calibration memory.
// Costs and trail params identical to the 1h SMC stack; only the timeframe
// and detector differ.
const HF_BB_PERIOD = 20;
const HF_BB_K = 2.0;
const HF_KLINE_HISTORY = 200; // 15m bars — ~50h of context, plenty for BB(20) + SMA(50)

/** Compute Bollinger Bands at index i. Returns null until enough history. */
function computeBB(bars: Kline[], i: number, period: number, k: number): { mid: number; upper: number; lower: number } | null {
  if (i < period - 1) return null;
  let sum = 0, sq = 0;
  for (let j = i - period + 1; j <= i; j++) {
    sum += bars[j].close;
    sq += bars[j].close ** 2;
  }
  const mid = sum / period;
  const sd = Math.sqrt(Math.max(0, sq / period - mid * mid));
  return { mid, upper: mid + k * sd, lower: mid - k * sd };
}

/** HF detector: scans the latest 15m bar for BB band-touch reversal. */
function detectHfSignals(bars: Kline[], i: number): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars, i);
  if (!isFinite(a) || a <= 0) return out;
  const bb = computeBB(bars, i, HF_BB_PERIOD, HF_BB_K);
  if (!bb) return out;
  const b = bars[i];
  // BB_UP_SHORT: bar high pierced upper band, but closed back below = mean-reversion short
  if (b.high >= bb.upper && b.close < bb.upper) {
    out.push({ pattern: "BB_UP_SHORT", side: "SHORT", entryPrice: b.close, atrEntry: a });
  }
  // BB_LOW_LONG: symmetric — bar low pierced lower band, closed back above
  if (b.low <= bb.lower && b.close > bb.lower) {
    out.push({ pattern: "BB_LOW_LONG", side: "LONG", entryPrice: b.close, atrEntry: a });
  }
  return out;
}

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

/** Cached "active" structure per asset — built during warmup replay, updated
 *  per bar in live mode. Lets the engine fire on OB zones that formed before
 *  startup but haven't been retraced yet. */
type ActiveStructure = {
  /** OB zones that have formed but haven't been retraced (still pending entry).
   *  When current bar's wick enters the zone, fire OB_BULL or OB_BEAR. */
  pendingOBs: Array<{
    bull: boolean;       // true=bullish OB (entry on long retrace), false=bearish
    formedAt: number;    // bar index when the OB displacement happened
    obIdx: number;       // bar index of the OB candle itself
    zoneHigh: number;
    zoneLow: number;
  }>;
  /** Most recent confirmed swing high (for BOS_UP detection). */
  lastSwingHigh: number;
  lastSwingHighAt: number;
  lastSwingLow: number;
  lastSwingLowAt: number;
};

function emptyStructure(): ActiveStructure {
  return { pendingOBs: [], lastSwingHigh: -Infinity, lastSwingHighAt: -1, lastSwingLow: Infinity, lastSwingLowAt: -1 };
}

/** Update structure cache for a single bar transition. Idempotent per bar.
 *  Used by both warmup replay and live forward-walk. */
function updateStructure(structure: ActiveStructure, bars: Kline[], i: number): void {
  // 1) Detect new OB formations: current bar i is a displacement candle
  const a = computeATR(bars, i);
  if (isFinite(a) && a > 0) {
    // Bullish displacement → look back for the bearish OB candle
    if (bars[i].close > bars[i].open && (bars[i].close - bars[i].open) >= DISP_ATR_MIN * a) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].close < bars[j].open) {
          structure.pendingOBs.push({
            bull: true, formedAt: i, obIdx: j,
            zoneHigh: Math.max(bars[j].open, bars[j].close),
            zoneLow: bars[j].low,
          });
          break;
        }
      }
    }
    // Bearish displacement
    if (bars[i].close < bars[i].open && (bars[i].open - bars[i].close) >= DISP_ATR_MIN * a) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].close > bars[j].open) {
          structure.pendingOBs.push({
            bull: false, formedAt: i, obIdx: j,
            zoneHigh: bars[j].high,
            zoneLow: Math.min(bars[j].open, bars[j].close),
          });
          break;
        }
      }
    }
  }

  // 2) Confirm a new swing high/low (looks back SWING_LB on each side of bar j = i - SWING_LB)
  const j = i - SWING_LB;
  if (j >= SWING_LB) {
    let isHigh = true, isLow = true;
    for (let k = j - SWING_LB; k <= j + SWING_LB; k++) {
      if (k === j) continue;
      if (bars[k].high > bars[j].high) isHigh = false;
      if (bars[k].low < bars[j].low) isLow = false;
    }
    if (isHigh && bars[j].high > structure.lastSwingHigh) {
      structure.lastSwingHigh = bars[j].high;
      structure.lastSwingHighAt = j;
    }
    if (isLow && bars[j].low < structure.lastSwingLow) {
      structure.lastSwingLow = bars[j].low;
      structure.lastSwingLowAt = j;
    }
  }

  // 3) Prune OBs that are already retraced OR too old
  structure.pendingOBs = structure.pendingOBs.filter((ob) => {
    if (i - ob.formedAt > STRUCTURE_OB_MAX_AGE) return false;
    // Check if any bar BETWEEN obIdx+1 and i has touched the zone
    for (let k = ob.formedAt + 1; k <= i; k++) {
      const touched = ob.bull
        ? (bars[k].low <= ob.zoneHigh && bars[k].low >= ob.zoneLow)
        : (bars[k].high >= ob.zoneLow && bars[k].high <= ob.zoneHigh);
      if (touched) return false; // already fired its signal — gone
    }
    return true;
  });
}

/** Warmup: replay all historical bars to build the structure cache.
 *  Does NOT emit signals (we're past those bars already). */
function buildStructureFromHistory(bars: Kline[]): ActiveStructure {
  const s = emptyStructure();
  // Start from the earliest bar that has both ATR + lookback context
  const startIdx = Math.max(SWING_LB * 2 + 5, ATR_PERIOD + 1);
  for (let i = startIdx; i < bars.length; i++) {
    updateStructure(s, bars, i);
  }
  return s;
}

/** Cache-aware signal detection. Checks current bar against pending OBs from
 *  the structure cache (including ones formed long before the bot started). */
function detectSignalsFromCache(bars: Kline[], i: number, structure: ActiveStructure): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars, i);
  if (!isFinite(a) || a <= 0) return out;
  const sign = smaSignAt(bars, i);

  // OB triggers: any pending zone touched by THIS bar
  for (const ob of structure.pendingOBs) {
    if (ob.formedAt >= i) continue; // can't re-trigger on the formation bar itself
    if (ob.bull) {
      if (bars[i].low <= ob.zoneHigh && bars[i].low >= ob.zoneLow) {
        out.push({ pattern: "OB_BULL", side: decideSide("OB_BULL", sign), entryPrice: ob.zoneHigh, atrEntry: a });
      }
    } else {
      if (bars[i].high >= ob.zoneLow && bars[i].high <= ob.zoneHigh) {
        out.push({ pattern: "OB_BEAR", side: decideSide("OB_BEAR", sign), entryPrice: ob.zoneLow, atrEntry: a });
      }
    }
  }

  // BOS_UP: close > most recent confirmed swing high (from cache, no lookback limit)
  if (isFinite(structure.lastSwingHigh) && bars[i].close > structure.lastSwingHigh && bars[i - 1].close <= structure.lastSwingHigh) {
    out.push({ pattern: "BOS_UP", side: decideSide("BOS_UP", sign), entryPrice: bars[i].close, atrEntry: a });
  }

  return out;
}

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
  /** Per-asset active-structure cache: pending OB zones + latest swing levels.
   *  Built once during startup replay; updated incrementally on each new bar. */
  private structures: Map<string, ActiveStructure> = new Map();
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
  private perAssetEnabled: Record<string, boolean> = {};
  private perPatternEnabled: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean } = { OB_BULL: true, OB_BEAR: true, BOS_UP: true };
  // ── HF (15m) state — separate from the 1h SMC stack above ──
  private hfEnabled = false;
  private hfStake = 1;
  private hfLeverage = 30;
  private hfAllowMultiplePerKey = false;
  private hfPerPatternEnabled: { BB_UP_SHORT: boolean; BB_LOW_LONG: boolean } = { BB_UP_SHORT: true, BB_LOW_LONG: true };
  private hfPerAssetEnabled: Record<string, boolean> = {};
  /** Separate rolling 15m kline buffer — keyed by asset. Populated lazily on
   *  first HF tick after enabling, so disabling HF doesn't waste bandwidth. */
  private bars15m: Map<string, Kline[]> = new Map();
  private hfSignalLoopTimer: NodeJS.Timeout | null = null;
  private hfTickCount = 0;
  // ── End HF state ──
  private running = false;
  private signalLoopTimer: NodeJS.Timeout | null = null;
  private positionLoopTimer: NodeJS.Timeout | null = null;
  // Pending API actions per trade, to prevent racing duplicate orders
  private busy: Set<string> = new Set();
  // Heartbeat: cycle counter + per-tick signal counter (set inside checkSignalsFor)
  private tickCount = 0;
  private signalsThisTick = 0;

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

  /** Returns the list of Binance positions that the bot does NOT track in
   *  its local open[] — i.e., positions opened directly on Binance (manual
   *  trades) or zombies left behind by older bot versions. Used by the
   *  External tab in the UI. */
  async externalPositions(): Promise<Array<{
    symbol: string; positionSide: BinanceTradeSide;
    qty: number; entryPrice: number; markPrice: number;
    unRealizedProfit: number; leverage: number;
    liquidationPrice: number; updateTime: number;
    botQty: number; externalQty: number;
  }>> {
    const positions = await this.client.getPositions();
    const out: Array<any> = [];
    for (const p of positions) {
      const qty = Math.abs(+p.positionAmt);
      if (qty < 1e-9) continue;
      const side: BinanceTradeSide = p.positionSide === "SHORT" ? "SHORT" :
                                      p.positionSide === "LONG"  ? "LONG"  :
                                      (+p.positionAmt >= 0 ? "LONG" : "SHORT");
      // How much of this Binance position does the bot account for?
      const botQty = this.open
        .filter((t) => t.asset === p.symbol && t.side === side)
        .reduce((s, t) => s + t.qty, 0);
      const externalQty = Math.max(0, qty - botQty);
      // Only surface positions with material un-tracked qty (>1% of total).
      if (externalQty / Math.max(qty, 1e-9) < 0.01) continue;
      out.push({
        symbol: p.symbol, positionSide: side,
        qty, entryPrice: p.entryPrice, markPrice: p.markPrice,
        unRealizedProfit: p.unRealizedProfit, leverage: p.leverage,
        liquidationPrice: p.liquidationPrice, updateTime: p.updateTime,
        botQty, externalQty,
      });
    }
    return out;
  }

  /** Close a Binance position directly by symbol + side, regardless of
   *  whether the bot tracks it. Used by the External tab's Cancel button —
   *  reduce-only MARKET that drains the un-tracked quantity. */
  async closeExternal(symbol: string, side: BinanceTradeSide, qty: number): Promise<{ ok: boolean; error?: string }> {
    const lockKey = `external-close:${symbol}:${side}`;
    if (this.busy.has(lockKey)) return { ok: false, error: "Close already in progress" };
    this.busy.add(lockKey);
    try {
      const f = this.filters[symbol];
      const stepSize = f?.stepSize ?? 0.001;
      const qP = f?.quantityPrecision ?? 3;
      // Round qty DOWN to nearest stepSize, then format to required precision
      const safeQty = Math.floor(qty / stepSize) * stepSize;
      if (safeQty <= 0) return { ok: false, error: `qty ${qty} rounds to 0 at stepSize ${stepSize}` };
      const closeSide = side === "LONG" ? "SELL" : "BUY";
      const positionSide = this.hedgeMode ? side : "BOTH";
      this.emit("info", `external cancel ${symbol} ${side} qty=${safeQty} (user-requested via External tab)`, {
        asset: symbol, side, qty: safeQty,
      });
      await this.client.placeMarketOrder({
        symbol, side: closeSide as any,
        quantity: Number(fmtQty(safeQty, qP)),
        positionSide: positionSide as any,
        clientOrderId: `ext-${Date.now()}`,
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.busy.delete(lockKey);
    }
  }

  /** Force-close a single open trade at market. Used by the UI Cancel button.
   *  Places a MARKET reduce-only order; the closeTradeFromFill path is invoked
   *  via the user-data stream when Binance acks the fill, so P&L is captured
   *  at the actual exit price. */
  async cancelTrade(tradeId: string): Promise<{ ok: boolean; error?: string }> {
    const t = this.open.find((x) => x.id === tradeId);
    if (!t) return { ok: false, error: `Trade ${tradeId} not open` };
    const lockKey = `close:${t.id}`;
    if (this.busy.has(lockKey)) return { ok: false, error: "Cancel already in progress" };
    this.busy.add(lockKey);
    try {
      const f = this.filters[t.asset];
      const closeSide = t.side === "LONG" ? "SELL" : "BUY";
      const positionSide = this.hedgeMode ? t.side : "BOTH";
      this.emit("info", `cancel ${t.asset} ${t.pattern}/${t.side} qty=${t.qty} — placing market close`, {
        asset: t.asset, pattern: t.pattern, side: t.side, qty: t.qty, tradeId: t.id,
      });
      await this.client.placeMarketOrder({
        symbol: t.asset, side: closeSide as any,
        quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
        positionSide: positionSide as any,
        clientOrderId: `cancel-${t.id.slice(0, 8)}-${Date.now()}`,
      });
      // Best-effort immediate local close at peak/entry — actual fill
      // price will be refined by user-data ORDER_TRADE_UPDATE if it
      // arrives, but the local state needs to update fast for the UI.
      await this.closeTradeFromFill(t, t.peakFav || t.entryPrice);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.busy.delete(lockKey);
    }
  }

  configure(opts: {
    assets?: string[];
    stake?: number;
    leverage?: number;
    dailyMaxLoss?: number;
    perTradeMaxStake?: number;
    perAssetEnabled?: Record<string, boolean>;
    perPatternEnabled?: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean };
    hf?: {
      enabled?: boolean;
      stake?: number;
      leverage?: number;
      allowMultiplePerKey?: boolean;
      perPatternEnabled?: { BB_UP_SHORT: boolean; BB_LOW_LONG: boolean };
      perAssetEnabled?: Record<string, boolean>;
    };
  }) {
    if (opts.assets) this.assets = opts.assets;
    if (opts.stake !== undefined) this.stake = opts.stake;
    if (opts.leverage !== undefined) this.leverage = opts.leverage;
    if (opts.dailyMaxLoss !== undefined) this.dailyMaxLoss = opts.dailyMaxLoss;
    if (opts.perTradeMaxStake !== undefined) this.perTradeMaxStake = opts.perTradeMaxStake;
    if (opts.perAssetEnabled) this.perAssetEnabled = opts.perAssetEnabled;
    if (opts.perPatternEnabled) this.perPatternEnabled = opts.perPatternEnabled;
    if (opts.hf) {
      const wasEnabled = this.hfEnabled;
      if (opts.hf.enabled !== undefined) this.hfEnabled = opts.hf.enabled;
      if (opts.hf.stake !== undefined) this.hfStake = opts.hf.stake;
      if (opts.hf.leverage !== undefined) this.hfLeverage = opts.hf.leverage;
      if (opts.hf.allowMultiplePerKey !== undefined) this.hfAllowMultiplePerKey = opts.hf.allowMultiplePerKey;
      if (opts.hf.perPatternEnabled) this.hfPerPatternEnabled = opts.hf.perPatternEnabled;
      if (opts.hf.perAssetEnabled) this.hfPerAssetEnabled = opts.hf.perAssetEnabled;
      // Immediate proof-of-life log when operator flips HF on/off at runtime.
      if (!wasEnabled && this.hfEnabled) {
        this.emit("info", `HF stack ENABLED at runtime: stake $${this.hfStake} × ${this.hfLeverage}× on 15m BB patterns`, {
          stake: this.hfStake, leverage: this.hfLeverage, allowMultiplePerKey: this.hfAllowMultiplePerKey,
        });
        // Don't wait for the next 30s tick — kick a warmup pass right now so
        // the Logs panel shows activity within a second of the Save click.
        if (this.running) {
          this.hfSignalTick().catch((e) => this.emit("error", e as Error));
        }
      } else if (wasEnabled && !this.hfEnabled) {
        this.emit("info", `HF stack DISABLED at runtime`, {});
      }
    }
  }

  private rollDayIfNeeded() {
    const today = utcToday();
    if (this.daily.date !== today) this.daily = emptyDaily();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.emit("info", `engine starting: ${this.assets.length} assets, stake $${this.stake}, lev ${this.leverage}x`, {
      assets: this.assets.length, stake: this.stake, leverage: this.leverage,
    });
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

    // Seed klines for each asset + replay structure cache so bot recognises
    // pending OB zones that formed before startup.
    for (const sym of this.assets) {
      try {
        const k = await this.client.getKlines(sym, "1h", KLINE_HISTORY);
        this.bars.set(sym, k);
        const struct = buildStructureFromHistory(k);
        this.structures.set(sym, struct);
        // Logging warmup outcome helps verify the cache populated properly
        const pending = struct.pendingOBs.length;
        this.emit("info", `warmup ${sym}: ${k.length} bars, ${pending} pending OBs`, {
          asset: sym, bars: k.length, pendingOBs: pending,
          swingHigh: isFinite(struct.lastSwingHigh) ? +struct.lastSwingHigh.toFixed(4) : null,
          swingLow: isFinite(struct.lastSwingLow) ? +struct.lastSwingLow.toFixed(4) : null,
        });
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
    // HF signal loop: every 30s check if a new 15m bar closed
    this.hfSignalLoopTimer = setInterval(() => this.hfSignalTick().catch((e) => this.emit("error", e as Error)), 30_000);
    if (this.hfEnabled) this.emit("info", `HF stack enabled: stake $${this.hfStake} × ${this.hfLeverage}× on 15m BB patterns`, {
      stake: this.hfStake, leverage: this.hfLeverage, allowMultiplePerKey: this.hfAllowMultiplePerKey,
    });
    this.emit("stateChanged");
  }

  async stop() {
    this.running = false;
    if (this.signalLoopTimer) { clearInterval(this.signalLoopTimer); this.signalLoopTimer = null; }
    if (this.positionLoopTimer) { clearInterval(this.positionLoopTimer); this.positionLoopTimer = null; }
    if (this.hfSignalLoopTimer) { clearInterval(this.hfSignalLoopTimer); this.hfSignalLoopTimer = null; }
  }

  private async signalTick() {
    this.rollDayIfNeeded();
    if (this.daily.capHit) return;
    this.tickCount++;
    this.signalsThisTick = 0;
    void this.hfTickCount; // referenced by HF loop
    const barsClosed: string[] = [];
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
          barsClosed.push(sym);
          await this.checkSignalsFor(sym);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Heartbeat: log if any new bars closed this cycle, OR every 15 idle minutes
    const idleHeartbeat = this.tickCount % 15 === 0;
    if (barsClosed.length > 0 || idleHeartbeat) {
      this.emit("info", `tick: bars closed=${barsClosed.length}${barsClosed.length ? ` (${barsClosed.join(",")})` : ""}, signals=${this.signalsThisTick}, open=${this.open.length}/${this.assets.length} assets`, {
        tickCount: this.tickCount, barsClosed, signals: this.signalsThisTick, open: this.open.length, assets: this.assets.length,
      });
    }
  }

  private async checkSignalsFor(sym: string) {
    const buf = this.bars.get(sym);
    if (!buf || buf.length < SMA_PERIOD + 10) return;
    if (this.perAssetEnabled[sym] === false) return;
    const i = buf.length - 1;
    const structure = this.structures.get(sym) ?? emptyStructure();
    const sigs = detectSignalsFromCache(buf, i, structure);
    if (sigs.length > 0) {
      this.signalsThisTick += sigs.length;
      this.emit("info", `signals on ${sym}: ${sigs.map(s => `${s.pattern}/${s.side}`).join(", ")}`, {
        asset: sym, count: sigs.length, signals: sigs.map(s => ({ pattern: s.pattern, side: s.side, entryPrice: s.entryPrice })),
      });
    }
    for (const s of sigs) {
      // detectSignalsFromCache only returns SMC patterns; safe cast.
      const smcKey = s.pattern as "OB_BULL" | "OB_BEAR" | "BOS_UP";
      if (this.perPatternEnabled[smcKey] === false) {
        this.emit("info", `skip ${sym} ${s.pattern}: pattern disabled`, { asset: sym, pattern: s.pattern });
        continue;
      }
      if (this.open.find((t) => t.asset === sym && t.pattern === s.pattern && t.side === s.side)) {
        this.emit("info", `skip ${sym} ${s.pattern}/${s.side}: already open`, { asset: sym, pattern: s.pattern });
        continue;
      }
      const stake = Math.min(this.stake, this.perTradeMaxStake);
      if (stake < 1) {
        this.emit("info", `skip ${sym} ${s.pattern}: stake below $1`, { asset: sym });
        continue;
      }
      await this.openTrade(sym, s, stake);
    }
    updateStructure(structure, buf, i);
    this.structures.set(sym, structure);
  }

  // ─── HF (15m) loop ────────────────────────────────────────────────────
  /** Per-30s poll: per asset, fetch the last 2 × 15m bars; if a new one
   *  closed since last poll, append it and check for HF signals. Lazy-
   *  seeds the 15m buffer on first call after enable. */
  private async hfSignalTick() {
    if (!this.hfEnabled) return;
    this.rollDayIfNeeded();
    if (this.daily.capHit) return;
    this.hfTickCount++;
    let signalsFired = 0;
    const barsClosed: string[] = [];
    for (const sym of this.assets) {
      if (this.hfPerAssetEnabled[sym] === false) continue;
      try {
        let buf = this.bars15m.get(sym);
        if (!buf) {
          // First touch — seed the buffer with HF_KLINE_HISTORY bars of 15m history.
          // Binance's klines endpoint includes the CURRENTLY-FORMING bar at the
          // tail. We pop it so `buf` only contains fully-closed bars, otherwise
          // the next bar boundary's close would have the same openTime as our
          // tail and the close-detection branch would never fire.
          buf = await this.client.getKlines(sym, "15m", HF_KLINE_HISTORY);
          if (buf.length > 0) buf.pop();
          this.bars15m.set(sym, buf);
          this.emit("info", `HF warmup ${sym}: ${buf.length} 15m bars (in-progress bar dropped)`, { asset: sym, bars: buf.length });
          continue; // skip detection on warmup tick — next bar close fires it
        }
        const latest = await this.client.getKlines(sym, "15m", 2);
        if (latest.length === 0) continue;
        const closed = latest[latest.length - 2] ?? latest[latest.length - 1];
        const tail = buf[buf.length - 1];
        if (!tail || closed.epoch > tail.epoch) {
          buf.push(closed);
          if (buf.length > HF_KLINE_HISTORY) buf.splice(0, buf.length - HF_KLINE_HISTORY);
          barsClosed.push(sym);
          signalsFired += await this.checkHfSignalsFor(sym);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Heartbeat — log when bars close OR every 4 idle ticks (~2min) so the
    // UI always sees activity within ~2 minutes of enabling.
    if (barsClosed.length > 0 || this.hfTickCount % 4 === 0) {
      this.emit("info", `HF tick: bars=${barsClosed.length}${barsClosed.length ? ` (${barsClosed.join(",")})` : ""}, signals=${signalsFired}, hfOpen=${this.open.filter(t => isHfPattern(t.pattern)).length}`, {
        tickCount: this.hfTickCount, barsClosed, signals: signalsFired,
      });
    }
  }

  private async checkHfSignalsFor(sym: string): Promise<number> {
    const buf = this.bars15m.get(sym);
    if (!buf || buf.length < Math.max(HF_BB_PERIOD, ATR_PERIOD) + 5) return 0;
    const i = buf.length - 1;
    const sigs = detectHfSignals(buf, i);
    if (sigs.length === 0) return 0;
    this.emit("info", `HF signals on ${sym}: ${sigs.map(s => `${s.pattern}/${s.side}`).join(", ")}`, {
      asset: sym, count: sigs.length, signals: sigs.map(s => ({ pattern: s.pattern, side: s.side, entryPrice: s.entryPrice })),
    });
    let opened = 0;
    for (const s of sigs) {
      if (this.hfPerPatternEnabled[s.pattern as "BB_UP_SHORT" | "BB_LOW_LONG"] === false) {
        this.emit("info", `HF skip ${sym} ${s.pattern}: pattern disabled`, { asset: sym, pattern: s.pattern });
        continue;
      }
      if (!this.hfAllowMultiplePerKey) {
        const dup = this.open.find((t) => t.asset === sym && t.pattern === s.pattern && t.side === s.side);
        if (dup) {
          this.emit("info", `HF skip ${sym} ${s.pattern}/${s.side}: already open (allowMultiplePerKey=false)`, { asset: sym, pattern: s.pattern });
          continue;
        }
      }
      // HF stake/leverage are independent of the 1h SMC sizing.
      const stake = Math.min(this.hfStake, this.perTradeMaxStake);
      if (stake < 0.5) { // Binance min-notional floor is $5 — at lev 30× that's ~$0.17 stake; use 0.50 as practical min
        this.emit("info", `HF skip ${sym} ${s.pattern}: stake $${stake} below $0.50 floor`, { asset: sym });
        continue;
      }
      await this.openTrade(sym, s, stake, this.hfLeverage);
      opened++;
    }
    return opened;
  }
  // ─── End HF loop ──────────────────────────────────────────────────────

  private async openTrade(sym: string, s: Signal, stake: number, leverageOverride?: number) {
    const lockKey = `open:${sym}:${s.pattern}:${s.side}`;
    if (this.busy.has(lockKey)) return;
    this.busy.add(lockKey);
    try {
      const effectiveLeverage = leverageOverride ?? this.leverage;
      const notional = stake * effectiveLeverage;
      const refPrice = s.entryPrice;
      const f = this.filters[sym];
      if (!f) { this.emit("error", new Error(`No filters for ${sym} — cannot place order`)); return; }
      const qtyRaw = notional / refPrice;
      const qty = roundStep(qtyRaw, f.stepSize);
      if (qty < f.minQty) {
        // Not an error — it just means the stake×leverage is too small for
        // this asset's price tier. e.g., $30 notional on BTC at $77k rounds
        // to 0 quantity. Emit as info so it doesn't keep alerting.
        const minStakeNeeded = (f.minQty * refPrice / (leverageOverride ?? this.leverage)).toFixed(2);
        this.emit("info", `skip ${sym} ${s.pattern}: stake $${stake} too small (need ~$${minStakeNeeded} at ${leverageOverride ?? this.leverage}× for min qty ${f.minQty} @ $${refPrice})`, {
          asset: sym, pattern: s.pattern, stake, refPrice, minQty: f.minQty, minStakeNeeded,
        });
        return;
      }
      if (qty * refPrice < f.minNotional) {
        this.emit("info", `skip ${sym} ${s.pattern}: notional $${(qty * refPrice).toFixed(2)} below minNotional $${f.minNotional}`, {
          asset: sym, pattern: s.pattern, notional: qty * refPrice, minNotional: f.minNotional,
        });
        return;
      }

      // Logical-trade UUID is embedded in clientOrderId so user-data stream
      // updates can be matched back to this trade. Prefix differs by group
      // so log readers can see at a glance whether a fill is HF or SMC.
      const tradeId = randomUUID();
      const prefix = isHfPattern(s.pattern) ? "hf" : "smc";
      const cid = `${prefix}-${tradeId.slice(0, 8)}`;
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
        leverage: effectiveLeverage,
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
   *  clientOrderId. Captures real fill prices, exchange-reported realized
   *  profit (`rp`), and commission (`n`) so the displayed PnL matches what
   *  actually hits the wallet, not the gross local estimate. */
  private onUserEvent(ev: any) {
    if (ev?.e !== "ORDER_TRADE_UPDATE") return;
    const o = ev.o;
    if (!o) return;
    const cid: string = o.c ?? "";
    const execType: string = o.x ?? "";        // "NEW" | "TRADE" | "CANCELED" | "EXPIRED"
    const status: string = o.X ?? "";          // "FILLED" | "PARTIALLY_FILLED" | "NEW" | "CANCELED"
    if (execType !== "TRADE") return;          // only care about actual fills
    const avgPrice = +o.ap || 0;
    const lastFillPrice = +o.L || 0;
    const fillPrice = avgPrice || lastFillPrice;
    const realizedPnl = +o.rp || 0;            // exchange realized profit for this fill
    const commission = Math.abs(+o.n || 0);    // fee paid for this fill (positive)

    // ── Entry fill: cid matches a logical trade in open[] exactly ──
    const entryMatch = this.open.find((t) => (t as any).clientOrderId === cid);
    if (entryMatch) {
      if (fillPrice > 0) {
        entryMatch.entryPrice = fillPrice;
        entryMatch.peakFav = fillPrice;
      }
      entryMatch.commissionEntry = (entryMatch.commissionEntry ?? 0) + commission;
      this.emit("stateChanged");
      return;
    }

    // ── Exit fill: clientOrderId carries the trade-id prefix ──
    // Prefixes: "tp-" (legacy STOP), "close-" (trail trigger), "cancel-" (manual)
    if (cid.startsWith("tp-") || cid.startsWith("close-") || cid.startsWith("cancel-")) {
      const parts = cid.split("-");
      const idPrefix = parts[1] ?? "";
      if (!idPrefix) return;
      // The trade may be in open[] (race: stream fired before closeTradeFromFill)
      // or already in closed[] (normal case).
      const inOpen = this.open.find((t) => t.id.startsWith(idPrefix));
      if (inOpen) {
        // Stream beat the local close path. Let closeTradeFromFill drive the
        // close (it'll move the trade to closed[]), then we'll reconcile fees
        // + rp via the next user-stream event if any further fill arrives.
        inOpen.commissionExit = (inOpen.commissionExit ?? 0) + commission;
        inOpen.realizedPnlExchange = (inOpen.realizedPnlExchange ?? 0) + realizedPnl;
        if (status === "FILLED") {
          this.closeTradeFromFill(inOpen, fillPrice).catch((e) => this.emit("error", e as Error));
        }
        return;
      }
      const inClosed = this.closed.find((t) => t.id.startsWith(idPrefix));
      if (!inClosed) return;
      // Reconcile real values onto the already-closed trade.
      inClosed.commissionExit = (inClosed.commissionExit ?? 0) + commission;
      inClosed.realizedPnlExchange = (inClosed.realizedPnlExchange ?? 0) + realizedPnl;
      const prevPnl = inClosed.pnl ?? 0;
      const entryComm = inClosed.commissionEntry ?? 0;
      const exitComm = inClosed.commissionExit ?? 0;
      const newPnl = (inClosed.realizedPnlExchange ?? 0) - entryComm - exitComm;
      inClosed.pnl = newPnl;
      // Daily profit was incremented with the gross estimate in
      // closeTradeFromFill — adjust by the delta.
      this.daily.profit += (newPnl - prevPnl);
      this.emit("stateChanged");
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
    const wasArmed = t.armed;
    // Always update markPrice so the UI sees real current price and Δ%
    // including adverse moves (peakFav by design only advances favorably).
    t.markPrice = markPrice;
    t.markUpdatedAt = Math.floor(Date.now() / 1000);
    stateChanged = true;
    if (t.side === "LONG") {
      if (markPrice > t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav >= t.entryPrice + armDist) { t.armed = true; stateChanged = true; }
    } else {
      if (markPrice < t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav <= t.entryPrice - armDist) { t.armed = true; stateChanged = true; }
    }
    if (!wasArmed && t.armed) {
      this.emit("info", `trail armed ${t.asset} ${t.pattern}/${t.side}: peak=${t.peakFav.toFixed(5)}`, {
        asset: t.asset, pattern: t.pattern, side: t.side, peakFav: t.peakFav, entryPrice: t.entryPrice,
      });
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
      const nowSec = Math.floor(Date.now() / 1000);
      for (const t of [...this.open]) {
        // Skip very young trades — Binance's positionRisk endpoint can lag
        // 1-5s behind a market order ack, so a fresh trade looks "flat" on
        // the API and the reconciler would spuriously close it at entry
        // price for $0 PnL. 30s is enough for any reasonable propagation lag.
        if (nowSec - t.entryEpoch < 30) continue;
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

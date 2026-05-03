// BOOM 600 + 900 fresh strategy screen — 5 novel frameworks, none using
// the existing spike-fade / drift-fade / breakout-mean-rev detectors.
// All use FIXED R:R ≥ 2:1 so mart math can actually work.
//
// A) RSI-EXTREME      RSI<25 BUY / RSI>75 SELL, TP=2×ATR  SL=1×ATR
// B) BOLL-MEAN        close>BB_upper SELL / close<BB_lower BUY, TP=midband, SL=2×ATR
// C) RANGE-BREAK      5-bar range<0.4×ATR(20) → break direction, TP=2×ATR  SL=1×ATR
// D) DONCHIAN-PULLBK  20-bar high → pullback to midline, BUY mid-bounce, TP=high SL=mid-1×ATR
// E) THREE-BAR-REV    3 consecutive lower-lows then higher close → BUY, TP=2×ATR  SL=last-low

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const PER_TRADE_CAP = Number(process.env.CAP ?? 30);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;
const ATR_PERIOD = 14;

const ASSETS = ["BOOM600", "BOOM900"];

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

const WINDOWS = [
  { offset: 4, startH: 0, endH: 24, label: "4d" },
  { offset: 7, startH: 8, endH: 32, label: "7d" },
  { offset: 12, startH: 20, endH: 44, label: "12d" },
  { offset: 20, startH: 4, endH: 28, label: "20d" },
  { offset: 25, startH: 16, endH: 40, label: "25d" },
];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch { /* */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = end;
  while (candles.length < count) {
    const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch);
    cursor = ch[0].epoch - 1;
    if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

function rsi(c: Candle[], i: number, period = 14): number {
  if (i < period) return 50;
  let gain = 0, loss = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const diff = c[j].close - c[j - 1].close;
    if (diff > 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

function bb(c: Candle[], i: number, period = 20, k = 2): { mid: number; up: number; lo: number } {
  if (i < period) return { mid: c[i].close, up: c[i].close, lo: c[i].close };
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += c[j].close;
  const mid = sum / period;
  let v = 0;
  for (let j = i - period + 1; j <= i; j++) v += (c[j].close - mid) ** 2;
  const sd = Math.sqrt(v / period);
  return { mid, up: mid + k * sd, lo: mid - k * sd };
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };
type Strat = "RSI" | "BOLL" | "RANGE" | "DONCH" | "THREE";

function detect(candles: Candle[], strat: Strat): Sig[] {
  const out: Sig[] = [];
  const start = Math.max(ATR_PERIOD, 22);
  for (let i = start; i < candles.length; i++) {
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    const cur = candles[i];

    if (strat === "RSI") {
      const r = rsi(candles, i, 14);
      if (r > 75) {
        const entry = cur.close;
        const stop = entry + 1.0 * a;
        const target = entry - 2.0 * a;
        if (target > 0 && stop > entry) out.push({ idx: i, side: "SELL", entry, stop, target });
      } else if (r < 25) {
        const entry = cur.close;
        const stop = entry - 1.0 * a;
        const target = entry + 2.0 * a;
        if (target > 0 && stop < entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }

    else if (strat === "BOLL") {
      const b = bb(candles, i, 20, 2);
      if (cur.close > b.up) {
        const entry = cur.close;
        const stop = entry + 2.0 * a;
        const target = b.mid;
        if (target < entry && target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      } else if (cur.close < b.lo) {
        const entry = cur.close;
        const stop = entry - 2.0 * a;
        const target = b.mid;
        if (target > entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }

    else if (strat === "RANGE") {
      const aBig = atr(candles, i - 1, 20);
      let hi = -Infinity, lo = Infinity;
      for (let m = i - 5; m < i; m++) {
        if (candles[m].high > hi) hi = candles[m].high;
        if (candles[m].low < lo) lo = candles[m].low;
      }
      if (hi - lo < 0.4 * aBig) {
        if (cur.close > hi) {
          const entry = cur.close;
          const stop = entry - 1.0 * a;
          const target = entry + 2.0 * a;
          if (target > 0) out.push({ idx: i, side: "BUY", entry, stop, target });
        } else if (cur.close < lo) {
          const entry = cur.close;
          const stop = entry + 1.0 * a;
          const target = entry - 2.0 * a;
          if (target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
        }
      }
    }

    else if (strat === "DONCH") {
      let hi = -Infinity, lo = Infinity;
      for (let m = i - 20; m < i; m++) {
        if (candles[m].high > hi) hi = candles[m].high;
        if (candles[m].low < lo) lo = candles[m].low;
      }
      const mid = (hi + lo) / 2;
      const prev = candles[i - 1];
      if (prev.close < mid && cur.close > mid && cur.close > cur.open) {
        const entry = cur.close;
        const stop = mid - 1.0 * a;
        const target = hi;
        if (target > entry && stop < entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      } else if (prev.close > mid && cur.close < mid && cur.close < cur.open) {
        const entry = cur.close;
        const stop = mid + 1.0 * a;
        const target = lo;
        if (target < entry && target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      }
    }

    else if (strat === "THREE") {
      // 3 consecutive lower lows then a higher close = BUY
      const c1 = candles[i - 3], c2 = candles[i - 2], c3 = candles[i - 1];
      if (c2.low < c1.low && c3.low < c2.low && cur.close > c3.high) {
        const entry = cur.close;
        const stop = c3.low;
        const target = entry + 2.0 * a;
        if (stop < entry && target > 0) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
      // 3 consecutive higher highs then a lower close = SELL
      else if (c2.high > c1.high && c3.high > c2.high && cur.close < c3.low) {
        const entry = cur.close;
        const stop = c3.high;
        const target = entry - 2.0 * a;
        if (stop > entry && target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      }
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], sigs: Sig[], ws: number, we: number) {
  const filtered = sigs.filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;

  for (const sig of filtered) {
    if (bust || ddPaused) break;
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (sig.side === "BUY") {
        if (b.low <= stop) { exit = "sl"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= target) { exit = "tp"; exitPrice = target; break; }
      } else {
        if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
      }
    }
    if (!exit) continue;
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak };
}

async function main() {
  console.log(`BOOM 600+900 fresh-strategy screen (TP≥2×ATR, SL=1-2×ATR, 2:1 R:R or better)`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}\n`);

  const c = new C(); await c.ready;
  type Row = { sym: string; strat: Strat; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];
  const strats: Strat[] = ["RSI", "BOLL", "RANGE", "DONCH", "THREE"];

  for (const sym of ASSETS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Candle[] | null = null;
      try { candles = await fetchPaged(c, sym, 60, 5000, we_); }
      catch (e) { continue; }
      for (const s of strats) {
        const sigs = detect(candles, s);
        const r = honestSim(candles, sigs, ws_, we_);
        const wr = r.trades > 0 ? r.wins / r.trades : 0;
        const status = r.bust ? "BUST" : r.ddPaused ? "DD" : r.trades === 0 ? "—" : "ok";
        rows.push({ sym, strat: s, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
      }
    }
  }
  c.close();

  for (const sym of ASSETS) {
    console.log(`\n══ ${sym}  ═══════════════════════════════════════════════`);
    console.log(`  strat   net Δ      trades  bust/DD  WR    detail`);
    for (const s of strats) {
      const arr = rows.filter((r) => r.sym === sym && r.strat === s);
      const winners = arr.filter((r) => r.final > ACCT).length;
      const busts = arr.filter((r) => r.status === "BUST" || r.status === "DD").length;
      const tot = arr.reduce((sum, r) => sum + (r.final - ACCT), 0);
      const totT = arr.reduce((sum, r) => sum + r.trades, 0);
      const totW = arr.reduce((sum, r) => sum + r.trades * r.wr, 0);
      const wr = totT > 0 ? totW / totT : 0;
      const detail = arr.map((r) => `${r.window}=${(r.final - ACCT >= 0 ? "+" : "") + (r.final - ACCT).toFixed(0)}${r.status === "DD" ? "(DD)" : r.status === "BUST" ? "(BUST)" : ""}`).join(" ");
      console.log(`  ${s.padEnd(6)}  ${tot >= 0 ? "+" : ""}$${tot.toFixed(2).padStart(7)}   ${String(totT).padStart(4)}t   ${winners}W ${busts}b   ${(wr*100).toFixed(0)}%   ${detail}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

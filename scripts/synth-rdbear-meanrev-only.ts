// RDBEAR breakout 5m — TRADE ONLY WHEN MEAN-REVERTING.
//
// "Efficiency ratio" (Kaufman) over last N bars detects regime:
//   eff = |close[i] - close[i-N]| / sum(|close[j] - close[j-1]| for j in window)
//   • eff > TREND_THRESH (e.g. 0.45)  → strong directional trend → SKIP all trades
//   • eff < CHOP_THRESH (e.g. 0.30)   → mean-reverting / choppy → AGAINST mode (fade)
//   • in between (transitional)       → SKIP (no clear edge)
//
// On RDBEAR (a mean-reverting bear synth), AGAINST mode = fade local breakouts.
// During genuine sustained trends, the strategy stays out entirely.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE = Number(process.env.STAKE ?? 10);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 100);
const HTF_SMA_PERIOD = Number(process.env.HTF_SMA ?? 12);
const SLOPE_BARS = Number(process.env.SLOPE_BARS ?? 6);
const MIN_ADX = Number(process.env.MIN_ADX ?? 22);
const EFF_WINDOW = Number(process.env.EFF_WINDOW ?? 24);
const TREND_THRESH = Number(process.env.TREND_THRESH ?? 0.45);
const CHOP_THRESH = Number(process.env.CHOP_THRESH ?? 0.30);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAY_OFFSET = Number(process.env.DAY_OFFSET ?? 4);
const START_HOUR = Number(process.env.START_HOUR ?? 0);
const END_HOUR = Number(process.env.END_HOUR ?? 48);
const TARGET_DAY_START = TODAY_START - DAY_OFFSET * 86400;
const ws = TARGET_DAY_START + START_HOUR * 3600;
const we = TARGET_DAY_START + END_HOUR * 3600;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "lb15 kAtr2.0 momR0.70", lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "lb15 kAtr2.5 momR0.70", lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { name: "lb20 kAtr2.5 momR0.70", lookback: 20, kAtr: 2.5, momRatio: 0.70 },
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout req_id=${id}`)); } }, 30_000);
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

function adx(c: Candle[], i: number, period = 14): number {
  if (i < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const upMove = c[j].high - c[j - 1].high;
    const dnMove = c[j - 1].low - c[j].low;
    const pdm = upMove > dnMove && upMove > 0 ? upMove : 0;
    const ndm = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    plusDM += pdm; minusDM += ndm;
    tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
}

// Kaufman efficiency ratio: net-move / sum-of-absolute-moves over last N bars.
// 1.0 = pure trend, 0.0 = pure chop.
function efficiency(c: Candle[], i: number, window: number): number {
  if (i < window) return 0;
  const netMove = Math.abs(c[i].close - c[i - window].close);
  let sumAbs = 0;
  for (let j = i - window + 1; j <= i; j++) sumAbs += Math.abs(c[j].close - c[j - 1].close);
  return sumAbs > 0 ? netMove / sumAbs : 0;
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number; eff: number };

function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  const atrPeriod = 14;
  for (let i = Math.max(v.lookback, atrPeriod * 2, EFF_WINDOW) + 1; i < candles.length; i++) {
    const a = atr(candles, i, atrPeriod);
    if (a <= 0) continue;
    const ad = adx(candles, i, 14);
    if (ad < MIN_ADX) continue;
    const eff = efficiency(candles, i, EFF_WINDOW);
    // ONLY trade when in chop regime (eff < CHOP_THRESH). Skip when trending
    // (eff > TREND_THRESH) AND when in transitional zone (in between).
    if (eff >= CHOP_THRESH) continue;

    let hi = -Infinity, lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = v.kAtr * a;

    // Mean-reversion: FADE the breakout. Up-pierce with momentum → SELL (expect retrace).
    // Down-pierce with momentum → BUY (expect bounce).
    if (cur.close > hi && closePosUp >= v.momRatio) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist, eff });
    } else if (cur.close < lo && closePosDn >= v.momRatio) {
      out.push({ idx: i, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist, eff });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], v: Variant) {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trough = ACCT;
  let buyCount = 0, sellCount = 0;
  let trades = 0, wins = 0, losses = 0;
  const DD_FRAC = Number(process.env.DD_FRAC ?? 0); // 0 = disabled

  for (const sig of sigs) {
    if (ddPaused) break; // hard pause once tripped
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
    if (balance < trough) trough = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    if (sig.side === "BUY") buyCount++; else sellCount++;
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) {
      ddPaused = true;
    }
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak, trough, buyCount, sellCount };
}

async function main() {
  const dateStr = new Date(TARGET_DAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST sim — RDBEAR breakout 5m  MEAN-REV-ONLY (skip when trending)`);
  console.log(`${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  (${(END_HOUR-START_HOUR)}h)`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L`);
  console.log(`Efficiency window=${EFF_WINDOW} bars  trend≥${TREND_THRESH} (skip)  chop<${CHOP_THRESH} (trade AGAINST)\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  variant                   trades  B/S    W/L      WR    final     Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const r = honestSim(candles, v);
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const status = r.bust ? "💀 BUST" : r.ddPaused ? "⏸ DD-paused" : r.trades === 0 ? "— no trades" : "✓";
    const dPct = ((r.finalBal - ACCT) / ACCT * 100).toFixed(0);
    console.log(`  ${v.name.padEnd(24)}  ${String(r.trades).padStart(3)}t  ${String(r.buyCount).padStart(3)}/${String(r.sellCount).padStart(3)}  ${r.wins}W/${r.losses}L  ${(wr*100).toFixed(0).padStart(2)}%  $${r.finalBal.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

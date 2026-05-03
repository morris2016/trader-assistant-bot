// BOOM 600/900 post-spike windowed-SELL.
// Premise: after a spike fires, the asset has "spent" its up-volatility budget
// for ~N bars (refractory window). Statistically the next big move is much
// more likely to be drift than another spike. Strategy:
//   1. Detect spike bar (range >= 3×ATR, bullish).
//   2. For the next K bars (refractory window), SELL on each green-pullback bar.
//   3. SL just above current local high, TP=0.5×ATR (drift size).
// This concentrates SELL trades into the safest part of the cycle.

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
const SPIKE_NATR = 3.0;
const TP_ATR = 0.5;
const SL_BUF_ATR = 0.2;

// REFRACTORY: how many bars after a spike are we "safe" to sell?
// 1m bars on BOOM600: spike avg every ~10 min → after spike, expect 10-15 quiet bars.
// We test 5/10/15/20 to find best window.
const REFRACTORY_WINDOWS = [5, 10, 15, 20, 30];

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

type Sig = { idx: number; side: "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], refractory: number): Sig[] {
  const out: Sig[] = [];
  // Mark spike-bar indices first
  const spikeIdx: number[] = [];
  for (let i = ATR_PERIOD; i < candles.length; i++) {
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    const b = candles[i];
    if ((b.high - b.low) >= SPIKE_NATR * a && b.close > b.open) spikeIdx.push(i);
  }
  // For each bar, check if it's within refractory window after the most recent spike
  let nextSpikePtr = 0;
  let lastSpikeAt = -Infinity;
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    while (nextSpikePtr < spikeIdx.length && spikeIdx[nextSpikePtr] <= i) {
      lastSpikeAt = spikeIdx[nextSpikePtr];
      nextSpikePtr++;
    }
    const barsSinceSpike = i - lastSpikeAt;
    if (barsSinceSpike < 1 || barsSinceSpike > refractory) continue; // outside safe window
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    const prev = candles[i - 1];
    const cur = candles[i];
    // Pullback signal: green-then-red
    if (!(prev.close > prev.open && cur.close < cur.open)) continue;
    const entry = cur.close;
    const stop = Math.max(prev.high, cur.high) + SL_BUF_ATR * a;
    const target = entry - TP_ATR * a;
    if (stop <= entry || target <= 0) continue;
    out.push({ idx: i, side: "SELL", entry, stop, target });
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
    if (ddPaused) break;
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
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
  console.log(`BOOM 600+900 post-spike refractory SELL — drift-fade in safe window`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}\n`);

  const c = new C(); await c.ready;
  type Row = { sym: string; ref: number; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];

  for (const sym of ASSETS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Candle[] | null = null;
      try { candles = await fetchPaged(c, sym, 60, 5000, we_); }
      catch (e) { console.log(`  ${sym} ${win.label}: fetch fail`); continue; }
      for (const ref of REFRACTORY_WINDOWS) {
        const sigs = detect(candles, ref);
        const r = honestSim(candles, sigs, ws_, we_);
        const wr = r.trades > 0 ? r.wins / r.trades : 0;
        const status = r.bust ? "BUST" : r.ddPaused ? "DD" : r.trades === 0 ? "—" : "ok";
        rows.push({ sym, ref, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
      }
    }
  }
  c.close();

  for (const sym of ASSETS) {
    for (const ref of REFRACTORY_WINDOWS) {
      const arr = rows.filter((r) => r.sym === sym && r.ref === ref);
      const winners = arr.filter((r) => r.final > ACCT).length;
      const busts = arr.filter((r) => r.status === "BUST" || r.status === "DD").length;
      const tot = arr.reduce((s, r) => s + (r.final - ACCT), 0);
      const totT = arr.reduce((s, r) => s + r.trades, 0);
      console.log(`${sym}  ref=${String(ref).padStart(2)}  ${winners}W  ${busts} bust/DD  Δ ${tot >= 0 ? "+" : ""}$${tot.toFixed(2).padStart(7)}  ${String(totT).padStart(4)}t`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

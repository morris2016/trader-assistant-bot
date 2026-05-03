// Cast a wide net — apply the validated spike-fade detector to every Deriv
// synth with spike-like or jump-like behavior we haven't tested.
// Universe:
//   BOOM/CRASH 500      — between 300N (works) and 600 (dead) cadence
//   JD10/25/50/75/100   — jump 1-second indices, bidirectional
//   RB100/200           — range break
// For BOOM_ test SELL only, CRASH_ test BUY only, JD_/RB_ test both sides.

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

const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.2;
const TP_FRAC_OF_SPIKE = 0.5;
const ATR_PERIOD = 14;

// Test universe — fresh assets, validated detector
const ASSETS: Array<{ sym: string; sides: ("BUY" | "SELL")[] }> = [
  { sym: "BOOM500",   sides: ["SELL"] },
  { sym: "CRASH500",  sides: ["BUY"] },
  { sym: "JD10",      sides: ["BUY", "SELL"] },
  { sym: "JD25",      sides: ["BUY", "SELL"] },
  { sym: "JD50",      sides: ["BUY", "SELL"] },
  { sym: "JD75",      sides: ["BUY", "SELL"] },
  { sym: "JD100",     sides: ["BUY", "SELL"] },
  { sym: "RB100",     sides: ["BUY", "SELL"] },
  { sym: "RB200",     sides: ["BUY", "SELL"] },
];

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

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    if (side === "SELL") {
      if (!(spike.close > spike.open)) continue;
      if (!(confirm.close < spike.close)) continue;
      const entry = confirm.close;
      const stop = spike.high + BUFFER_ATR * a;
      const target = entry - TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop <= entry) continue;
      out.push({ idx: i, side: "SELL", entry, stop, target });
    } else {
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close > spike.close)) continue;
      const entry = confirm.close;
      const stop = spike.low - BUFFER_ATR * a;
      const target = entry + TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop >= entry) continue;
      out.push({ idx: i, side: "BUY", entry, stop, target });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], side: "BUY" | "SELL", ws: number, we: number) {
  const sigs = detect(candles, side).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;

  for (const sig of sigs) {
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
  console.log(`Other-asset spike-fade screen — validated detector across new universe @ 1m`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}\n`);

  const c = new C(); await c.ready;
  type Row = { sym: string; side: "BUY" | "SELL"; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];

  for (const a of ASSETS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Candle[] | null = null;
      try { candles = await fetchPaged(c, a.sym, 60, 5000, we_); }
      catch (e) {
        console.log(`  ${a.sym} ${win.label}: fetch fail ${(e as Error).message}`);
        continue;
      }
      for (const side of a.sides) {
        const r = honestSim(candles, side, ws_, we_);
        const wr = r.trades > 0 ? r.wins / r.trades : 0;
        const status = r.bust ? "BUST" : r.ddPaused ? "DD" : r.trades === 0 ? "—" : "ok";
        rows.push({ sym: a.sym, side, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
      }
    }
  }
  c.close();

  console.log(`\n${"".padEnd(70, "═")}`);
  console.log(`PER-ASSET SUMMARY (5 windows each)`);
  console.log(`${"".padEnd(70, "═")}`);
  console.log(`  asset       side    trades    W   bust/DD   net Δ        WR`);

  for (const a of ASSETS) {
    for (const side of a.sides) {
      const arr = rows.filter((r) => r.sym === a.sym && r.side === side);
      const winners = arr.filter((r) => r.final > ACCT).length;
      const busts = arr.filter((r) => r.status === "BUST" || r.status === "DD").length;
      const tot = arr.reduce((s, r) => s + (r.final - ACCT), 0);
      const totT = arr.reduce((s, r) => s + r.trades, 0);
      const totW = arr.reduce((s, r) => s + r.trades * r.wr, 0);
      const wr = totT > 0 ? totW / totT : 0;
      const flag = winners >= 4 && busts === 0 ? " ★" : winners >= 3 && busts === 0 ? " ✓" : "";
      console.log(`  ${a.sym.padEnd(10)}  ${side.padEnd(4)}  ${String(totT).padStart(5)}t   ${winners}/5   ${busts}/5     ${tot >= 0 ? "+" : ""}$${tot.toFixed(2).padStart(7)}    ${(wr*100).toFixed(0)}%${flag}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

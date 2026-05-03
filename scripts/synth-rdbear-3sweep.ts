// RDBEAR breakout 5m — 3 independent parameter sweeps on 01:00-09:00 UTC.
// Honest Deriv sim. Looking for sweeps that CHANGE which trades get taken
// (not just scale the same trades like kAtr did).
//   1. momRatio:  0.60 / 0.65 / 0.70 / 0.75 / 0.80
//   2. lookback:  10 / 12 / 15 / 18 / 20
//   3. atrPeriod: 7 / 10 / 14 / 21
// Baseline (other params held at validated values) for each sweep.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;
const START_HOUR = Number(process.env.START_HOUR ?? 1);
const END_HOUR = Number(process.env.END_HOUR ?? 9);
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

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

type Sig = { idx: number; entry: number; stop: number; target: number };
function detect(candles: Candle[], lookback: number, kAtr: number, momR: number, atrPeriod: number): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(lookback, atrPeriod) + 1; i < candles.length; i++) {
    const a = atr(candles, i, atrPeriod);
    if (a <= 0) continue;
    let lo = Infinity;
    for (let m = i - lookback; m < i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    if (!(cur.close < lo)) continue;
    const closePosDn = (cur.high - cur.close) / r;
    if (closePosDn < momR) continue;
    const dist = kAtr * a;
    out.push({ idx: i, entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { sigEpoch: number; net: number };

function honestSim(candles: Candle[], lookback: number, kAtr: number, momR: number, atrPeriod: number, ws: number, we: number): Trade[] {
  const sigs = detect(candles, lookback, kAtr, momR, atrPeriod).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  const trades: Trade[] = [];
  for (const sig of sigs) {
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    const commission = round2(STAKE * COMMISSION_FRAC);
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    const net = round2(STAKE * MULT * move - commission);
    trades.push({ sigEpoch: candles[sig.idx].epoch, net });
  }
  return trades;
}

function summarize(trades: Trade[], windowStart: number, hoursCovered: number): { trades: number; wins: number; losses: number; wr: number; net: number; expR: number; concentration: string } {
  let wins = 0, losses = 0, net = 0;
  for (const t of trades) {
    net += t.net;
    if (t.net > 0) wins++; else if (t.net < 0) losses++;
  }
  const concentration: string[] = [];
  for (let h = 0; h < hoursCovered; h++) {
    const ws = windowStart + h * 3600;
    const we = ws + 3600;
    const hourTrades = trades.filter((t) => t.sigEpoch >= ws && t.sigEpoch < we);
    if (hourTrades.length === 0) concentration.push(".");
    else {
      const hNet = hourTrades.reduce((s, t) => s + t.net, 0);
      concentration.push(hNet > 0 ? "+" : hNet < 0 ? "-" : "0");
    }
  }
  return {
    trades: trades.length, wins, losses,
    wr: trades.length > 0 ? wins / trades.length : 0,
    net,
    expR: trades.length > 0 ? net / (trades.length * STAKE) : 0,
    concentration: concentration.join(""),
  };
}

async function main() {
  const dateStr = new Date(TODAY_START * 1000).toISOString().slice(0, 10);
  const ws = TODAY_START + START_HOUR * 3600;
  const we = TODAY_START + END_HOUR * 3600;
  const hoursCovered = END_HOUR - START_HOUR;

  console.log(`HONEST sim — RDBEAR breakout 5m  ·  ${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  ·  3 parameter sweeps\n`);
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  // Sweep 1: momRatio (kAtr=2.0, lookback=15, atrPeriod=14)
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SWEEP 1 — momRatio (kAtr=2.0, lookback=15, atrPeriod=14)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  momR     trades  W/L     WR     net      expR    hourly`);
  for (const m of [0.60, 0.65, 0.70, 0.75, 0.80]) {
    const t = honestSim(candles, 15, 2.0, m, 14, ws, we);
    const s = summarize(t, ws, hoursCovered);
    console.log(`  ${m.toFixed(2)}     ${String(s.trades).padStart(2)}t   ${s.wins}W/${s.losses}L  ${(s.wr*100).toFixed(0).padStart(3)}%  ${(s.net >= 0 ? "+" : "") + "$" + s.net.toFixed(2).padStart(7)}  ${s.expR.toFixed(2).padStart(5)}   ${s.concentration}`);
  }

  // Sweep 2: lookback (kAtr=2.0, momR=0.70, atrPeriod=14)
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SWEEP 2 — lookback (kAtr=2.0, momR=0.70, atrPeriod=14)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  lookback  trades  W/L     WR     net      expR    hourly`);
  for (const lb of [10, 12, 15, 18, 20]) {
    const t = honestSim(candles, lb, 2.0, 0.70, 14, ws, we);
    const s = summarize(t, ws, hoursCovered);
    console.log(`  ${String(lb).padStart(2)}        ${String(s.trades).padStart(2)}t   ${s.wins}W/${s.losses}L  ${(s.wr*100).toFixed(0).padStart(3)}%  ${(s.net >= 0 ? "+" : "") + "$" + s.net.toFixed(2).padStart(7)}  ${s.expR.toFixed(2).padStart(5)}   ${s.concentration}`);
  }

  // Sweep 3: atrPeriod (kAtr=2.0, momR=0.70, lookback=15)
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SWEEP 3 — atrPeriod (kAtr=2.0, momR=0.70, lookback=15)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  atrPer    trades  W/L     WR     net      expR    hourly`);
  for (const ap of [7, 10, 14, 21]) {
    const t = honestSim(candles, 15, 2.0, 0.70, ap, ws, we);
    const s = summarize(t, ws, hoursCovered);
    console.log(`  ${String(ap).padStart(2)}        ${String(s.trades).padStart(2)}t   ${s.wins}W/${s.losses}L  ${(s.wr*100).toFixed(0).padStart(3)}%  ${(s.net >= 0 ? "+" : "") + "$" + s.net.toFixed(2).padStart(7)}  ${s.expR.toFixed(2).padStart(5)}   ${s.concentration}`);
  }

  console.log(`\n  hourly key: + winning hour, - losing hour, . no trades, 0 scratch`);
  console.log(`  hours covered: ${START_HOUR}:00 to ${END_HOUR}:00 UTC (${hoursCovered}h)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

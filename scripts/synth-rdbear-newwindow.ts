// RDBEAR breakout 5m — different 8-hour window with $20 acct / $5 stake.
// Window: yesterday 12:00→20:00 UTC (2026-04-30) — known to have ~5 active
// hours from previous per-hour breakdown.
// Tracks running balance through the window so the bust risk is visible.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = Number(process.env.STAKE ?? 5);
const ACCT = Number(process.env.ACCT ?? 20);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;

// YESTERDAY 12:00→20:00 UTC by default (different from today 01-09 already tested).
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAY_OFFSET = Number(process.env.DAY_OFFSET ?? 1); // 1 = yesterday
const START_HOUR = Number(process.env.START_HOUR ?? 12);
const END_HOUR = Number(process.env.END_HOUR ?? 20);

const TARGET_DAY_START = TODAY_START - DAY_OFFSET * 86400;
const ws = TARGET_DAY_START + START_HOUR * 3600;
const we = TARGET_DAY_START + END_HOUR * 3600;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number; atrPeriod: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline      (15/2.0/0.70/14)", lookback: 15, kAtr: 2.0, momRatio: 0.70, atrPeriod: 14 },
  { name: "#2 tighter momR  (15/2.0/0.75/14)", lookback: 15, kAtr: 2.0, momRatio: 0.75, atrPeriod: 14 },
  { name: "#7 higher kAtr   (15/2.5/0.70/14)", lookback: 15, kAtr: 2.5, momRatio: 0.70, atrPeriod: 14 },
  { name: "#X atrP=10       (15/2.0/0.70/10)", lookback: 15, kAtr: 2.0, momRatio: 0.70, atrPeriod: 10 },
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

type Sig = { idx: number; entry: number; stop: number; target: number };
function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(v.lookback, v.atrPeriod) + 1; i < candles.length; i++) {
    const a = atr(candles, i, v.atrPeriod);
    if (a <= 0) continue;
    let lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    if (!(cur.close < lo)) continue;
    const closePosDn = (cur.high - cur.close) / r;
    if (closePosDn < v.momRatio) continue;
    const dist = v.kAtr * a;
    out.push({ idx: i, entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { sigEpoch: number; closeEpoch: number; net: number; exit: "tp" | "sl"; balanceBefore: number; balanceAfter: number };

function honestSim(candles: Candle[], v: Variant): Trade[] {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  const trades: Trade[] = [];
  let balance = ACCT;
  for (const sig of sigs) {
    if (sig.idx + 1 >= candles.length) continue;
    if (balance < STAKE + STAKE * COMMISSION_FRAC) break; // can't afford next stake → bust
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    const commission = round2(STAKE * COMMISSION_FRAC);
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    let exitEpoch = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; exitEpoch = b.epoch; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; exitEpoch = b.epoch; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    const net = round2(STAKE * MULT * move - commission);
    const before = balance;
    balance = round2(balance + net);
    trades.push({ sigEpoch: candles[sig.idx].epoch, closeEpoch: exitEpoch, net, exit, balanceBefore: before, balanceAfter: balance });
  }
  return trades;
}

async function main() {
  const dateStr = new Date(TARGET_DAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST sim — RDBEAR breakout 5m  ·  ${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  ·  ACCT=$${ACCT}  STAKE=$${STAKE}\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  for (const v of VARIANTS) {
    const trades = honestSim(candles, v);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`${v.name}`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
    if (trades.length === 0) { console.log("  no trades in window\n"); continue; }
    let wins = 0, losses = 0, net = 0, sumR = 0;
    for (const t of trades) { net += t.net; sumR += t.net / STAKE; if (t.net > 0) wins++; else if (t.net < 0) losses++; }
    const wr = wins / trades.length;
    const finalBal = trades[trades.length - 1].balanceAfter;
    const peak = trades.reduce((p, t) => Math.max(p, t.balanceAfter), ACCT);
    const trough = trades.reduce((p, t) => Math.min(p, t.balanceAfter), ACCT);
    console.log(`  ${trades.length}t · ${wins}W/${losses}L · WR ${(wr*100).toFixed(0)}% · NET ${net >= 0 ? "+" : ""}$${net.toFixed(2)} · expR ${(sumR/trades.length).toFixed(2)}`);
    console.log(`  ACCOUNT: started $${ACCT.toFixed(2)} → ended $${finalBal.toFixed(2)}  (${((finalBal-ACCT)/ACCT*100).toFixed(1)}%)  peak $${peak.toFixed(2)} trough $${trough.toFixed(2)}`);
    console.log(`\n  ${"sigT".padEnd(8)}  ${"closeT".padEnd(8)}  exit   net      ${"bal_before".padStart(10)}  ${"bal_after".padStart(9)}`);
    for (const t of trades) {
      const sT = new Date(t.sigEpoch * 1000).toISOString().slice(11, 19);
      const cT = new Date(t.closeEpoch * 1000).toISOString().slice(11, 19);
      console.log(`  ${sT}  ${cT}  ${t.exit}   ${t.net >= 0 ? "+" : ""}$${t.net.toFixed(2).padStart(7)}     $${t.balanceBefore.toFixed(2).padStart(7)}    $${t.balanceAfter.toFixed(2).padStart(7)}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

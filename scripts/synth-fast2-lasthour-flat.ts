// Simulate the last hour of real Deriv trading on Fast2 stack at flat stake.
// $20 acct, $3 stake, no mart, all 3 strategies firing in parallel.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT_INIT = 20;
const STAKE = 3;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const MIN_STAKE = 0.31;

// Detector params (matching production — TP=0.7 / buf=0.05 since 2026-05-02)
const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.05;
const TP_FRAC_OF_SPIKE = 0.7;
const ATR_PERIOD = 14;
const RDBEAR_LOOKBACK = 15;
const RDBEAR_KATR = 2.5;
const RDBEAR_MOM = 0.7;

const NOW = Math.floor(Date.now() / 1000);
const HOURS = Number(process.env.HOURS ?? 1);
const HOUR_AGO = NOW - HOURS * 3600;

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

type Sig = { idx: number; epoch: number; sym: string; strat: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

// Spike-fade detector for BOOM/CRASH
function spikeFade(candles: Candle[], sym: string, side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    let entry = 0, stop = 0, target = 0;
    if (side === "SELL") {
      if (!(spike.close > spike.open)) continue;
      if (!(confirm.close < spike.close)) continue;
      entry = confirm.close;
      stop = spike.high + BUFFER_ATR * a;
      target = entry - TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop <= entry) continue;
    } else {
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close > spike.close)) continue;
      entry = confirm.close;
      stop = spike.low - BUFFER_ATR * a;
      target = entry + TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop >= entry) continue;
    }
    out.push({ idx: i, epoch: confirm.epoch, sym, strat: `${sym}_spike`, side, entry, stop, target });
  }
  return out;
}

// RDBEAR breakout-mean-rev (no regime)
function rdbearMeanRev(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = RDBEAR_LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    let hi = -Infinity;
    for (let m = i - RDBEAR_LOOKBACK; m < i; m++) if (candles[m].high > hi) hi = candles[m].high;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const dist = RDBEAR_KATR * a;
    if (cur.close > hi && closePosUp >= RDBEAR_MOM) {
      out.push({ idx: i, epoch: cur.epoch, sym: "RDBEAR", strat: "RDBEAR_meanrev", side: "SELL",
        entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { ts: string; strat: string; sym: string; side: string; stake: number; result: "TP" | "SL" | "OPEN"; pnl: number; bal: number };

async function main() {
  const fromTs = new Date(HOUR_AGO * 1000).toISOString().slice(11, 16);
  const toTs = new Date(NOW * 1000).toISOString().slice(11, 16);
  console.log(`Fast2 last-hour live simulation — ${fromTs} → ${toTs} UTC`);
  console.log(`ACCT=$${ACCT_INIT}  STAKE=$${STAKE}  NO MART  NO DD  flat-stake\n`);

  const c = new C(); await c.ready;
  // Need enough history for indicators (ATR-14 + RDBEAR lookback)
  const need1m = HOURS * 60 + 250;
  const need5m = HOURS * 12 + 250;
  const [boomCandles, crashCandles, rdbearCandles] = await Promise.all([
    fetchPaged(c, "BOOM300N", 60, need1m, NOW),
    fetchPaged(c, "CRASH300N", 60, need1m, NOW),
    fetchPaged(c, "RDBEAR", 300, need5m, NOW),
  ]);
  c.close();
  console.log(`Bars fetched: BOOM300N=${boomCandles.length} (1m)  CRASH300N=${crashCandles.length} (1m)  RDBEAR=${rdbearCandles.length} (5m)\n`);

  // Generate signals
  const sigsBoom = spikeFade(boomCandles, "BOOM300N", "SELL").filter((s) => s.epoch >= HOUR_AGO);
  const sigsCrash = spikeFade(crashCandles, "CRASH300N", "BUY").filter((s) => s.epoch >= HOUR_AGO);
  const sigsRdbear = rdbearMeanRev(rdbearCandles).filter((s) => s.epoch >= HOUR_AGO);

  // Map sym → candles for resolution
  const candlesByStrat = new Map<string, Candle[]>();
  candlesByStrat.set("BOOM300N_spike", boomCandles);
  candlesByStrat.set("CRASH300N_spike", crashCandles);
  candlesByStrat.set("RDBEAR_meanrev", rdbearCandles);

  type S = { sig: Sig; candles: Candle[] };
  const all: S[] = [];
  for (const s of sigsBoom)   all.push({ sig: s, candles: boomCandles });
  for (const s of sigsCrash)  all.push({ sig: s, candles: crashCandles });
  for (const s of sigsRdbear) all.push({ sig: s, candles: rdbearCandles });
  all.sort((a, b) => a.sig.epoch - b.sig.epoch);

  console.log(`Signals fired in last hour: ${all.length}  (BOOM=${sigsBoom.length}, CRASH=${sigsCrash.length}, RDBEAR=${sigsRdbear.length})\n`);

  // Sequential simulation — flat stake, persistent shared balance
  let balance = ACCT_INIT;
  const trades: Trade[] = [];
  let bust = false;

  for (const { sig, candles } of all) {
    if (bust) break;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (balance < STAKE + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) {
      // signal too recent — trade still open
      const ts = new Date(sig.epoch * 1000).toISOString().slice(11, 16);
      trades.push({ ts, strat: sig.strat, sym: sig.sym, side: sig.side, stake: STAKE, result: "OPEN", pnl: 0, bal: balance });
      continue;
    }
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "TP" | "SL" | "OPEN" = "OPEN";
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (sig.side === "BUY") {
        if (b.low <= stop) { exit = "SL"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= target) { exit = "TP"; exitPrice = target; break; }
      } else {
        if (b.high >= stop) { exit = "SL"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= target) { exit = "TP"; exitPrice = target; break; }
      }
    }
    const ts = new Date(sig.epoch * 1000).toISOString().slice(11, 16);
    if (exit === "OPEN") {
      trades.push({ ts, strat: sig.strat, sym: sig.sym, side: sig.side, stake: STAKE, result: "OPEN", pnl: 0, bal: balance });
      continue;
    }
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let netRaw = STAKE * MULT * move - commission;
    if (netRaw < -STAKE) netRaw = -STAKE;
    const net = round2(netRaw);
    balance = round2(balance + net);
    trades.push({ ts, strat: sig.strat, sym: sig.sym, side: sig.side, stake: STAKE, result: exit, pnl: net, bal: balance });
  }

  // Print
  console.log(`TRADES:`);
  console.log(`  ts     sym         strat           side  stake   result  pnl       balance`);
  for (const t of trades) {
    const r = t.result === "TP" ? "WIN" : t.result === "SL" ? "LOSS" : "open";
    const pnlStr = t.result === "OPEN" ? "—" : `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`;
    console.log(`  ${t.ts}  ${t.sym.padEnd(10)}  ${t.strat.padEnd(15)}  ${t.side.padEnd(4)}  $${t.stake.toFixed(2)}   ${r.padEnd(4)}    ${pnlStr.padStart(7)}   $${t.bal.toFixed(2)}`);
  }

  const settled = trades.filter((t) => t.result !== "OPEN");
  const wins = settled.filter((t) => t.result === "TP").length;
  const losses = settled.filter((t) => t.result === "SL").length;
  const open = trades.filter((t) => t.result === "OPEN").length;
  const netDelta = balance - ACCT_INIT;
  const wr = settled.length > 0 ? wins / settled.length : 0;
  console.log(`\nSUMMARY:`);
  console.log(`  Trades: ${settled.length} settled (${wins}W ${losses}L = ${(wr*100).toFixed(1)}% WR)  + ${open} still open`);
  console.log(`  Final balance: $${balance.toFixed(2)}  (Δ ${netDelta >= 0 ? "+" : ""}$${netDelta.toFixed(2)} = ${netDelta >= 0 ? "+" : ""}${(netDelta/ACCT_INIT*100).toFixed(1)}%)`);
  console.log(`  Bust: ${bust ? "💀 YES" : "no"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

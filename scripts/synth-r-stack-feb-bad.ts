// R-stack stress test on the worst Feb 2026 days.
// First runs the entire month to find each day's net, then runs trade-by-trade
// on the worst day for full transparency.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ACCT_INIT = 20, STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, KATR = 2.5, MOM_RATIO = 0.7, GR = 300;

const FEB_1 = Math.floor(Date.UTC(2026, 1, 1) / 1000);
const FEB_28 = Math.floor(Date.UTC(2026, 1, 28) / 1000);

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 60_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = []; let cursor = end;
  while (candles.length < count) { const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch); cursor = ch[0].epoch - 1; if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

type Sig = { idx: number; epoch: number; sym: string; strat: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detectFade(candles: Candle[], sym: string, side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const dist = KATR * a;
    if (side === "SELL" && cur.close > hi && cpu >= MOM_RATIO) {
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    } else if (side === "BUY" && cur.close < lo && cpd >= MOM_RATIO) {
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    }
  }
  return out;
}

function detectDrift(candles: Candle[], sym: string, side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const dist = KATR * a;
    if (side === "BUY" && cur.close > hi && cpu >= MOM_RATIO) {
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    } else if (side === "SELL" && cur.close < lo && cpd >= MOM_RATIO) {
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function settle(sig: Sig, candles: Candle[]): { exit: "TP" | "SL" | null; pnl: number } {
  if (sig.idx + 1 >= candles.length) return { exit: null, pnl: 0 };
  const finBar = candles[sig.idx + 1];
  const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
  const delta = finalE - sig.entry;
  const stop = sig.stop + delta;
  const target = sig.target + delta;
  let exit: "TP" | "SL" | null = null; let exitPrice = 0;
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
  if (!exit) return { exit: null, pnl: 0 };
  const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
  let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
  if (pnl < -STAKE) pnl = -STAKE;
  return { exit, pnl: round2(pnl) };
}

async function main() {
  console.log(`R-stack — find worst Feb 2026 day, then trade it\n`);

  const c = new C(); await c.ready;
  const need = 30 * 24 * 12 + 250;
  const [bear, bull] = await Promise.all([
    fetchPaged(c, "RDBEAR", GR, need, FEB_28 + 86400),
    fetchPaged(c, "RDBULL", GR, need, FEB_28 + 86400),
  ]);
  c.close();

  const sigs = [
    ...detectFade(bear, "RDBEAR", "SELL"),
    ...detectFade(bull, "RDBULL", "BUY"),
    ...detectDrift(bear, "RDBEAR", "SELL"),
    ...detectDrift(bull, "RDBULL", "BUY"),
  ].sort((a, b) => a.epoch - b.epoch);

  // Per-day net
  const dayMap = new Map<string, { net: number; trades: number; wins: number }>();
  for (const sig of sigs) {
    if (sig.epoch < FEB_1 || sig.epoch >= FEB_28 + 86400) continue;
    const candles = sig.sym === "RDBEAR" ? bear : bull;
    const { exit, pnl } = settle(sig, candles);
    if (!exit) continue;
    const day = new Date(sig.epoch * 1000).toISOString().slice(0, 10);
    if (!dayMap.has(day)) dayMap.set(day, { net: 0, trades: 0, wins: 0 });
    const d = dayMap.get(day)!;
    d.net += pnl; d.trades++; if (exit === "TP") d.wins++;
  }

  console.log(`PER-DAY NET (Feb 2026):`);
  console.log(`  date         trades   W%      net`);
  const sorted = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [day, d] of sorted) {
    const wr = d.wins / d.trades;
    const flag = d.net < 0 ? " 🔴" : "";
    console.log(`  ${day}   ${String(d.trades).padStart(3)}t   ${(wr*100).toFixed(0).padStart(2)}%   ${d.net >= 0 ? "+" : ""}$${d.net.toFixed(2).padStart(7)}${flag}`);
  }

  // Find worst day
  const worst = [...dayMap.entries()].sort((a, b) => a[1].net - b[1].net)[0];
  console.log(`\nWorst day: ${worst[0]} (net ${worst[1].net >= 0 ? "+" : ""}$${worst[1].net.toFixed(2)} on ${worst[1].trades}t)`);

  // Trade-by-trade on worst day
  const worstStart = Math.floor(new Date(worst[0] + "T00:00:00Z").getTime() / 1000);
  const worstEnd = worstStart + 86400;
  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`TRADE-BY-TRADE on ${worst[0]} ($${ACCT_INIT} acct / $${STAKE} flat / 4 strategies)`);
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`  ts     strategy        side  result   pnl       balance`);

  let balance = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT;
  const bySym: Record<string, { trades: number; wins: number; net: number }> = {
    RDBEAR_FADE: { trades: 0, wins: 0, net: 0 }, RDBULL_FADE: { trades: 0, wins: 0, net: 0 },
    RDBEAR_DRIFT: { trades: 0, wins: 0, net: 0 }, RDBULL_DRIFT: { trades: 0, wins: 0, net: 0 },
  };
  let bust = false;
  let trades = 0, wins = 0;

  for (const sig of sigs) {
    if (bust) break;
    if (sig.epoch < worstStart || sig.epoch >= worstEnd) continue;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (balance < STAKE + commission) { bust = true; break; }
    const candles = sig.sym === "RDBEAR" ? bear : bull;
    const { exit, pnl } = settle(sig, candles);
    if (!exit) continue;
    balance = round2(balance + pnl);
    if (balance > peak) peak = balance; if (balance < trough) trough = balance;
    bySym[sig.strat].trades++;
    if (exit === "TP") { bySym[sig.strat].wins++; wins++; }
    bySym[sig.strat].net += pnl;
    trades++;
    const ts = new Date(sig.epoch * 1000).toISOString().slice(11, 16);
    const r = exit === "TP" ? "WIN " : "LOSS";
    console.log(`  ${ts}  ${sig.strat.padEnd(13)}  ${sig.side.padEnd(4)}  ${r}    ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2).padStart(6)}   $${balance.toFixed(2)}`);
  }

  console.log(`\nPER-STRATEGY:`);
  for (const k of Object.keys(bySym)) {
    const s = bySym[k];
    if (s.trades === 0) { console.log(`  ${k.padEnd(13)}  no trades`); continue; }
    console.log(`  ${k.padEnd(13)}  ${s.trades}t  W=${s.wins}  L=${s.trades - s.wins}  WR=${(s.wins/s.trades*100).toFixed(1)}%  net=${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2)}`);
  }

  console.log(`\nSUMMARY (${worst[0]}):`);
  console.log(`  Trades: ${trades} settled (${wins}W ${trades - wins}L = ${trades > 0 ? (wins/trades*100).toFixed(1) : 0}% WR)`);
  console.log(`  Final balance: $${balance.toFixed(2)}  (Δ ${balance - ACCT_INIT >= 0 ? "+" : ""}$${(balance - ACCT_INIT).toFixed(2)})`);
  console.log(`  Peak / Trough: $${peak.toFixed(2)} / $${trough.toFixed(2)}  (max DD ${((peak-trough)/peak*100).toFixed(1)}%)`);
  console.log(`  Bust: ${bust ? "💀 YES" : "no"}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// R-stack 30-min sim using end:"latest" to bypass system clock drift.
// $20 acct, $3 flat, no mart, kAtr=4.0 fades + kAtr=2.5 drifts.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ACCT_INIT = 20, STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7, GR = 300;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

const MINUTES = Number(process.env.MINUTES ?? 30);

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchLatest(c: C, sym: string, count: number): Promise<Candle[]> {
  const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count, end: "latest", style: "candles", granularity: GR });
  const raw = (r.candles ?? []) as any[];
  return raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
    .sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

type Sig = { idx: number; epoch: number; sym: string; strat: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detectAll(candles: Candle[], sym: string, fadeSide: "BUY" | "SELL", driftSide: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    if (upPierce && fadeSide === "SELL") { const dist = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist }); }
    if (dnPierce && fadeSide === "BUY")  { const dist = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist }); }
    if (upPierce && driftSide === "BUY") { const dist = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist }); }
    if (dnPierce && driftSide === "SELL"){ const dist = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist }); }
  }
  return out;
}
function round2(x: number) { return Math.round(x * 100) / 100; }

async function main() {
  const c = new C(); await c.ready;
  // Need ~30min / 5min = 6 bars + 50 lookback = ~60 bars; fetch 200 to be safe
  const need = 200;
  const [bear, bull] = await Promise.all([fetchLatest(c, "RDBEAR", need), fetchLatest(c, "RDBULL", need)]);
  c.close();

  const latest = Math.max(bear[bear.length - 1].epoch, bull[bull.length - 1].epoch);
  const FROM = latest - MINUTES * 60;
  console.log(`R-stack last ${MINUTES}min — ${new Date(FROM * 1000).toISOString().slice(11, 16)} → ${new Date(latest * 1000).toISOString().slice(11, 16)} UTC`);
  console.log(`(${new Date((FROM + 3*3600) * 1000).toISOString().slice(11, 16)} → ${new Date((latest + 3*3600) * 1000).toISOString().slice(11, 16)} EAT)`);
  console.log(`ACCT=$${ACCT_INIT}  STAKE=$${STAKE}  flat-stake  no mart  no DD\n`);

  const sigs = [
    ...detectAll(bear, "RDBEAR", "SELL", "SELL"),
    ...detectAll(bull, "RDBULL", "BUY",  "BUY"),
  ].filter((s) => s.epoch >= FROM).sort((a, b) => a.epoch - b.epoch);

  console.log(`Pierce-signals: ${sigs.length}\n`);

  let balance = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, bust = false;
  type Trade = { ts: string; strat: string; side: string; result: "TP" | "SL" | "OPEN"; pnl: number; bal: number };
  const trades: Trade[] = [];
  for (const sig of sigs) {
    if (bust) break;
    const candles = sig.sym === "RDBEAR" ? bear : bull;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (balance < STAKE + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) {
      trades.push({ ts: new Date(sig.epoch * 1000).toISOString().slice(11, 16), strat: sig.strat, side: sig.side, result: "OPEN", pnl: 0, bal: balance });
      continue;
    }
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "TP" | "SL" | "OPEN" = "OPEN"; let exitPrice = 0;
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
    if (exit === "OPEN") { trades.push({ ts, strat: sig.strat, side: sig.side, result: "OPEN", pnl: 0, bal: balance }); continue; }
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - commission;
    if (pnl < -STAKE) pnl = -STAKE;
    pnl = round2(pnl);
    balance = round2(balance + pnl);
    if (balance > peak) peak = balance; if (balance < trough) trough = balance;
    trades.push({ ts, strat: sig.strat, side: sig.side, result: exit, pnl, bal: balance });
  }

  if (trades.length === 0) {
    console.log(`No signals fired in this window. Market hasn't pierced 15-bar high/low.`);
    return;
  }

  console.log(`TRADES:`);
  console.log(`  ts (UTC)  strategy        side  result   pnl       balance`);
  for (const t of trades) {
    const r = t.result === "TP" ? "WIN " : t.result === "SL" ? "LOSS" : "open";
    const pnlStr = t.result === "OPEN" ? "—" : `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`;
    console.log(`  ${t.ts}     ${t.strat.padEnd(13)}  ${t.side.padEnd(4)}  ${r}    ${pnlStr.padStart(7)}   $${t.bal.toFixed(2)}`);
  }

  const settled = trades.filter((t) => t.result !== "OPEN");
  const wins = settled.filter((t) => t.result === "TP").length;
  const wr = settled.length > 0 ? wins / settled.length : 0;
  console.log(`\nSUMMARY: ${settled.length} settled (${wins}W ${settled.length - wins}L = ${(wr*100).toFixed(1)}% WR) + ${trades.length - settled.length} open`);
  console.log(`Final: $${balance.toFixed(2)} (Δ ${balance - ACCT_INIT >= 0 ? "+" : ""}$${(balance - ACCT_INIT).toFixed(2)})`);
}
main().catch((e) => { console.error(e); process.exit(1); });

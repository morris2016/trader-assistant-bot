// Test the R-stack with FADE strategies tuned to kAtr=4.0 (wider stops/TP)
// while keeping DRIFT strategies at kAtr=2.5. Compare to current k=2.5 baseline.
// Three views: full 9-month total, per-month, worst-Feb day replay.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ACCT_INIT = 20, STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7, GR = 300;

const TODAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);

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

// Combined detector with separate kAtr per type
function detectAll(candles: Candle[], sym: string, fadeKAtr: number, driftKAtr: number, fadeSide: "BUY" | "SELL", driftSide: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    // FADE: trade against the pierce. fadeSide tells what direction the strategy is configured for
    if (upPierce && fadeSide === "SELL") {
      const dist = fadeKAtr * a;
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
    if (dnPierce && fadeSide === "BUY") {
      const dist = fadeKAtr * a;
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    }
    // DRIFT: trade with the pierce
    if (upPierce && driftSide === "BUY") {
      const dist = driftKAtr * a;
      out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    }
    if (dnPierce && driftSide === "SELL") {
      const dist = driftKAtr * a;
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

function runScenario(bear: Candle[], bull: Candle[], fadeKAtr: number, driftKAtr: number, from: number, to: number) {
  const sigs = [
    ...detectAll(bear, "RDBEAR", fadeKAtr, driftKAtr, "SELL", "SELL"),
    ...detectAll(bull, "RDBULL", fadeKAtr, driftKAtr, "BUY",  "BUY"),
  ].filter((s) => s.epoch >= from && s.epoch < to).sort((a, b) => a.epoch - b.epoch);

  let balance = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, bust = false;
  let trades = 0, wins = 0;
  const bySym: Record<string, { trades: number; wins: number; net: number }> = {};
  const dailyNet = new Map<string, number>();

  for (const sig of sigs) {
    if (bust) break;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (balance < STAKE + commission) { bust = true; break; }
    const candles = sig.sym === "RDBEAR" ? bear : bull;
    const { exit, pnl } = settle(sig, candles);
    if (!exit) continue;
    balance = round2(balance + pnl);
    if (balance > peak) peak = balance; if (balance < trough) trough = balance;
    if (!bySym[sig.strat]) bySym[sig.strat] = { trades: 0, wins: 0, net: 0 };
    bySym[sig.strat].trades++;
    if (exit === "TP") { bySym[sig.strat].wins++; wins++; }
    bySym[sig.strat].net += pnl;
    trades++;
    const day = new Date(sig.epoch * 1000).toISOString().slice(0, 10);
    dailyNet.set(day, (dailyNet.get(day) ?? 0) + pnl);
  }
  return { balance, peak, trough, bust, trades, wins, bySym, dailyNet };
}

async function main() {
  console.log(`R-stack k=4.0 fade vs k=2.5 baseline test\n`);
  const c = new C(); await c.ready;
  const need = 240 * 24 * 12 + 250;
  const [bear, bull] = await Promise.all([
    fetchPaged(c, "RDBEAR", GR, need, TODAY),
    fetchPaged(c, "RDBULL", GR, need, TODAY),
  ]);
  c.close();
  const start = bear[0].epoch;
  console.log(`Data: ${new Date(start * 1000).toISOString().slice(0,10)} → ${new Date(TODAY * 1000).toISOString().slice(0,10)}\n`);

  // Full history
  console.log(`${"".padEnd(70, "═")}`);
  console.log(`FULL HISTORY (${((TODAY - start) / 86400).toFixed(0)} days, $${ACCT_INIT}/$${STAKE} flat persistent)`);
  console.log(`${"".padEnd(70, "═")}`);
  for (const [tag, fk] of [["k=2.5 baseline (current)", 2.5], ["k=4.0 fades (NEW)", 4.0]] as [string, number][]) {
    const r = runScenario(bear, bull, fk, 2.5, start, TODAY);
    console.log(`\n  ${tag}:`);
    console.log(`    Final: $${r.balance.toFixed(2)}  Peak: $${r.peak.toFixed(2)}  Trough: $${r.trough.toFixed(2)}  Bust: ${r.bust}`);
    console.log(`    Trades: ${r.trades} (${r.wins}W ${r.trades-r.wins}L = ${(r.wins/r.trades*100).toFixed(1)}% WR)  net: ${r.balance - ACCT_INIT >= 0 ? "+" : ""}$${(r.balance - ACCT_INIT).toFixed(2)}`);
    for (const k of Object.keys(r.bySym)) {
      const s = r.bySym[k];
      console.log(`      ${k.padEnd(13)}  ${s.trades}t  WR=${(s.wins/s.trades*100).toFixed(1)}%  net=${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2)}`);
    }
  }

  // Per-month Feb 2026 day-level
  console.log(`\n${"".padEnd(70, "═")}`);
  console.log(`Feb 2026 PER-DAY NET — k=4.0 vs k=2.5 (worst-day stress check)`);
  console.log(`${"".padEnd(70, "═")}`);
  const FEB_1 = Math.floor(Date.UTC(2026, 1, 1) / 1000);
  const FEB_END = Math.floor(Date.UTC(2026, 1, 28) / 1000) + 86400;
  const r25 = runScenario(bear, bull, 2.5, 2.5, FEB_1, FEB_END);
  const r40 = runScenario(bear, bull, 4.0, 2.5, FEB_1, FEB_END);
  console.log(`  date         k=2.5 net     k=4.0 net    diff`);
  const days = [...new Set([...r25.dailyNet.keys(), ...r40.dailyNet.keys()])].sort();
  for (const d of days) {
    const n25 = r25.dailyNet.get(d) ?? 0;
    const n40 = r40.dailyNet.get(d) ?? 0;
    const diff = n40 - n25;
    const flag25 = n25 < 0 ? " 🔴" : "";
    const flag40 = n40 < 0 ? " 🔴" : "";
    console.log(`  ${d}   ${n25 >= 0 ? "+" : ""}$${n25.toFixed(2).padStart(7)}${flag25}    ${n40 >= 0 ? "+" : ""}$${n40.toFixed(2).padStart(7)}${flag40}    ${diff >= 0 ? "+" : ""}$${diff.toFixed(2)}`);
  }
  console.log(`  ─────────`);
  const t25 = [...r25.dailyNet.values()].reduce((a, b) => a + b, 0);
  const t40 = [...r40.dailyNet.values()].reduce((a, b) => a + b, 0);
  console.log(`  Feb total   ${t25 >= 0 ? "+" : ""}$${t25.toFixed(2).padStart(7)}    ${t40 >= 0 ? "+" : ""}$${t40.toFixed(2).padStart(7)}    ${t40 - t25 >= 0 ? "+" : ""}$${(t40 - t25).toFixed(2)}  (${((t40 - t25) / Math.max(0.01, Math.abs(t25)) * 100).toFixed(0)}%)`);

  const negDays25 = [...r25.dailyNet.values()].filter((v) => v < 0).length;
  const negDays40 = [...r40.dailyNet.values()].filter((v) => v < 0).length;
  console.log(`\n  Negative days: k=2.5: ${negDays25}/${days.length}  k=4.0: ${negDays40}/${days.length}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

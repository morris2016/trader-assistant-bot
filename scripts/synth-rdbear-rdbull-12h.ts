// RDBEAR + RDBULL only — last 12 hours, $20 acct, $3 flat, no mart, no DD.
// Tests how the bear/bull mean-rev pair performs as a standalone duo.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT_INIT = 20;
const STAKE = 3;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
const GR = 300; // 5m

const HOURS = Number(process.env.HOURS ?? 12);
// Production bots fetch ticks_history at startup → candle buffer is already
// populated from the moment the bot connects. So no signal-skip warmup is
// needed; trades fire immediately. WARMUP=0 simulates this realistically.
const WARMUP_HOURS = Number(process.env.WARMUP ?? 0);
const NOW = Math.floor(Date.now() / 1000);
const COLD_START = NOW - HOURS * 3600;
const TRADE_FROM = COLD_START + WARMUP_HOURS * 3600;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
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

type Sig = { idx: number; epoch: number; sym: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], sym: string, side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = KATR * a;
    if (side === "SELL") {
      if (cur.close > hi && closePosUp >= MOM_RATIO) {
        out.push({ idx: i, epoch: cur.epoch, sym, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
      }
    } else {
      if (cur.close < lo && closePosDn >= MOM_RATIO) {
        out.push({ idx: i, epoch: cur.epoch, sym, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
      }
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

async function main() {
  const coldTs = new Date(COLD_START * 1000).toISOString().slice(11, 16);
  const tradeTs = new Date(TRADE_FROM * 1000).toISOString().slice(11, 16);
  const toTs = new Date(NOW * 1000).toISOString().slice(11, 16);
  console.log(`RDBEAR + RDBULL ${HOURS}h simulation w/ ${WARMUP_HOURS}h WARMUP`);
  console.log(`Cold start: ${coldTs}   Trades enabled: ${tradeTs}   End: ${toTs} UTC`);
  console.log(`ACCT=$${ACCT_INIT}  STAKE=$${STAKE}  NO MART  NO DD  flat-stake`);
  console.log(`Detector: 5m breakoutMeanRev, lb=15 kAtr=2.5 m=0.7, no regime\n`);

  const c = new C(); await c.ready;
  const need = HOURS * 12 + 250;
  const [bearCandles, bullCandles] = await Promise.all([
    fetchPaged(c, "RDBEAR", GR, need, NOW),
    fetchPaged(c, "RDBULL", GR, need, NOW),
  ]);
  c.close();
  console.log(`Bars: RDBEAR=${bearCandles.length}  RDBULL=${bullCandles.length}\n`);

  // ALL signals during cold-start → end (so warmup signals are visible but not traded)
  const allBearSigs = detect(bearCandles, "RDBEAR", "SELL").filter((s) => s.epoch >= COLD_START);
  const allBullSigs = detect(bullCandles, "RDBULL", "BUY").filter((s) => s.epoch >= COLD_START);
  const sigsBear = allBearSigs.filter((s) => s.epoch >= TRADE_FROM);
  const sigsBull = allBullSigs.filter((s) => s.epoch >= TRADE_FROM);
  const warmupBear = allBearSigs.length - sigsBear.length;
  const warmupBull = allBullSigs.length - sigsBull.length;
  console.log(`Warmup observed (not traded): RDBEAR=${warmupBear}  RDBULL=${warmupBull}`);

  type S = { sig: Sig; candles: Candle[] };
  const all: S[] = [];
  for (const s of sigsBear) all.push({ sig: s, candles: bearCandles });
  for (const s of sigsBull) all.push({ sig: s, candles: bullCandles });
  all.sort((a, b) => a.sig.epoch - b.sig.epoch);

  console.log(`Signals fired: ${all.length}  (RDBEAR=${sigsBear.length}, RDBULL=${sigsBull.length})\n`);

  let balance = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT;
  let bust = false;
  type Trade = { ts: string; sym: string; side: string; result: "TP" | "SL" | "OPEN"; pnl: number; bal: number };
  const trades: Trade[] = [];

  for (const { sig, candles } of all) {
    if (bust) break;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (balance < STAKE + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) {
      trades.push({ ts: new Date(sig.epoch * 1000).toISOString().slice(11, 16), sym: sig.sym, side: sig.side, result: "OPEN", pnl: 0, bal: balance });
      continue;
    }
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
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
    if (exit === "OPEN") {
      trades.push({ ts, sym: sig.sym, side: sig.side, result: "OPEN", pnl: 0, bal: balance });
      continue;
    }
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - commission;
    if (pnl < -STAKE) pnl = -STAKE;
    pnl = round2(pnl);
    balance = round2(balance + pnl);
    if (balance > peak) peak = balance; if (balance < trough) trough = balance;
    trades.push({ ts, sym: sig.sym, side: sig.side, result: exit, pnl, bal: balance });
  }

  console.log(`TRADES:`);
  console.log(`  ts     sym      side   result    pnl       balance`);
  for (const t of trades) {
    const r = t.result === "TP" ? "WIN " : t.result === "SL" ? "LOSS" : "open";
    const pnlStr = t.result === "OPEN" ? "—" : `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}`;
    console.log(`  ${t.ts}  ${t.sym.padEnd(7)}  ${t.side.padEnd(4)}   ${r}     ${pnlStr.padStart(7)}   $${t.bal.toFixed(2)}`);
  }

  const settled = trades.filter((t) => t.result !== "OPEN");
  const wins = settled.filter((t) => t.result === "TP").length;
  const losses = settled.filter((t) => t.result === "SL").length;
  const open = trades.filter((t) => t.result === "OPEN").length;
  const wr = settled.length > 0 ? wins / settled.length : 0;

  // Per-symbol breakdown
  const bySym: Record<string, { trades: number; wins: number; net: number }> = { RDBEAR: { trades: 0, wins: 0, net: 0 }, RDBULL: { trades: 0, wins: 0, net: 0 } };
  for (const t of settled) {
    bySym[t.sym].trades++;
    if (t.result === "TP") bySym[t.sym].wins++;
    bySym[t.sym].net += t.pnl;
  }

  console.log(`\nPER-SYMBOL:`);
  for (const sym of ["RDBEAR", "RDBULL"]) {
    const s = bySym[sym];
    const swr = s.trades > 0 ? s.wins / s.trades : 0;
    console.log(`  ${sym}  ${s.trades}t  W=${s.wins}  L=${s.trades - s.wins}  WR=${(swr*100).toFixed(1)}%  net=${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2)}`);
  }

  console.log(`\nSUMMARY:`);
  console.log(`  Trades: ${settled.length} settled (${wins}W ${losses}L = ${(wr*100).toFixed(1)}% WR) + ${open} open`);
  console.log(`  Final balance: $${balance.toFixed(2)}  (Δ ${balance - ACCT_INIT >= 0 ? "+" : ""}$${(balance - ACCT_INIT).toFixed(2)} = ${(balance - ACCT_INIT >= 0 ? "+" : "")}${((balance - ACCT_INIT)/ACCT_INIT*100).toFixed(1)}%)`);
  console.log(`  Peak / Trough: $${peak.toFixed(2)} / $${trough.toFixed(2)}  (max DD ${((peak-trough)/peak*100).toFixed(1)}%)`);
  console.log(`  Bust: ${bust ? "💀 YES" : "no"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

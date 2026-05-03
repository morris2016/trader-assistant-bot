// RDBEAR breakout 5m — fine-grained kAtr sweep between #1 (2.0) and #7 (2.5).
// Same 8-hour honest-sim window (01:00→09:00 UTC today) as the previous test.
// Test kAtr ∈ {2.0, 2.1, 2.2, 2.3, 2.4, 2.5}, momRatio fixed at 0.70.
// Look for a monotonic gradient or a sweet spot — if results are noisy / one
// hour dominates, no real edge improvement and we stay with validated #1.

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

const KATR_GRID = [2.0, 2.1, 2.2, 2.3, 2.4, 2.5];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
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

function atr(c: Candle[], i: number, period = 14): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

type Sig = { idx: number; entry: number; stop: number; target: number };
function detect(candles: Candle[], lookback: number, kAtr: number, momR: number): Sig[] {
  const out: Sig[] = [];
  for (let i = lookback + 14; i < candles.length; i++) {
    const a = atr(candles, i, 14);
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

type Trade = { sigEpoch: number; net: number; exit: "tp" | "sl" };

function honestSim(candles: Candle[], lookback: number, kAtr: number, momR: number, ws: number, we: number): Trade[] {
  const sigs = detect(candles, lookback, kAtr, momR).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
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
    const pnlGross = round2(STAKE * MULT * move);
    const net = round2(pnlGross - commission);
    trades.push({ sigEpoch: candles[sig.idx].epoch, net, exit });
  }
  return trades;
}

async function main() {
  const dateStr = new Date(TODAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST sim — RDBEAR breakout 5m  ·  kAtr sweep  ·  ${dateStr} hours ${String(START_HOUR).padStart(2, "0")}:00→${String(END_HOUR).padStart(2, "0")}:00`);
  console.log(`Stake $${STAKE}  ·  MULT ${MULT}×  ·  lookback=15, momR=0.70 (fixed)\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, TODAY_START + END_HOUR * 3600);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  const ws = TODAY_START + START_HOUR * 3600;
  const we = TODAY_START + END_HOUR * 3600;

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  kAtr   trades  W/L     WR     gross   net      expR   maxWin   maxLoss   per-hr concentration`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  type Row = { kAtr: number; trades: number; wins: number; losses: number; net: number; gross: number; expR: number; maxWin: number; maxLoss: number; hourly: number[] };
  const rows: Row[] = [];
  for (const k of KATR_GRID) {
    const trades = honestSim(candles, 15, k, 0.70, ws, we);
    let wins = 0, losses = 0, net = 0, gross = 0;
    let maxWin = 0, maxLoss = 0;
    const hourly: number[] = [];
    for (let h = START_HOUR; h < END_HOUR; h++) {
      const hws = TODAY_START + h * 3600;
      const hwe = hws + 3600;
      const hourTrades = trades.filter((t) => t.sigEpoch >= hws && t.sigEpoch < hwe);
      const hourNet = hourTrades.reduce((s, t) => s + t.net, 0);
      hourly.push(hourNet);
    }
    for (const t of trades) {
      net += t.net;
      gross += t.net + 0.25; // commission was 0.25
      if (t.net > 0) { wins++; if (t.net > maxWin) maxWin = t.net; }
      else if (t.net < 0) { losses++; if (t.net < maxLoss) maxLoss = t.net; }
    }
    const wr = trades.length > 0 ? wins / trades.length : 0;
    const expR = trades.length > 0 ? net / (trades.length * STAKE) : 0;
    rows.push({ kAtr: k, trades: trades.length, wins, losses, net, gross, expR, maxWin, maxLoss, hourly });
    const concentration = hourly.map((n) => n === 0 ? "  ." : (n > 0 ? "+" : "-")).join("");
    console.log(`  ${k.toFixed(1)}    ${String(trades.length).padStart(2)}t   ${wins}W/${losses}L  ${(wr * 100).toFixed(0).padStart(3)}%  ${(gross >= 0 ? "+" : "") + "$" + gross.toFixed(2).padStart(7)}  ${(net >= 0 ? "+" : "") + "$" + net.toFixed(2).padStart(7)}  ${expR.toFixed(2).padStart(5)}  +$${maxWin.toFixed(2).padStart(6)}  $${maxLoss.toFixed(2).padStart(7)}   ${concentration}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`MONOTONIC CHECK — does net rise/fall cleanly with kAtr?`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  let monotonic = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].net < rows[i - 1].net) { monotonic = false; break; }
  }
  if (monotonic) {
    const best = rows[rows.length - 1];
    console.log(`  ✓ MONOTONIC RISING — wider stops keep paying off. Best: kAtr=${best.kAtr.toFixed(1)} → +$${best.net.toFixed(2)}`);
    console.log(`    But: this only tested ${rows[0].trades}–${rows[rows.length-1].trades} trades over 8h. Need 30-day CV before re-tuning.`);
  } else {
    rows.sort((a, b) => b.net - a.net);
    const best = rows[0];
    const baseline = rows.find((r) => r.kAtr === 2.0)!;
    const lift = best.net - baseline.net;
    console.log(`  ✗ NON-MONOTONIC — best kAtr=${best.kAtr.toFixed(1)} (+$${best.net.toFixed(2)}) vs baseline 2.0 (+$${baseline.net.toFixed(2)}) = +$${lift.toFixed(2)} lift`);
    console.log(`    Non-monotonicity suggests a sweet spot from noise, not a real gradient.`);
    console.log(`    Don't re-tune from this single 8-hour window — could be a fluke.`);
  }

  console.log(`\n  per-hour key:  + winning hour, - losing hour, . no trades`);
  console.log(`  hours covered: ${START_HOUR}:00 to ${END_HOUR}:00 UTC (${END_HOUR - START_HOUR} hours)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

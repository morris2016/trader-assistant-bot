// RDBEAR hour-of-day filter — OOS validation.
// Train hours: identify bad hours (WR < 50%) on first 70% of data.
// Test: apply that hour-list as a skip filter on last 30% of data.
// Then run end-to-end: full timeline with the hour filter, persistent balance.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const COMMISSION_FRAC = 0.005;
const MULT = 100;
const MIN_STAKE = 0.31;

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
const SYM = "RDBEAR";
const GR = 300;

const JAN_1_2025 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 60_000);
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

type Trade = { idx: number; epoch: number; entry: number; stop: number; target: number; result: "TP" | "SL"; hour: number };

function detectAndResolve(candles: Candle[]): Trade[] {
  const out: Trade[] = [];
  const start = Math.max(LOOKBACK + 14, 200) + 1;
  for (let i = start; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    let hi = -Infinity;
    for (let m = i - LOOKBACK; m < i; m++) if (candles[m].high > hi) hi = candles[m].high;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const dist = KATR * a;
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      if (i + 1 >= candles.length) continue;
      const finBar = candles[i + 1];
      const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
      const delta = finalE - cur.close;
      const stop = (cur.close + dist) + delta;
      const target = (cur.close - dist) + delta;
      let exit: "TP" | "SL" | null = null;
      for (let j = i + 1; j < candles.length; j++) {
        const b = candles[j];
        if (b.high >= stop) { exit = "SL"; break; }
        if (b.low <= target) { exit = "TP"; break; }
      }
      if (!exit) continue;
      const hour = new Date(cur.epoch * 1000).getUTCHours();
      out.push({ idx: i, epoch: cur.epoch, entry: cur.close, stop: cur.close + dist, target: cur.close - dist, result: exit, hour });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function simFlat(allCandles: Candle[], trades: Trade[], stake: number, badHours: Set<number>) {
  let balance = 100;
  let peak = 100, trough = 100;
  let trades_n = 0, wins = 0;
  for (const t of trades) {
    if (badHours.has(t.hour)) continue;
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) break;
    if (t.idx + 1 >= allCandles.length) continue;
    const finBar = allCandles[t.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    let exitPrice = 0;
    if (t.result === "TP") exitPrice = t.target + (finalE - t.entry);
    else exitPrice = t.stop + (finalE - t.entry) + (t.stop * SL_SLIPPAGE_FRAC);
    const move = (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    balance = round2(balance + netRaw);
    if (balance > peak) peak = balance;
    if (balance < trough) trough = balance;
    if (t.result === "TP") wins++;
    trades_n++;
  }
  return { trades: trades_n, wins, finalBal: balance, peak, trough };
}

async function main() {
  console.log(`RDBEAR hour-of-day filter — OOS validation\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`${candles.length} bars · ${(candles.length * GR / 86400).toFixed(1)} days`);

  const trades = detectAndResolve(candles).filter((t) => t.epoch >= JAN_1_2025);
  console.log(`${trades.length} trades resolved\n`);

  // 70/30 chronological split
  const split = Math.floor(trades.length * 0.7);
  const train = trades.slice(0, split);
  const test = trades.slice(split);

  // TRAIN: identify bad hours (WR < 50%, n >= 50)
  console.log(`TRAIN hour stats:`);
  console.log(`  hour  n     WR`);
  const trainHours: Array<{ h: number; n: number; w: number; wr: number }> = [];
  for (let h = 0; h < 24; h++) {
    const slice = train.filter((t) => t.hour === h);
    const w = slice.filter((t) => t.result === "TP").length;
    trainHours.push({ h, n: slice.length, w, wr: slice.length > 0 ? w / slice.length : 0 });
  }
  for (const x of trainHours) {
    const flag = x.wr < 0.50 && x.n >= 50 ? " ← BAD" : x.wr >= 0.60 ? " ← GOOD" : "";
    console.log(`  ${x.h.toString().padStart(2)}h   ${x.n.toString().padStart(3)}    ${(x.wr*100).toFixed(0)}%${flag}`);
  }

  const badHours = new Set(trainHours.filter((x) => x.wr < 0.50 && x.n >= 50).map((x) => x.h));
  console.log(`\nLearned bad hours: [${[...badHours].sort((a, b) => a - b).join(", ")}]`);

  // TEST: apply badHours filter on test set, see if WR improves
  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`TEST set (last 30%): does the filter generalize?`);
  console.log(`${"".padEnd(80, "═")}`);
  const testKept = test.filter((t) => !badHours.has(t.hour));
  const testSkipped = test.filter((t) => badHours.has(t.hour));
  const testBaseTPs = test.filter((t) => t.result === "TP").length;
  const keptTPs = testKept.filter((t) => t.result === "TP").length;
  const skippedTPs = testSkipped.filter((t) => t.result === "TP").length;
  console.log(`  Test baseline:    ${test.length}t  ${testBaseTPs}TP  WR=${(testBaseTPs/test.length*100).toFixed(1)}%`);
  console.log(`  Kept (good hrs):  ${testKept.length}t  ${keptTPs}TP  WR=${(keptTPs/testKept.length*100).toFixed(1)}%   (${((testKept.length/test.length)*100).toFixed(0)}% of trades)`);
  console.log(`  Skipped (bad):    ${testSkipped.length}t  ${skippedTPs}TP  WR=${(testSkipped.length > 0 ? (skippedTPs/testSkipped.length*100).toFixed(1) : "0")}%   (${((testSkipped.length/test.length)*100).toFixed(0)}% of trades)`);
  console.log(`  WR lift:          ${((keptTPs/testKept.length - testBaseTPs/test.length) * 100).toFixed(2)}pp`);

  // FULL-TIMELINE simulation: $100 / $5 flat, with vs without filter
  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`FULL TIMELINE — $100 acct / $5 flat / persistent balance, with vs without filter`);
  console.log(`${"".padEnd(80, "═")}`);
  for (const stake of [3, 5]) {
    const noFilter = simFlat(candles, trades, stake, new Set());
    const withFilter = simFlat(candles, trades, stake, badHours);
    console.log(`\n  stake=$${stake}`);
    console.log(`    no filter:   ${noFilter.trades}t  WR=${(noFilter.wins/noFilter.trades*100).toFixed(1)}%  final=$${noFilter.finalBal.toFixed(0)}  peak=$${noFilter.peak.toFixed(0)}  trough=$${noFilter.trough.toFixed(0)}`);
    console.log(`    hour filter: ${withFilter.trades}t  WR=${(withFilter.wins/withFilter.trades*100).toFixed(1)}%  final=$${withFilter.finalBal.toFixed(0)}  peak=$${withFilter.peak.toFixed(0)}  trough=$${withFilter.trough.toFixed(0)}`);
    const lift = withFilter.finalBal - noFilter.finalBal;
    console.log(`    lift: ${lift >= 0 ? "+" : ""}$${lift.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

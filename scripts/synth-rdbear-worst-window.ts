// RDBEAR worst-window stress test.
// Two parts:
//   1. Scan 152 days (Dec 1 2025 → today) with the no-regime detector and find
//      the day with the most consecutive losses and the day with the largest
//      single-day cumulative loss in chain.
//   2. Run $100 / $5 base / 1.7× / L8 (no reset) / NO DD on a 48-72h window
//      centered on the worst day, persistent balance — show the carnage.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE = Number(process.env.STAKE ?? 5);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 8);
const MIN_STAKE = 0.31;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
const SYM = "RDBEAR";
const GR = 300;

const DEC_1 = Math.floor(Date.UTC(2025, 11, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAYS = Math.floor((TODAY - DEC_1) / 86400);

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

type Sig = { idx: number; side: "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
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
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type TradeOutcome = { idx: number; epoch: number; result: "TP" | "SL" };

function evaluateTrades(candles: Candle[], sigs: Sig[]): TradeOutcome[] {
  const out: TradeOutcome[] = [];
  for (const sig of sigs) {
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "TP" | "SL" | null = null;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "SL"; break; }
      if (b.low <= target) { exit = "TP"; break; }
    }
    if (!exit) continue;
    out.push({ idx: sig.idx, epoch: candles[sig.idx].epoch, result: exit });
  }
  return out;
}

async function main() {
  console.log(`Phase 1: scan ${DAYS} days for worst loss-streak day...`);
  const c = new C(); await c.ready;

  // Fetch ALL candles in one shot by paging back from now to Dec 1
  const allCandles = await fetchPaged(c, SYM, GR, Math.ceil((TODAY - DEC_1) / GR) + 100, TODAY);
  c.close();
  console.log(`  Fetched ${allCandles.length} bars (${(allCandles.length * GR / 86400).toFixed(1)} days of data)`);

  const allSigs = detect(allCandles).filter((s) => allCandles[s.idx].epoch >= DEC_1);
  const allOuts = evaluateTrades(allCandles, allSigs);
  console.log(`  ${allSigs.length} signals · ${allOuts.length} resolved\n`);

  // Find max consecutive SL across whole timeline
  let maxStreak = 0, curStreak = 0;
  let streakEndEpoch = 0;
  for (const o of allOuts) {
    if (o.result === "SL") {
      curStreak++;
      if (curStreak > maxStreak) {
        maxStreak = curStreak;
        streakEndEpoch = o.epoch;
      }
    } else {
      curStreak = 0;
    }
  }
  const streakStartEpoch = streakEndEpoch - 86400; // approx
  console.log(`MAX SL STREAK in 152 days: ${maxStreak}  ending ~${new Date(streakEndEpoch * 1000).toISOString()}`);

  // Per-day loss-streak scan
  type DayStat = { day: string; epoch: number; trades: number; wins: number; losses: number; maxStreak: number; cumLoss: number };
  const days: DayStat[] = [];
  for (let d = 0; d < DAYS; d++) {
    const dStart = DEC_1 + d * 86400;
    const dEnd = dStart + 86400;
    const todayOuts = allOuts.filter((o) => o.epoch >= dStart && o.epoch < dEnd);
    let mStreak = 0, cStreak = 0, w = 0, l = 0, cum = 0;
    let runningStake = BASE_STAKE;
    for (const o of todayOuts) {
      if (o.result === "TP") {
        w++;
        cStreak = 0;
        runningStake = BASE_STAKE;
      } else {
        l++;
        cStreak++;
        if (cStreak > mStreak) mStreak = cStreak;
        cum += runningStake;
        runningStake = round2(runningStake * MART);
      }
    }
    days.push({
      day: new Date(dStart * 1000).toISOString().slice(0, 10),
      epoch: dStart,
      trades: todayOuts.length, wins: w, losses: l,
      maxStreak: mStreak, cumLoss: cum,
    });
  }
  days.sort((a, b) => b.maxStreak - a.maxStreak || b.cumLoss - a.cumLoss);
  console.log(`\nTOP-5 worst days (by max consecutive losses):`);
  for (const d of days.slice(0, 5)) {
    console.log(`  ${d.day}  trades=${d.trades.toString().padStart(2)} W=${d.wins.toString().padStart(2)} L=${d.losses.toString().padStart(2)}  maxStreak=${d.maxStreak}  cumChainLoss=$${d.cumLoss.toFixed(2)}`);
  }

  const worstDay = days[0];
  console.log(`\n${"".padEnd(70, "═")}`);
  console.log(`Phase 2: subject $${ACCT} / $${BASE_STAKE} / ${MART}× / L${MAX_LEVELS} no-reset / NO DD`);
  console.log(`         to a 72h window centered on ${worstDay.day} (max ${worstDay.maxStreak}-loss streak)`);
  console.log(`${"".padEnd(70, "═")}\n`);

  const winStart = worstDay.epoch - 86400;       // day before
  const winEnd = worstDay.epoch + 2 * 86400;     // day after
  const winSigs = allSigs.filter((s) => allCandles[s.idx].epoch >= winStart && allCandles[s.idx].epoch < winEnd);

  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let peak = ACCT, trough = ACCT;
  let trades = 0, wins = 0, losses = 0;
  let maxConsecLoss = 0, curConsecLoss = 0;
  const log: Array<{ ts: string; lvl: number; stake: number; result: "TP" | "SL"; pnl: number; bal: number }> = [];

  for (const sig of winSigs) {
    if (bust) break;
    if (martLevel >= MAX_LEVELS) martLevel = MAX_LEVELS - 1;
    const stake = round2(BASE_STAKE * Math.pow(MART, martLevel));
    if (stake < MIN_STAKE) { martLevel = 0; continue; }
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= allCandles.length) continue;
    const finBar = allCandles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < allCandles.length; j++) {
      const b = allCandles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (balance < trough) trough = balance;
    const ts = new Date(allCandles[sig.idx].epoch * 1000).toISOString().slice(5, 16).replace("T", " ");
    log.push({ ts, lvl: martLevel, stake, result: exit === "tp" ? "TP" : "SL", pnl: net, bal: balance });
    if (exit === "tp") { martLevel = 0; wins++; curConsecLoss = 0; }
    else {
      martLevel++;
      losses++;
      curConsecLoss++;
      if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
    }
    trades++;
  }

  console.log(`TRADE-BY-TRADE (only the streak-relevant slice):`);
  console.log(`  ts          lvl   stake     result   pnl       balance`);
  for (const e of log) {
    const flag = e.bal < ACCT * 0.5 ? " ⚠️" : "";
    console.log(`  ${e.ts.padEnd(11)}  L${e.lvl}   $${e.stake.toFixed(2).padStart(7)}   ${e.result}     ${e.pnl >= 0 ? "+" : ""}$${e.pnl.toFixed(2).padStart(7)}   $${e.bal.toFixed(2).padStart(7)}${flag}`);
  }

  console.log(`\n${"".padEnd(70, "═")}`);
  console.log(`SUMMARY — worst-window stress on $${ACCT}/$${BASE_STAKE}/L${MAX_LEVELS}/NO-DD`);
  console.log(`${"".padEnd(70, "═")}`);
  console.log(`  Window:           ${new Date(winStart * 1000).toISOString().slice(0,10)} → ${new Date(winEnd * 1000).toISOString().slice(0,10)} (72h)`);
  console.log(`  Trades:           ${trades}  (${wins}W / ${losses}L)  WR ${trades > 0 ? (wins/trades*100).toFixed(1) : 0}%`);
  console.log(`  Max consec loss:  ${maxConsecLoss}`);
  console.log(`  Final balance:    $${balance.toFixed(2)}  (Δ ${balance - ACCT >= 0 ? "+" : ""}$${(balance - ACCT).toFixed(2)})`);
  console.log(`  Peak / Trough:    $${peak.toFixed(2)} / $${trough.toFixed(2)}`);
  console.log(`  Bust:             ${bust ? "💀 YES — account blown" : "no, survived"}`);
  console.log(`  Skipped signals:  ${winSigs.length - trades}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

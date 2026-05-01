// 7-day rolling stress test of the 3-strategy combined fast sandbox.
// Single chronological simulation; balance and martingale ladders carry
// forward day-to-day. Output: daily P&L breakdown row-by-row.
//
// Test window: 2026-04-23 00:00 UTC → 2026-04-30 00:00 UTC (7 days).
// Strategies: spike-CRASH300N-1m, spike-BOOM300N-1m, drift-CRASH300N-5m.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const COST_BPS = 5.0;

const ACCT_BALANCE = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART_MULT = Number(process.env.MART ?? 2.2);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const TRADE_MULT = Number(process.env.MULT ?? 100);
// Per-strategy MULT override (0 = use TRADE_MULT default)
const SPIKE_MULT = Number(process.env.SPIKE_MULT ?? 0) || TRADE_MULT;
const DRIFT_MULT = Number(process.env.DRIFT_MULT ?? 0) || TRADE_MULT;
// Risk caps (0 = disabled)
const DAILY_BUST_CAP = Number(process.env.DAILY_BUST_CAP ?? 0); // max busts per strategy per UTC day before pause
const DAILY_LOSS_CAP = Number(process.env.DAILY_LOSS_CAP ?? 0); // max $-loss per strategy per UTC day before pause

// Test window. Defaults to April 23-29 (7 days). Override via env:
//   WINDOW_START=<epoch>  — first day's 00:00 UTC epoch
//   NUM_DAYS=<n>          — how many consecutive days to test
const DEFAULT_WINDOW_START = 1776902400; // Apr 23 00:00 UTC
const DEFAULT_NUM_DAYS = 7;
const WINDOW_START_ENV = Number(process.env.WINDOW_START ?? DEFAULT_WINDOW_START);
const NUM_DAYS = Number(process.env.NUM_DAYS ?? DEFAULT_NUM_DAYS);
const DAY_STARTS: number[] = [];
for (let i = 0; i < NUM_DAYS; i++) DAY_STARTS.push(WINDOW_START_ENV + i * 86400);
const WINDOW_START = DAY_STARTS[0];
const WINDOW_END = WINDOW_START + NUM_DAYS * 86400;

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() { this.connect(); }
  private connect() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
    this.ws.on("close", () => { for (const { reject } of this.pending.values()) reject(new Error("ws closed")); this.pending.clear(); });
    this.ws.on("error", () => {});
  }
  async reconnect(): Promise<void> {
    try { this.ws.close(); } catch {}
    for (const { reject } of this.pending.values()) reject(new Error("ws reconnecting"));
    this.pending.clear();
    await new Promise((r) => setTimeout(r, 1500));
    this.connect();
    await this.ready;
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ ...p, req_id: id })); }
      catch (e) { this.pending.delete(id); reject(e as Error); return; }
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number, endEpoch?: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = endEpoch != null ? String(endEpoch) : "latest";
  let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    let r: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); break; }
      catch (e) { if (attempt === 3) throw e; await new Promise((res) => setTimeout(res, 1500 + attempt * 1200)); }
    }
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

type SimSignal = { idx: number; side: "BUY" | "SELL"; stopPrice: number; targetPrice: number };

function eqSig(idx: number, side: "BUY" | "SELL", entry: number, dist: number): SimSignal {
  return side === "BUY"
    ? { idx, side, stopPrice: entry - dist, targetPrice: entry + dist }
    : { idx, side, stopPrice: entry + dist, targetPrice: entry - dist };
}

function driftPullback(candles: Candle[], driftDir: 1 | -1, k: number, kAtr: number): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  for (let i = k; i < candles.length; i++) {
    let allAgainst = true;
    for (let m = i - k + 1; m <= i; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const mv = candles[m].close - prev;
      if (driftDir === 1 && mv >= 0) { allAgainst = false; break; }
      if (driftDir === -1 && mv <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    sigs.push(eqSig(i, driftDir === 1 ? "BUY" : "SELL", candles[i].close, kAtr * atr));
  }
  return sigs;
}

function spikeFade(candles: Candle[], spikeN: number, buf: number, tpFrac: number, conf: boolean): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = 16; i < candles.length - 1; i++) {
    const sp = candles[i];
    const range = sp.high - sp.low;
    const priorAtr = atrAt(i - 1);
    if (priorAtr <= 0) continue;
    if (range < spikeN * priorAtr) continue;
    const cf = candles[i + 1];
    if (conf) {
      const inside = cf.close <= sp.high && cf.close >= sp.low;
      if (!inside) continue;
    }
    const dirUp = sp.close >= sp.open;
    const fadeSide: "BUY" | "SELL" = dirUp ? "SELL" : "BUY";
    const bufD = buf * priorAtr;
    const entry = cf.close;
    let sl: number, tp: number;
    if (fadeSide === "SELL") { sl = sp.high + bufD; tp = entry - tpFrac * range; if (sl <= entry || tp >= entry) continue; }
    else { sl = sp.low - bufD; tp = entry + tpFrac * range; if (sl >= entry || tp <= entry) continue; }
    sigs.push({ idx: i + 1, side: fadeSide, stopPrice: sl, targetPrice: tp });
  }
  return sigs;
}

type Strat = {
  id: string;
  symbol: string;
  granularity: number;
  build: (candles: Candle[]) => SimSignal[];
};
type Position = {
  strategyId: string;
  side: "BUY" | "SELL";
  level: number;
  stake: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  symbol: string;
  granularity: number;
};
type Event =
  | { kind: "bar"; symbol: string; granularity: number; bar: Candle }
  | { kind: "signal"; strategyId: string; symbol: string; granularity: number; sig: SimSignal; epoch: number };
type LedgerRow = {
  epoch: number;
  strategyId: string;
  symbol: string;
  side: "BUY" | "SELL";
  level: number;
  stake: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: "tp" | "sl" | "bankrupt";
  pnlUsd: number;
  balanceAfter: number;
};

const STRATS: Strat[] = [
  { id: "spike-CRASH300N-1m", symbol: "CRASH300N", granularity: 60, build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true) },
  { id: "spike-BOOM300N-1m",  symbol: "BOOM300N",  granularity: 60, build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true) },
  { id: "drift-CRASH300N-5m", symbol: "CRASH300N", granularity: 300, build: (c) => driftPullback(c, 1, 3, 1.0) },
];

async function main() {
  console.log("7-day rolling stress test");
  console.log(`Account: $${ACCT_BALANCE} starting | Base stake: $${BASE_STAKE} | Mart: ${MART_MULT}× | Levels: ${MAX_LEVELS} | MULT: spike=${SPIKE_MULT}× drift=${DRIFT_MULT}× | DailyBustCap=${DAILY_BUST_CAP || "off"} DailyLossCap=${DAILY_LOSS_CAP ? "$" + DAILY_LOSS_CAP : "off"}`);
  console.log(`Window: ${new Date(WINDOW_START * 1000).toISOString().slice(0,10)} → ${new Date(WINDOW_END * 1000).toISOString().slice(0,10)} UTC`);
  console.log("");

  const c = new C(); await c.ready;
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(STRATS.map((s) => `${s.symbol}|${s.granularity}`)));
  for (const k of fetchKeys) {
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    // Sized via env override for long historical windows. Defaults reach ~17d.
    // For Feb 2026 from April 2026 (90 days back) we need ~50k 1m bars.
    const cnt = gr === 60
      ? Number(process.env.FETCH_1M ?? 25000)
      : Number(process.env.FETCH_5M ?? 5000);
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars)...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const endEpoch = process.env.END_EPOCH ? Number(process.env.END_EPOCH) : undefined;
        candles = await fetchPaged(c, sym, gr, cnt, endEpoch); break;
      }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      const first = new Date(candles[0].epoch * 1000).toISOString().slice(0, 16);
      const last = new Date(candles[candles.length - 1].epoch * 1000).toISOString().slice(0, 16);
      console.log(` ${candles.length} bars (${span.toFixed(1)}d, ${first}Z → ${last}Z)`);
      cache.set(k, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  // Build per-strategy signals across ALL fetched candles (not just window —
  // signals fire on bar close, then exits checked in window).
  const stratSignals = new Map<string, SimSignal[]>();
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    stratSignals.set(s.id, candles ? s.build(candles) : []);
  }

  // Build event stream — only events in test window matter.
  const events: Event[] = [];
  for (const k of fetchKeys) {
    const candles = cache.get(k);
    if (!candles) continue;
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    for (const bar of candles) {
      if (bar.epoch < WINDOW_START || bar.epoch >= WINDOW_END) continue;
      events.push({ kind: "bar", symbol: sym, granularity: gr, bar });
    }
  }
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    if (!candles) continue;
    const sigs = stratSignals.get(s.id) ?? [];
    for (const sig of sigs) {
      const epoch = candles[sig.idx].epoch;
      if (epoch < WINDOW_START || epoch >= WINDOW_END) continue;
      events.push({ kind: "signal", strategyId: s.id, symbol: s.symbol, granularity: s.granularity, sig, epoch });
    }
  }
  events.sort((a, b) => {
    const ea = a.kind === "bar" ? a.bar.epoch : a.epoch;
    const eb = b.kind === "bar" ? b.bar.epoch : b.epoch;
    if (ea !== eb) return ea - eb;
    return a.kind === "bar" ? -1 : 1;
  });

  // Simulation state
  let balance = ACCT_BALANCE;
  let peak = ACCT_BALANCE;
  let trough = ACCT_BALANCE;
  const ladder: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const open = new Map<string, Position>();
  const ledger: LedgerRow[] = [];
  const costFrac = COST_BPS / 10000;
  let bankrupt = false;

  // Daily snapshots: balance at each day-start + per-day stats accumulator.
  type DayStat = {
    date: string;
    startBalance: number;
    endBalance: number;
    pnl: number;
    trades: number;
    wins: number;
    losses: number;
    busts: number;
    maxLevel: number;
    perStrat: Record<string, { trades: number; wins: number; losses: number; busts: number; pnl: number }>;
    intraDayTrough: number;
    bankruptAt: number | null;
  };
  const dayStats: DayStat[] = DAY_STARTS.map((s) => ({
    date: new Date(s * 1000).toISOString().slice(0, 10),
    startBalance: 0,
    endBalance: 0,
    pnl: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    busts: 0,
    maxLevel: 0,
    perStrat: Object.fromEntries(STRATS.map((st) => [st.id, { trades: 0, wins: 0, losses: 0, busts: 0, pnl: 0 }])),
    intraDayTrough: 0,
    bankruptAt: null,
  }));

  function dayIndex(epoch: number): number {
    for (let i = DAY_STARTS.length - 1; i >= 0; i--) {
      if (epoch >= DAY_STARTS[i]) return i;
    }
    return 0;
  }

  // Initialize start-of-day balances. Day 0 starts at ACCT_BALANCE; subsequent
  // days inherit prior day's endBalance during the loop.
  dayStats[0].startBalance = ACCT_BALANCE;
  dayStats[0].intraDayTrough = ACCT_BALANCE;

  let curDay = 0;

  for (const ev of events) {
    if (bankrupt) break;
    const epoch = ev.kind === "bar" ? ev.bar.epoch : ev.epoch;
    const evDay = dayIndex(epoch);

    // Day boundary: close out prior day, open next day.
    while (curDay < evDay) {
      dayStats[curDay].endBalance = balance;
      dayStats[curDay].pnl = balance - dayStats[curDay].startBalance;
      curDay++;
      if (curDay < dayStats.length) {
        dayStats[curDay].startBalance = balance;
        dayStats[curDay].intraDayTrough = balance;
      }
    }

    if (ev.kind === "bar") {
      for (const [sid, pos] of Array.from(open.entries())) {
        if (pos.symbol !== ev.symbol || pos.granularity !== ev.granularity) continue;
        let hit: "tp" | "sl" | null = null;
        if (pos.side === "BUY") {
          if (ev.bar.low <= pos.stopPrice) hit = "sl";
          else if (ev.bar.high >= pos.targetPrice) hit = "tp";
        } else {
          if (ev.bar.high >= pos.stopPrice) hit = "sl";
          else if (ev.bar.low <= pos.targetPrice) hit = "tp";
        }
        if (hit) {
          const exitPrice = hit === "tp" ? pos.targetPrice : pos.stopPrice;
          const gross = pos.side === "BUY"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
          const pnlPct = gross - costFrac;
          const stratMult = pos.strategyId.startsWith("drift-") ? DRIFT_MULT : SPIKE_MULT;
          const pnlUsd = pos.stake * Math.max(-1, pnlPct * stratMult);
          balance += pnlUsd;
          if (balance > peak) peak = balance;
          if (balance < trough) trough = balance;
          if (balance < dayStats[curDay].intraDayTrough) dayStats[curDay].intraDayTrough = balance;
          ledger.push({
            epoch: ev.bar.epoch, strategyId: pos.strategyId, symbol: pos.symbol,
            side: pos.side, level: pos.level, stake: pos.stake,
            entryPrice: pos.entryPrice, exitPrice, exitReason: hit,
            pnlUsd, balanceAfter: balance,
          });
          dayStats[curDay].trades++;
          dayStats[curDay].perStrat[pos.strategyId].trades++;
          dayStats[curDay].perStrat[pos.strategyId].pnl += pnlUsd;
          if (pos.level > dayStats[curDay].maxLevel) dayStats[curDay].maxLevel = pos.level;
          if (hit === "tp") {
            dayStats[curDay].wins++;
            dayStats[curDay].perStrat[pos.strategyId].wins++;
            ladder[sid] = 0;
          } else {
            dayStats[curDay].losses++;
            dayStats[curDay].perStrat[pos.strategyId].losses++;
            ladder[sid]++;
            if (ladder[sid] >= MAX_LEVELS) {
              dayStats[curDay].busts++;
              dayStats[curDay].perStrat[pos.strategyId].busts++;
              ladder[sid] = 0;
            }
          }
          open.delete(sid);
          if (balance <= 0) {
            bankrupt = true;
            dayStats[curDay].bankruptAt = epoch;
            break;
          }
        }
      }
    } else {
      const sid = ev.strategyId;
      if (open.has(sid)) continue;
      // Daily caps: skip new opens if this strategy busted/lost too much today
      if (DAILY_BUST_CAP > 0 && dayStats[curDay].perStrat[sid].busts >= DAILY_BUST_CAP) continue;
      if (DAILY_LOSS_CAP > 0 && dayStats[curDay].perStrat[sid].pnl <= -DAILY_LOSS_CAP) continue;
      const wantStake = BASE_STAKE * Math.pow(MART_MULT, ladder[sid]);
      if (wantStake > balance) {
        bankrupt = true;
        dayStats[curDay].bankruptAt = epoch;
        break;
      }
      const candles = cache.get(`${ev.symbol}|${ev.granularity}`)!;
      const entry = candles[ev.sig.idx].close;
      open.set(sid, {
        strategyId: sid, side: ev.sig.side, level: ladder[sid], stake: wantStake,
        entryPrice: entry, stopPrice: ev.sig.stopPrice, targetPrice: ev.sig.targetPrice,
        symbol: ev.symbol, granularity: ev.granularity,
      });
    }
  }

  // Close out final day(s).
  while (curDay < dayStats.length) {
    dayStats[curDay].endBalance = balance;
    dayStats[curDay].pnl = balance - dayStats[curDay].startBalance;
    curDay++;
    if (curDay < dayStats.length) {
      dayStats[curDay].startBalance = balance;
      dayStats[curDay].endBalance = balance; // no events in this day
      dayStats[curDay].intraDayTrough = balance;
    }
  }

  // ── Print daily breakdown ──────────────────────────────────────────────
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(`7-DAY DAILY BREAKDOWN (MULT=${TRADE_MULT}× MART=${MART_MULT}×)`);
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(`Day        Start    End      Daily P&L  Trades   W   L  Busts  IntraTrough  MaxLvl`);
  console.log(`──────────────────────────────────────────────────────────────────────────────────────`);
  for (const d of dayStats) {
    const sign = d.pnl >= 0 ? "+" : "";
    const pct = ((d.pnl / Math.max(0.01, d.startBalance)) * 100).toFixed(1);
    const dailyTroughDelta = d.intraDayTrough - d.startBalance;
    const dttSign = dailyTroughDelta >= 0 ? "+" : "";
    const tag = d.bankruptAt ? "💀" : (d.pnl > 0 ? "✅" : (d.pnl < 0 ? "❌" : "—"));
    console.log(
      `${tag} ${d.date}  $${d.startBalance.toFixed(2).padStart(6)}  $${d.endBalance.toFixed(2).padStart(6)}  ${sign}$${d.pnl.toFixed(2).padStart(6)} (${pct.padStart(6)}%)  ${String(d.trades).padStart(5)}  ${String(d.wins).padStart(3)} ${String(d.losses).padStart(3)}  ${String(d.busts).padStart(4)}   $${d.intraDayTrough.toFixed(2).padStart(6)} (${dttSign}${dailyTroughDelta.toFixed(2)})  ${d.maxLevel}`
    );
  }
  console.log("");
  console.log(`Per-day per-strategy contribution:`);
  console.log(`Day        spike-CRASH300N           spike-BOOM300N            drift-CRASH300N`);
  console.log(`──────────────────────────────────────────────────────────────────────────────────────────────────`);
  for (const d of dayStats) {
    const a = d.perStrat["spike-CRASH300N-1m"];
    const b = d.perStrat["spike-BOOM300N-1m"];
    const c = d.perStrat["drift-CRASH300N-5m"];
    const fmt = (s: typeof a) => {
      const sign = s.pnl >= 0 ? "+" : "";
      const wr = (s.wins + s.losses) > 0 ? ((s.wins / (s.wins + s.losses)) * 100).toFixed(0) : "—";
      return `${String(s.trades).padStart(3)}t ${String(s.wins).padStart(2)}W/${String(s.losses).padStart(2)}L (${wr.padStart(2)}%) ${sign}$${s.pnl.toFixed(2).padStart(6)} ${s.busts}b`;
    };
    console.log(`${d.date}  ${fmt(a)}    ${fmt(b)}    ${fmt(c)}`);
  }

  // Summary
  const finalBalance = bankrupt ? 0 : balance;
  const totalPnl = finalBalance - ACCT_BALANCE;
  const dayWins = dayStats.filter((d) => d.pnl > 0).length;
  const dayLosses = dayStats.filter((d) => d.pnl < 0).length;
  const maxDrawDay = dayStats.reduce((min, d) => d.pnl < min ? d.pnl : min, 0);
  const maxGainDay = dayStats.reduce((max, d) => d.pnl > max ? d.pnl : max, 0);

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("7-DAY SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(`Start: $${ACCT_BALANCE.toFixed(2)}  ·  End: $${finalBalance.toFixed(2)}  ·  P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} (${((totalPnl / ACCT_BALANCE) * 100).toFixed(0)}%)`);
  console.log(`Peak: $${peak.toFixed(2)}  ·  Trough: $${trough.toFixed(2)}  ·  Max DD from peak: $${(peak - trough).toFixed(2)}`);
  console.log(`Winning days: ${dayWins}/7  ·  Losing days: ${dayLosses}/7  ·  Best day: +$${maxGainDay.toFixed(2)}  ·  Worst day: ${maxDrawDay >= 0 ? "+" : ""}$${maxDrawDay.toFixed(2)}`);
  console.log(bankrupt ? `💀 BANKRUPT during period` : (totalPnl >= 0 ? "✅ profit" : "❌ loss"));

  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  const outFile = `.tmp/fast-7day-S${SPIKE_MULT}-D${DRIFT_MULT}-M${MART_MULT}-L${MAX_LEVELS}-BC${DAILY_BUST_CAP}-LC${DAILY_LOSS_CAP}.json`;
  writeFileSync(outFile, JSON.stringify({
    timestamp: new Date().toISOString(),
    config: { acct: ACCT_BALANCE, baseStake: BASE_STAKE, martMult: MART_MULT, maxLevels: MAX_LEVELS, tradeMult: TRADE_MULT },
    summary: { startBalance: ACCT_BALANCE, endBalance: finalBalance, totalPnl, peak, trough, bankrupt, dayWins, dayLosses },
    dayStats,
    ledger,
  }, null, 2));
  console.log(`Saved ${outFile}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Out-of-sample validation for the synth-rework winners.
// Runs the two qualifying configs from synth-rework-sweep.ts on three 7-day
// windows that PREDATE the in-sample sweep window (2026-03-30 → 2026-04-27),
// to confirm the edge holds in unrelated market regimes — not just the period
// we tuned on.
//
// Winners:
//   • boom-drift-tf300-down-k2-kAtr0.7  (BOOM300N 5m, drift down, k=2, kAtr=0.7)
//   • rdbull-drift-tf300-up-k1-kAtr1.0  (RDBULL 5m, drift up, k=1, kAtr=1.0)
//
// Windows (all 7-day, all before Mar 30 2026, spaced through Feb-Mar):
//   • W1: Feb 01-08  (epoch 1769904000)
//   • W2: Feb 22-Mar 01  (epoch 1771718400)
//   • W3: Mar 15-22  (epoch 1773532800)
//
// Pass criteria per window: WR ≥ 55%, expectancy_r > 0, half-stable, ≥30 trades.
// All three windows passing → ship. Two passing + one neutral → still ship
// but watch in production. Any window negative → redo retune or drop.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 500);
const STAKE = Number(process.env.STAKE ?? 1.0);
const MULT = Number(process.env.MULT ?? 100);
const COMMISSION_BPS = Number(process.env.COMMISSION ?? 50);
const COMMISSION_FRAC = COMMISSION_BPS / 10000;

const WINDOWS = [
  { id: "W1-Feb01-08", start: 1769904000, days: 7 },
  { id: "W2-Feb22-Mar01", start: 1771718400, days: 7 },
  { id: "W3-Mar15-22", start: 1773532800, days: 7 },
];

const FETCH_5M = Number(process.env.FETCH_5M ?? 16000); // ~55 days of 5m bars

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

async function fetchPaged(c: C, sym: string, gr: number, cnt: number, endEpoch: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor = String(endEpoch);
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

type Position = { side: "BUY" | "SELL"; entryPrice: number; stopPrice: number; targetPrice: number; openIdx: number };
type TradeOutcome = { won: boolean; pnlUsd: number; rMultiple: number; openEpoch: number; closeEpoch: number };

function simulate(candles: Candle[], signals: SimSignal[], windowStart: number, windowEnd: number): TradeOutcome[] {
  const trades: TradeOutcome[] = [];
  const sigs = signals.slice().sort((a, b) => a.idx - b.idx);
  let pos: Position | null = null;
  let nextSig = 0;
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (pos) {
      let hit: "tp" | "sl" | null = null;
      if (pos.side === "BUY") {
        if (bar.low <= pos.stopPrice) hit = "sl";
        else if (bar.high >= pos.targetPrice) hit = "tp";
      } else {
        if (bar.high >= pos.stopPrice) hit = "sl";
        else if (bar.low <= pos.targetPrice) hit = "tp";
      }
      if (hit) {
        const exit = hit === "tp" ? pos.targetPrice : pos.stopPrice;
        const gross = pos.side === "BUY"
          ? (exit - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exit) / pos.entryPrice;
        const grossPnlPct = Math.max(-1, gross * MULT);
        const grossPnl = STAKE * grossPnlPct;
        const pnlUsd = grossPnl - (STAKE * COMMISSION_FRAC);
        trades.push({
          won: hit === "tp", pnlUsd, rMultiple: pnlUsd / STAKE,
          openEpoch: candles[pos.openIdx].epoch, closeEpoch: bar.epoch,
        });
        pos = null;
      }
    }
    while (nextSig < sigs.length && sigs[nextSig].idx < i) nextSig++;
    if (!pos && nextSig < sigs.length && sigs[nextSig].idx === i && bar.epoch >= windowStart && bar.epoch < windowEnd) {
      const s = sigs[nextSig];
      pos = { side: s.side, entryPrice: bar.close, stopPrice: s.stopPrice, targetPrice: s.targetPrice, openIdx: i };
      nextSig++;
    }
  }
  return trades;
}

type WinnerSpec = {
  id: string;
  symbol: string;
  granularity: 300;
  build: (c: Candle[]) => SimSignal[];
};

// Pure detector functions copied here so the OOS script is self-contained.
function breakoutContinuation(candles: Candle[], lookback: number, kAtr: number, momRatio: number, sideFilter: "both" | "BUY" | "SELL" = "both"): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  for (let i = lookback; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let m = i - lookback; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const c = candles[i];
    const range = c.high - c.low;
    if (range <= 0) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const closePosUp = (c.close - c.low) / range;
    const closePosDn = (c.high - c.close) / range;
    if (sideFilter !== "SELL" && c.close > hi && closePosUp >= momRatio) sigs.push(eqSig(i, "BUY", c.close, kAtr * atr));
    else if (sideFilter !== "BUY" && c.close < lo && closePosDn >= momRatio) sigs.push(eqSig(i, "SELL", c.close, kAtr * atr));
  }
  return sigs;
}

const WINNERS: WinnerSpec[] = [
  { id: "boom-drift-tf300-down-k2-kAtr0.7",        symbol: "BOOM300N", granularity: 300, build: (c) => driftPullback(c, -1, 2, 0.7) },
  { id: "rdbull-drift-tf300-up-k1-kAtr1.5",        symbol: "RDBULL",   granularity: 300, build: (c) => driftPullback(c, 1, 1, 1.5) },
  { id: "rdbull-drift-tf300-up-k2-kAtr1.5",        symbol: "RDBULL",   granularity: 300, build: (c) => driftPullback(c, 1, 2, 1.5) },
  { id: "rdbull-boBUY-tf300-lb15-kAtr2.0-m0.5",    symbol: "RDBULL",   granularity: 300, build: (c) => breakoutContinuation(c, 15, 2.0, 0.5, "BUY") },
  { id: "rdbull-boBUY-tf300-lb15-kAtr2.0-m0.7",    symbol: "RDBULL",   granularity: 300, build: (c) => breakoutContinuation(c, 15, 2.0, 0.7, "BUY") },
];

async function main() {
  console.log("Synth-rework OOS validation");
  console.log(`Sim: stake=$${STAKE} mult=${MULT}× commission=${COMMISSION_BPS}bps  (flat-stake — pure detector edge)`);
  console.log(`Winners: ${WINNERS.map((w) => w.id).join(", ")}`);
  console.log(`Windows: ${WINDOWS.map((w) => w.id).join(", ")}`);
  console.log("");

  const c = new C(); await c.ready;
  // Fetch enough 5m history to cover the earliest window's start.
  // Latest end-epoch we need = W3 end = Mar 22 + 7d = Mar 29 23:59 = 1774137600 + 86400 - 60.
  const latestEnd = WINDOWS.reduce((max, w) => Math.max(max, w.start + w.days * 86400), 0);
  const cache = new Map<string, Candle[]>();
  const symbols = Array.from(new Set(WINNERS.map((w) => w.symbol)));
  for (const sym of symbols) {
    process.stdout.write(`Fetching ${sym} 5m (${FETCH_5M} bars to ${new Date(latestEnd * 1000).toISOString().slice(0,10)})...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, 300, FETCH_5M, latestEnd); break; }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      const first = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
      const last = new Date(candles[candles.length - 1].epoch * 1000).toISOString().slice(0, 10);
      console.log(` ${candles.length} bars (${span.toFixed(1)}d, ${first} → ${last})`);
      cache.set(sym, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  type Cell = {
    winner: string;
    window: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    expectancyR: number;
    pnlUsd: number;
    tradesPerDay: number;
    halfA: { trades: number; pnl: number };
    halfB: { trades: number; pnl: number };
    halfStable: boolean;
    pass: boolean;
    note: string;
  };
  const grid: Cell[] = [];

  for (const w of WINNERS) {
    const candles = cache.get(w.symbol);
    if (!candles) {
      console.log(`!! No data for ${w.symbol}, skipping ${w.id}`);
      continue;
    }
    const sigs = w.build(candles);

    for (const win of WINDOWS) {
      const winEnd = win.start + win.days * 86400;
      const trades = simulate(candles, sigs, win.start, winEnd);
      const wins = trades.filter((t) => t.won).length;
      const losses = trades.length - wins;
      const winRate = trades.length ? wins / trades.length : 0;
      const expectancyR = trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0;
      const pnlUsd = trades.reduce((a, t) => a + t.pnlUsd, 0);
      const tradesPerDay = trades.length / win.days;
      const midEpoch = win.start + Math.floor(win.days / 2) * 86400;
      const halfA = trades.filter((t) => t.openEpoch < midEpoch);
      const halfB = trades.filter((t) => t.openEpoch >= midEpoch);
      const halfApnl = halfA.reduce((a, t) => a + t.pnlUsd, 0);
      const halfBpnl = halfB.reduce((a, t) => a + t.pnlUsd, 0);
      const halfStable = halfApnl > 0 && halfBpnl > 0;

      let pass = true;
      let note = "";
      if (trades.length < 30) { pass = false; note = "few trades"; }
      else if (winRate < 0.55) { pass = false; note = `WR ${(winRate*100).toFixed(0)}% < 55%`; }
      else if (expectancyR <= 0) { pass = false; note = "expR ≤ 0"; }
      else if (!halfStable) { pass = false; note = "halves unstable"; }
      else if (pnlUsd <= 0) { pass = false; note = "pnl ≤ 0"; }
      else { note = "PASS"; }

      grid.push({
        winner: w.id, window: win.id, trades: trades.length, wins, losses,
        winRate, expectancyR, pnlUsd, tradesPerDay,
        halfA: { trades: halfA.length, pnl: halfApnl },
        halfB: { trades: halfB.length, pnl: halfBpnl },
        halfStable, pass, note,
      });
    }
  }

  // ── Per-winner breakdown ─────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("OOS VALIDATION GRID");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  for (const w of WINNERS) {
    console.log("");
    console.log(`▸ ${w.id}`);
    console.log(`  ${"window".padEnd(18)} ${"trades".padStart(6)}  ${"WR%".padStart(4)}  ${"expR".padStart(7)}  ${"/day".padStart(5)}  ${"$pnl".padStart(7)}  ${"halfA".padStart(7)}  ${"halfB".padStart(7)}  result`);
    console.log(`  ────────────────────────────────────────────────────────────────────────────────────────────────────────`);
    const rows = grid.filter((g) => g.winner === w.id);
    let allPass = true;
    for (const r of rows) {
      const wr = (r.winRate * 100).toFixed(0).padStart(3);
      const expR = r.expectancyR.toFixed(3).padStart(7);
      const tpd = r.tradesPerDay.toFixed(1).padStart(5);
      const pnl = `$${r.pnlUsd.toFixed(2)}`.padStart(7);
      const ha = `$${r.halfA.pnl.toFixed(2)}`.padStart(7);
      const hb = `$${r.halfB.pnl.toFixed(2)}`.padStart(7);
      const result = r.pass ? "✅ PASS" : `❌ ${r.note}`;
      console.log(`  ${r.window.padEnd(18)} ${String(r.trades).padStart(6)}  ${wr}%  ${expR}  ${tpd}  ${pnl}  ${ha}  ${hb}  ${result}`);
      if (!r.pass) allPass = false;
    }
    const totalTrades = rows.reduce((a, r) => a + r.trades, 0);
    const totalWins = rows.reduce((a, r) => a + r.wins, 0);
    const totalPnl = rows.reduce((a, r) => a + r.pnlUsd, 0);
    const aggregateWR = totalTrades > 0 ? totalWins / totalTrades : 0;
    console.log(`  ${"AGGREGATE".padEnd(18)} ${String(totalTrades).padStart(6)}  ${(aggregateWR * 100).toFixed(0).padStart(3)}%  ${" ".repeat(7)}  ${" ".repeat(5)}  $${totalPnl.toFixed(2).padStart(6)}  ${rows.filter(r => r.pass).length}/${rows.length} windows pass`);
    console.log(`  ${allPass ? "🟢 ALL WINDOWS PASS — ship it" : "🟡 mixed — review per-window note before shipping"}`);
  }

  // ── CSV ────────────────────────────────────────────────────────────────
  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  const csvPath = `.tmp/synth-rework-oos-${new Date().toISOString().slice(0, 10)}.csv`;
  const lines = ["winner,window,trades,wins,losses,win_rate,expectancy_r,pnl_usd,trades_per_day,half_a_pnl,half_b_pnl,half_stable,pass,note"];
  for (const c of grid) {
    lines.push([c.winner, c.window, c.trades, c.wins, c.losses, c.winRate.toFixed(4),
      c.expectancyR.toFixed(4), c.pnlUsd.toFixed(2), c.tradesPerDay.toFixed(2),
      c.halfA.pnl.toFixed(2), c.halfB.pnl.toFixed(2), c.halfStable, c.pass, `"${c.note}"`].join(","));
  }
  writeFileSync(csvPath, lines.join("\n"));
  console.log("");
  console.log(`Saved ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

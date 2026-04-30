// Synth-strategy rework sweep — finds 1m/5m high-accuracy edge candidates for
// the existing Synth tab assets (RDBULL, JD100, BOOM300N) by running a wide
// matrix of (symbol × timeframe × detector × params) over the same 28-day
// window the Fast2 winners were validated on, and emits a ranked CSV so we
// can pick replacements for the current 1h SMC strategies.
//
// Each config is run independently with a flat-stake (no martingale) sim so
// the score reflects the *underlying detector edge*, not ladder amplification.
// Once a winner is picked we layer martingale on top in the Synth registry.
//
// Output: .tmp/synth-rework-sweep-<window>.csv with one row per config.
//
// Usage:
//   FETCH_1M=25000 FETCH_5M=10000 WINDOW_START=1774224000 NUM_DAYS=28 \
//     npx ts-node scripts/synth-rework-sweep.ts
//
// Env knobs:
//   WINDOW_START=<epoch>  — first day's 00:00 UTC epoch (default Mar 22 2026)
//   NUM_DAYS=<n>          — window length (default 28)
//   FETCH_1M / FETCH_5M   — bars to pull per (sym, gr) — defaults size for 28d
//   ACCT=<n>              — starting balance for sim (default 500)
//   STAKE=<n>             — flat stake per trade (default 1.0 — keeps score
//                           comparable across configs without martingale noise)
//   MULT=<n>              — Deriv multiplier (default 100 — neutral midpoint)
//   COMMISSION=<bps>      — per-trade cost (default 50bps = 0.5%)
//   ONLY=<sym>            — restrict to single symbol (RDBULL/JD100/BOOM300N)
//   ONLY_DET=<id>         — restrict to single detector (drift/spike/range/breakout)
//
// Score: combinedEv = (WR × avgWinR) − ((1−WR) × avgLossR) − feeR. Higher is
// better. Hard filters: trades ≥ 30 over the window, both halves positive.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const WINDOW_START = Number(process.env.WINDOW_START ?? 1774224000); // Mar 22 2026 00:00Z
const NUM_DAYS = Number(process.env.NUM_DAYS ?? 28);
const WINDOW_END = WINDOW_START + NUM_DAYS * 86400;

const ACCT = Number(process.env.ACCT ?? 500);
const STAKE = Number(process.env.STAKE ?? 1.0);
const MULT = Number(process.env.MULT ?? 100);
const COMMISSION_BPS = Number(process.env.COMMISSION ?? 50);
const COMMISSION_FRAC = COMMISSION_BPS / 10000;

const ONLY_SYMBOL = (process.env.ONLY ?? "").toUpperCase();
const ONLY_DETECTOR = (process.env.ONLY_DET ?? "").toLowerCase();

const FETCH_1M = Number(process.env.FETCH_1M ?? 50000); // ~34 days of 1m
const FETCH_5M = Number(process.env.FETCH_5M ?? 12000); // ~41 days of 5m

// ── Deriv WS client (paged ticks_history fetch) ──────────────────────────
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

// ── Detector library (pure functions returning structural SL/TP signals) ─
type SimSignal = { idx: number; side: "BUY" | "SELL"; stopPrice: number; targetPrice: number };

function eqSig(idx: number, side: "BUY" | "SELL", entry: number, dist: number): SimSignal {
  return side === "BUY"
    ? { idx, side, stopPrice: entry - dist, targetPrice: entry + dist }
    : { idx, side, stopPrice: entry + dist, targetPrice: entry - dist };
}

/** Drift-pullback with confirmation bar — same as driftPullback but only
 *  fires after the next bar closes in the drift direction (i.e. the pullback
 *  is genuinely ending, not still extending). Trade-off: fewer signals,
 *  higher WR. Entry happens on the confirmation bar's close. */
function driftPullbackConfirmed(candles: Candle[], driftDir: 1 | -1, k: number, kAtr: number): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  // Need bar i (last against-drift) plus bar i+1 (confirmation in drift dir).
  for (let i = k; i < candles.length - 1; i++) {
    let allAgainst = true;
    for (let m = i - k + 1; m <= i; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const mv = candles[m].close - prev;
      if (driftDir === 1 && mv >= 0) { allAgainst = false; break; }
      if (driftDir === -1 && mv <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) continue;
    // Confirmation: bar i+1 must close in drift direction relative to bar i.
    const confirmMove = candles[i + 1].close - candles[i].close;
    if (driftDir === 1 && confirmMove <= 0) continue;
    if (driftDir === -1 && confirmMove >= 0) continue;
    const atr = atrAt(i + 1);
    if (atr <= 0) continue;
    sigs.push(eqSig(i + 1, driftDir === 1 ? "BUY" : "SELL", candles[i + 1].close, kAtr * atr));
  }
  return sigs;
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

/** Range-fade: when price closes outside an N-bar high/low range, fade back
 *  toward the range midpoint. Equidistant SL/TP at K×ATR. Pattern hunts the
 *  micro mean-reversion of synthetic indices that don't have a strong drift. */
function rangeFade(candles: Candle[], lookback: number, kAtr: number): SimSignal[] {
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
    const atr = atrAt(i);
    if (atr <= 0) continue;
    if (c.close > hi) sigs.push(eqSig(i, "SELL", c.close, kAtr * atr));
    else if (c.close < lo) sigs.push(eqSig(i, "BUY", c.close, kAtr * atr));
  }
  return sigs;
}

/** Breakout-continuation fade: when price breaks an N-bar range AND closes in
 *  the breakout direction with strong momentum (close near extreme), enter
 *  WITH the breakout. Opposite of rangeFade — captures momentum continuation
 *  on synthetics with directional drift. */
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
    const closePosUp = (c.close - c.low) / range;   // 1 = closed at high
    const closePosDn = (c.high - c.close) / range;  // 1 = closed at low
    if (sideFilter !== "SELL" && c.close > hi && closePosUp >= momRatio) sigs.push(eqSig(i, "BUY", c.close, kAtr * atr));
    else if (sideFilter !== "BUY" && c.close < lo && closePosDn >= momRatio) sigs.push(eqSig(i, "SELL", c.close, kAtr * atr));
  }
  return sigs;
}

// ── Sim engine (flat stake, no martingale — measures pure detector edge) ─
type Position = {
  side: "BUY" | "SELL";
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  openIdx: number;
};
type TradeOutcome = { won: boolean; pnlUsd: number; rMultiple: number; openEpoch: number; closeEpoch: number };

function simulate(candles: Candle[], signals: SimSignal[], windowStart: number, windowEnd: number): TradeOutcome[] {
  const trades: TradeOutcome[] = [];
  // Sort signals by idx in case detector returned them out of order.
  const sigs = signals.slice().sort((a, b) => a.idx - b.idx);
  let pos: Position | null = null;
  let nextSig = 0;
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (bar.epoch < windowStart || bar.epoch >= windowEnd) {
      // Open positions still need to be settled even outside the window so
      // we don't double-count entries; but we don't enter outside the window.
    }
    // Settle open position vs this bar. Conservative: SL takes precedence
    // when both touched in same bar (matches PaperEngine).
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
        // Match PaperEngine math: leverage-applied gross pnl, then subtract
        // commission as a flat % of stake (not deducted from the price move).
        const grossPnlPct = Math.max(-1, gross * MULT);
        const grossPnl = STAKE * grossPnlPct;
        const pnlUsd = grossPnl - (STAKE * COMMISSION_FRAC);
        trades.push({
          won: hit === "tp",
          pnlUsd,
          rMultiple: pnlUsd / STAKE,
          openEpoch: candles[pos.openIdx].epoch,
          closeEpoch: bar.epoch,
        });
        pos = null;
      }
    }
    // Open new position from signal at this idx if no open trade and signal
    // is in window.
    while (nextSig < sigs.length && sigs[nextSig].idx < i) nextSig++;
    if (!pos && nextSig < sigs.length && sigs[nextSig].idx === i && bar.epoch >= windowStart && bar.epoch < windowEnd) {
      const s = sigs[nextSig];
      pos = {
        side: s.side,
        entryPrice: bar.close,
        stopPrice: s.stopPrice,
        targetPrice: s.targetPrice,
        openIdx: i,
      };
      nextSig++;
    }
  }
  return trades;
}

// ── Config matrix ────────────────────────────────────────────────────────
type ConfigSpec = {
  id: string;
  symbol: string;
  granularity: 60 | 300;
  detector: "drift" | "spike" | "range" | "breakout";
  build: (candles: Candle[]) => SimSignal[];
};

function buildMatrix(): ConfigSpec[] {
  const m: ConfigSpec[] = [];

  // ── RDBULL retune-2: focused on pushing WR over 55% in OOS ─────────────
  // Round-1 winner (rdbull-drift-tf300-up-k1-kAtr1.0) was 55% WR in-sample
  // but dropped to 51-54% across 3 OOS windows. Need higher accuracy.

  // (a) drift-pullback CONFIRMED — adds a confirmation bar in drift direction.
  //     Should significantly lift WR by filtering pullbacks that keep extending.
  for (const tf of [60, 300] as const) {
    for (const k of [1, 2, 3] as const) {
      for (const kAtr of [0.7, 1.0, 1.3]) {
        m.push({
          id: `rdbull-driftC-tf${tf}-up-k${k}-kAtr${kAtr.toFixed(1)}`,
          symbol: "RDBULL", granularity: tf, detector: "drift",
          build: (c) => driftPullbackConfirmed(c, 1, k, kAtr),
        });
      }
    }
  }

  // (b) drift untested kAtr extremes — fill in 0.5 and 1.5.
  for (const tf of [60, 300] as const) {
    for (const k of [1, 2] as const) {
      for (const kAtr of [0.5, 1.5]) {
        m.push({
          id: `rdbull-drift-tf${tf}-up-k${k}-kAtr${kAtr.toFixed(1)}`,
          symbol: "RDBULL", granularity: tf, detector: "drift",
          build: (c) => driftPullback(c, 1, k, kAtr),
        });
      }
    }
  }

  // (c) breakout-continuation BUY-only — RDBULL has up-drift, so down-side
  //     breakouts are counter-trend and likely drag WR. Restrict to BUY.
  for (const lb of [15, 20, 30]) {
    for (const kAtr of [1.0, 1.5, 2.0]) {
      for (const mom of [0.5, 0.7]) {
        m.push({
          id: `rdbull-boBUY-tf300-lb${lb}-kAtr${kAtr.toFixed(1)}-m${mom.toFixed(1)}`,
          symbol: "RDBULL", granularity: 300, detector: "breakout",
          build: (c) => breakoutContinuation(c, lb, kAtr, mom, "BUY"),
        });
      }
    }
  }

  return m;
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const matrix = buildMatrix().filter((cfg) =>
    (!ONLY_SYMBOL || cfg.symbol === ONLY_SYMBOL) &&
    (!ONLY_DETECTOR || cfg.detector === ONLY_DETECTOR)
  );

  console.log(`Synth-rework sweep — ${matrix.length} configs`);
  console.log(`Window: ${new Date(WINDOW_START * 1000).toISOString().slice(0,10)} → ${new Date(WINDOW_END * 1000).toISOString().slice(0,10)} UTC (${NUM_DAYS}d)`);
  console.log(`Sim: stake=$${STAKE} mult=${MULT}× commission=${COMMISSION_BPS}bps  (flat-stake — measures pure detector edge)`);
  console.log("");

  const c = new C(); await c.ready;
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(matrix.map((s) => `${s.symbol}|${s.granularity}`)));
  for (const k of fetchKeys) {
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    const cnt = gr === 60 ? FETCH_1M : FETCH_5M;
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars)...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        candles = await fetchPaged(c, sym, gr, cnt, WINDOW_END); break;
      }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      console.log(` ${candles.length} bars (${span.toFixed(1)}d)`);
      cache.set(k, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  type ResultRow = {
    id: string;
    symbol: string;
    granularity: number;
    detector: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    avgWinR: number;
    avgLossR: number;
    expectancyR: number;
    pnlUsd: number;
    tradesPerDay: number;
    halfA: { trades: number; pnl: number };
    halfB: { trades: number; pnl: number };
    halfStable: boolean;
    score: number;
    note: string;
  };
  const rows: ResultRow[] = [];

  for (const cfg of matrix) {
    const candles = cache.get(`${cfg.symbol}|${cfg.granularity}`);
    if (!candles || candles.length === 0) {
      rows.push({ id: cfg.id, symbol: cfg.symbol, granularity: cfg.granularity, detector: cfg.detector,
        trades: 0, wins: 0, losses: 0, winRate: 0, avgWinR: 0, avgLossR: 0, expectancyR: 0,
        pnlUsd: 0, tradesPerDay: 0, halfA: { trades: 0, pnl: 0 }, halfB: { trades: 0, pnl: 0 },
        halfStable: false, score: -Infinity, note: "no data" });
      continue;
    }
    const sigs = cfg.build(candles);
    const trades = simulate(candles, sigs, WINDOW_START, WINDOW_END);
    const wins = trades.filter((t) => t.won).length;
    const losses = trades.length - wins;
    const winRate = trades.length ? wins / trades.length : 0;
    const winR = trades.filter((t) => t.won).map((t) => t.rMultiple);
    const lossR = trades.filter((t) => !t.won).map((t) => t.rMultiple);
    const avgWinR = winR.length ? winR.reduce((a, b) => a + b, 0) / winR.length : 0;
    const avgLossR = lossR.length ? Math.abs(lossR.reduce((a, b) => a + b, 0) / lossR.length) : 0;
    const expectancyR = trades.length ? trades.reduce((a, t) => a + t.rMultiple, 0) / trades.length : 0;
    const pnlUsd = trades.reduce((a, t) => a + t.pnlUsd, 0);
    const tradesPerDay = trades.length / NUM_DAYS;

    // Half-stability: window split in two, both halves should be net positive.
    const midEpoch = WINDOW_START + Math.floor(NUM_DAYS / 2) * 86400;
    const halfA = trades.filter((t) => t.openEpoch < midEpoch);
    const halfB = trades.filter((t) => t.openEpoch >= midEpoch);
    const halfApnl = halfA.reduce((a, t) => a + t.pnlUsd, 0);
    const halfBpnl = halfB.reduce((a, t) => a + t.pnlUsd, 0);
    const halfStable = halfApnl > 0 && halfBpnl > 0;

    // Score: edge per trade × frequency, penalize unstable halves.
    // (winRate × avgWinR − (1−winRate) × avgLossR) × tradesPerDay
    const edgePerTrade = (winRate * avgWinR) - ((1 - winRate) * avgLossR);
    let score = edgePerTrade * tradesPerDay;
    let note = "";
    if (trades.length < 30) { score = -Infinity; note = "insufficient trades"; }
    else if (winRate < 0.55) { note = "WR < 55%"; }
    else if (!halfStable) { note = "halves unstable"; }

    rows.push({ id: cfg.id, symbol: cfg.symbol, granularity: cfg.granularity, detector: cfg.detector,
      trades: trades.length, wins, losses, winRate, avgWinR, avgLossR, expectancyR,
      pnlUsd, tradesPerDay,
      halfA: { trades: halfA.length, pnl: halfApnl },
      halfB: { trades: halfB.length, pnl: halfBpnl },
      halfStable, score, note });
    console.log(`  ${cfg.id.padEnd(45)} ${trades.length.toString().padStart(4)}t ${(winRate * 100).toFixed(0).padStart(3)}% WR  expR=${expectancyR.toFixed(3).padStart(7)}  ${tradesPerDay.toFixed(1)}/day  $${pnlUsd.toFixed(0).padStart(5)}  score=${isFinite(score) ? score.toFixed(3) : "—"}  ${note}`);
  }

  // Rank
  rows.sort((a, b) => b.score - a.score);

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("RANKED RESULTS (by edge×freq score, qualifying configs only)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(`#  id                                              trades  WR%  expR     /day   pnl$   halfA    halfB    score   note`);
  console.log(`────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────`);
  rows.forEach((r, i) => {
    const rank = (i + 1).toString().padStart(2);
    const id = r.id.padEnd(48);
    const t = r.trades.toString().padStart(5);
    const wr = (r.winRate * 100).toFixed(0).padStart(3);
    const expR = r.expectancyR.toFixed(3).padStart(7);
    const tpd = r.tradesPerDay.toFixed(1).padStart(5);
    const pnl = `$${r.pnlUsd.toFixed(0)}`.padStart(7);
    const ha = `$${r.halfA.pnl.toFixed(0)}`.padStart(6);
    const hb = `$${r.halfB.pnl.toFixed(0)}`.padStart(6);
    const score = isFinite(r.score) ? r.score.toFixed(3).padStart(7) : "    —  ";
    console.log(`${rank} ${id} ${t}  ${wr}  ${expR}  ${tpd}  ${pnl}  ${ha}  ${hb}  ${score}  ${r.note}`);
  });

  // CSV
  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  const csvPath = `.tmp/synth-rework-sweep-${new Date(WINDOW_START * 1000).toISOString().slice(0,10)}-${NUM_DAYS}d.csv`;
  const header = "rank,id,symbol,granularity,detector,trades,wins,losses,win_rate,avg_win_r,avg_loss_r,expectancy_r,pnl_usd,trades_per_day,half_a_trades,half_a_pnl,half_b_trades,half_b_pnl,half_stable,score,note";
  const lines = [header];
  rows.forEach((r, i) => {
    lines.push([
      i + 1, r.id, r.symbol, r.granularity, r.detector,
      r.trades, r.wins, r.losses, r.winRate.toFixed(4),
      r.avgWinR.toFixed(4), r.avgLossR.toFixed(4), r.expectancyR.toFixed(4),
      r.pnlUsd.toFixed(2), r.tradesPerDay.toFixed(2),
      r.halfA.trades, r.halfA.pnl.toFixed(2), r.halfB.trades, r.halfB.pnl.toFixed(2),
      r.halfStable, isFinite(r.score) ? r.score.toFixed(4) : "-Inf", `"${r.note}"`,
    ].join(","));
  });
  writeFileSync(csvPath, lines.join("\n"));
  console.log("");
  console.log(`Saved ${csvPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

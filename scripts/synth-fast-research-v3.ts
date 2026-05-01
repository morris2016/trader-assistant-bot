// Fast-research v3 — strategies designed for MARTINGALE applicability.
//
// Classic martingale viability requirements:
//   • Win rate ≥ 55% (preferably ≥60%) — short losing streaks
//   • R:R ≈ 1:1 (TP distance ≈ SL distance) — each win recovers exactly the
//     previous loss when stake is doubled
//   • Trades roughly independent (no clustering of losses)
//
// Strategies tested here all use EQUIDISTANT TP/SL at K×ATR around entry,
// scored by both raw expectancy AND martingale-cycle expectancy:
//
//   E_cycle = (1 - q^N) × baseStake - q^N × baseStake × (m^N - 1)/(m - 1)
//
// where q = 1 - WR, N = maxLevels = 5, m = 2.2. This is the per-cycle expected
// P&L assuming each win nets +1 base stake (R:R = 1:1).
//
// Symbol universe matches v2: BOOM/CRASH 300N/500/1000, R_100, 1HZ100V, RDBULL,
// JD100, stpRNG. Only candidates with WR ≥ 55%, both halves positive, and
// martingale +EV pass to the live deploy.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR, EMA, SMA, BollingerBands } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;
// Martingale params used for cycle-EV scoring.
const M_BASE = 0.5;       // base stake (matches DEFAULT_FAST_MARTINGALE)
const M_MULT = 2.2;       // multiplier per loss
const M_LEVELS = 5;       // max ladder levels before circuit-breaker

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

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
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
type SimTrade = {
  side: "BUY" | "SELL";
  openIdx: number; closeIdx: number;
  entryPrice: number; exitPrice: number;
  stopPrice: number; targetPrice: number;
  pnlPct: number; exitReason: "tp" | "sl" | "opposite_signal" | "run_end"; pnlUsd: number;
};

function simulate(candles: Candle[], signals: SimSignal[]): SimTrade[] {
  const costFrac = COST_BPS / 10000;
  const sigByIdx = new Map<number, SimSignal[]>();
  for (const s of signals) {
    const arr = sigByIdx.get(s.idx) ?? [];
    arr.push(s);
    sigByIdx.set(s.idx, arr);
  }
  const trades: SimTrade[] = [];
  let open: SimTrade | null = null;
  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    if (open) {
      let hit: "tp" | "sl" | null = null;
      if (open.side === "BUY") {
        if (bar.low <= open.stopPrice) hit = "sl";
        else if (bar.high >= open.targetPrice) hit = "tp";
      } else {
        if (bar.high >= open.stopPrice) hit = "sl";
        else if (bar.low <= open.targetPrice) hit = "tp";
      }
      if (hit) {
        const exitPrice = hit === "tp" ? open.targetPrice : open.stopPrice;
        open.exitPrice = exitPrice; open.closeIdx = i; open.exitReason = hit;
        const gross = open.side === "BUY"
          ? (exitPrice - open.entryPrice) / open.entryPrice
          : (open.entryPrice - exitPrice) / open.entryPrice;
        open.pnlPct = gross - costFrac;
        open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
        trades.push(open); open = null;
      }
    }
    const sigs = sigByIdx.get(i);
    if (sigs) {
      for (const sig of sigs) {
        if (open && open.side !== sig.side) {
          open.exitPrice = bar.close; open.closeIdx = i; open.exitReason = "opposite_signal";
          const gross = open.side === "BUY"
            ? (bar.close - open.entryPrice) / open.entryPrice
            : (open.entryPrice - bar.close) / open.entryPrice;
          open.pnlPct = gross - costFrac;
          open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
          trades.push(open); open = null;
        }
        if (!open) {
          const entry = bar.close;
          open = {
            side: sig.side, openIdx: i, closeIdx: -1,
            entryPrice: entry, exitPrice: 0,
            stopPrice: sig.stopPrice, targetPrice: sig.targetPrice,
            pnlPct: 0, exitReason: "run_end", pnlUsd: 0,
          };
        }
      }
    }
  }
  if (open) {
    const last = candles[candles.length - 1];
    open.exitPrice = last.close; open.closeIdx = candles.length - 1; open.exitReason = "run_end";
    const gross = open.side === "BUY"
      ? (last.close - open.entryPrice) / open.entryPrice
      : (open.entryPrice - last.close) / open.entryPrice;
    open.pnlPct = gross - costFrac;
    open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
    trades.push(open);
  }
  return trades;
}

// Helper: build equidistant TP/SL signal at K×ATR around entry.
function eqSig(idx: number, side: "BUY" | "SELL", entry: number, kAtr: number, atr: number): SimSignal {
  const d = kAtr * atr;
  return side === "BUY"
    ? { idx, side, stopPrice: entry - d, targetPrice: entry + d }
    : { idx, side, stopPrice: entry + d, targetPrice: entry - d };
}

// ── Strategy A: Z-score mean reversion (equidistant) ───────────────────────
// Compute 20-bar SMA + std. Z = (close - mean) / std.
// If Z > entryZ → SELL with TP/SL at K×ATR (R:R=1:1). Mirror for BUY.
function zReversion(candles: Candle[], period: number, entryZ: number, kAtr: number): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const sma = SMA.calculate({ period, values: closes });
  const offset = candles.length - sma.length;
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 0; i < sma.length; i++) {
    const idx = i + offset;
    if (idx < period) continue;
    const slice = closes.slice(idx - period + 1, idx + 1);
    const m = sma[i];
    let varSum = 0;
    for (const v of slice) varSum += (v - m) * (v - m);
    const std = Math.sqrt(varSum / period);
    if (std <= 0) continue;
    const z = (closes[idx] - m) / std;
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    const c = closes[idx];
    if (z > entryZ) sigs.push(eqSig(idx, "SELL", c, kAtr, atr));
    else if (z < -entryZ) sigs.push(eqSig(idx, "BUY", c, kAtr, atr));
  }
  return sigs;
}

// ── Strategy B: Bollinger band touch — equidistant TP/SL ─────────────────
function bollEqd(candles: Candle[], period: number, sd: number, kAtr: number): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const bb = BollingerBands.calculate({ period, values: closes, stdDev: sd });
  const offset = candles.length - bb.length;
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 0; i < bb.length; i++) {
    const idx = i + offset;
    const { upper, lower } = bb[i];
    const c = closes[idx];
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    if (c > upper) sigs.push(eqSig(idx, "SELL", c, kAtr, atr));
    else if (c < lower) sigs.push(eqSig(idx, "BUY", c, kAtr, atr));
  }
  return sigs;
}

// ── Strategy C: Drift-pullback w/ EQUIDISTANT TP/SL ───────────────────────
// On drift assets (BOOM=down, CRASH=up, RDBULL=up): after K consecutive
// against-drift CLOSES, fade back to drift direction with equal TP/SL.
function driftPullbackEqd(candles: Candle[], driftDir: 1 | -1, k: number, kAtr: number): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  for (let i = k; i < candles.length; i++) {
    let allAgainst = true;
    for (let m = i - k + 1; m <= i; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const move = candles[m].close - prev;
      if (driftDir === 1 && move >= 0) { allAgainst = false; break; }
      if (driftDir === -1 && move <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    sigs.push(eqSig(i, driftDir === 1 ? "BUY" : "SELL", c, kAtr, atr));
  }
  return sigs;
}

// ── Strategy D: 5-bar mean-reversion fade ──────────────────────────────────
// On any asset: after N up-closes in a row → SELL (R:R 1:1). Mirror for down.
function consecFade(candles: Candle[], n: number, kAtr: number): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  for (let i = n; i < candles.length; i++) {
    let allUp = true, allDown = true;
    for (let m = i - n + 1; m <= i; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const move = candles[m].close - prev;
      if (move <= 0) allUp = false;
      if (move >= 0) allDown = false;
      if (!allUp && !allDown) break;
    }
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    if (allUp) sigs.push(eqSig(i, "SELL", c, kAtr, atr));
    else if (allDown) sigs.push(eqSig(i, "BUY", c, kAtr, atr));
  }
  return sigs;
}

// ── Strategy E: EMA-pullback bounce — trend-with-drift ────────────────────
// On drift assets: when close pulls back to EMA(fast) from above (drift up),
// BUY with R:R 1:1. Mirror for drift-down.
function emaPullbackEqd(candles: Candle[], emaP: number, driftDir: 1 | -1, kAtr: number): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const ema = EMA.calculate({ period: emaP, values: closes });
  const offset = candles.length - ema.length;
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 1; i < ema.length; i++) {
    const idx = i + offset;
    const prev = closes[idx - 1];
    const cur = closes[idx];
    const e = ema[i];
    const ePrev = ema[i - 1];
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    if (driftDir === 1) {
      // Drift up — BUY when price pulls down to or below EMA from above.
      if (prev > ePrev && cur <= e) sigs.push(eqSig(idx, "BUY", cur, kAtr, atr));
    } else {
      // Drift down — SELL when price pulls up to or above EMA from below.
      if (prev < ePrev && cur >= e) sigs.push(eqSig(idx, "SELL", cur, kAtr, atr));
    }
  }
  return sigs;
}

// ── Stats / scoring ────────────────────────────────────────────────────────
type Stats = {
  trades: number; wins: number; losses: number; wr: number;
  expR: number; totalUsd: number; maxDDUsd: number; perDay: number;
  halfA_total: number; halfA_trades: number;
  halfB_total: number; halfB_trades: number;
  bothPositive: boolean;
  // R:R observed (TP_dist / SL_dist averaged)
  obsRR: number;
  // Martingale-cycle EV: per-cycle expected $ assuming 1:1 R:R approximation.
  martingaleCycleEv: number;
  // Fraction of cycles that hit circuit-breaker (5 in a row losing).
  bustProb: number;
  // Daily expected $ assuming each trade kicks off independent ladder progress.
  martingaleDailyExp: number;
};

function computeStats(trades: SimTrade[], candles: Candle[]): Stats {
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const losses = trades.filter((t) => t.pnlUsd <= 0).length;
  const totalUsd = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const wr = trades.length > 0 ? wins / trades.length : 0;
  let rSum = 0;
  for (const t of trades) {
    const risk = Math.abs(t.entryPrice - t.stopPrice);
    if (risk <= 0) continue;
    rSum += (t.pnlPct * t.entryPrice) / risk;
  }
  const expR = trades.length > 0 ? rSum / trades.length : 0;
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += t.pnlUsd;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  }
  const firstE = candles[0]?.epoch ?? 0;
  const lastE = candles[candles.length - 1]?.epoch ?? firstE;
  const days = Math.max(1, (lastE - firstE) / 86400);
  const midEpoch = (firstE + lastE) / 2;
  const halfA = trades.filter((t) => candles[t.openIdx].epoch < midEpoch);
  const halfB = trades.filter((t) => candles[t.openIdx].epoch >= midEpoch);
  const halfA_total = halfA.reduce((a, t) => a + t.pnlUsd, 0);
  const halfB_total = halfB.reduce((a, t) => a + t.pnlUsd, 0);
  // Observed R:R per trade (only complete TP/SL exits).
  const rrTrades = trades.filter((t) => t.exitReason === "tp" || t.exitReason === "sl");
  let rrSum = 0; let rrN = 0;
  for (const t of rrTrades) {
    const tpDist = Math.abs(t.targetPrice - t.entryPrice);
    const slDist = Math.abs(t.stopPrice - t.entryPrice);
    if (slDist > 0) { rrSum += tpDist / slDist; rrN++; }
  }
  const obsRR = rrN > 0 ? rrSum / rrN : 0;
  // Martingale cycle EV — assumes 1:1 R:R. Each cycle ends at first win OR
  // at level M_LEVELS (circuit breaker). Probability of busting = q^N.
  const q = 1 - wr;
  const bustProb = Math.pow(q, M_LEVELS);
  // Cumulative loss at bust = M_BASE × (m^N - 1)/(m - 1) where N=M_LEVELS.
  const bustLoss = M_BASE * (Math.pow(M_MULT, M_LEVELS) - 1) / (M_MULT - 1);
  // Win cycle nets +M_BASE (assumes R:R=1:1).
  const winProfit = M_BASE;
  const martingaleCycleEv = (1 - bustProb) * winProfit - bustProb * bustLoss;
  // Average cycle length: 1 trade if first-trade win, 2 if level 1 win, etc.
  let avgCycleLen = 0;
  for (let n = 0; n <= M_LEVELS; n++) {
    if (n === M_LEVELS) avgCycleLen += M_LEVELS * bustProb;
    else avgCycleLen += (n + 1) * Math.pow(q, n) * wr;
  }
  const cyclesPerDay = avgCycleLen > 0 ? (trades.length / days) / avgCycleLen : 0;
  const martingaleDailyExp = martingaleCycleEv * cyclesPerDay;
  return {
    trades: trades.length, wins, losses, wr, expR, totalUsd, maxDDUsd: maxDD,
    perDay: trades.length / days,
    halfA_total, halfA_trades: halfA.length,
    halfB_total, halfB_trades: halfB.length,
    bothPositive: halfA_total > 0 && halfB_total > 0,
    obsRR, martingaleCycleEv, bustProb, martingaleDailyExp,
  };
}

type Variant = {
  name: string; symbol: string; granularity: number;
  build: (candles: Candle[]) => SimSignal[];
};

const ALL_SYMS = ["BOOM1000", "BOOM500", "BOOM300N", "CRASH1000", "CRASH500", "CRASH300N", "R_100", "1HZ100V", "RDBULL", "JD100", "stpRNG"];
const DRIFT_UP = ["CRASH1000", "CRASH500", "CRASH300N", "RDBULL"];
const DRIFT_DOWN = ["BOOM1000", "BOOM500", "BOOM300N"];

const VARIANTS: Variant[] = [
  // A — Z-reversion equidistant
  ...ALL_SYMS.flatMap((sym) =>
    [
      { tag: "p20_z1.5_k0.5", p: 20, z: 1.5, k: 0.5 },
      { tag: "p20_z2.0_k0.5", p: 20, z: 2.0, k: 0.5 },
      { tag: "p20_z2.0_k1.0", p: 20, z: 2.0, k: 1.0 },
      { tag: "p30_z1.5_k0.5", p: 30, z: 1.5, k: 0.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Z-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => zReversion(c, v.p, v.z, v.k),
    })))
  ),
  // B — Bollinger equidistant
  ...ALL_SYMS.flatMap((sym) =>
    [
      { tag: "p20_2.0_k0.5", p: 20, sd: 2.0, k: 0.5 },
      { tag: "p20_2.0_k1.0", p: 20, sd: 2.0, k: 1.0 },
      { tag: "p20_2.5_k0.5", p: 20, sd: 2.5, k: 0.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Boll-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => bollEqd(c, v.p, v.sd, v.k),
    })))
  ),
  // C — Drift pullback (equidistant)
  ...DRIFT_UP.flatMap((sym) =>
    [
      { tag: "k2_kAtr0.5", k: 2, kAtr: 0.5 },
      { tag: "k3_kAtr0.5", k: 3, kAtr: 0.5 },
      { tag: "k3_kAtr1.0", k: 3, kAtr: 1.0 },
      { tag: "k4_kAtr0.5", k: 4, kAtr: 0.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Pullback-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => driftPullbackEqd(c, 1, v.k, v.kAtr),
    })))
  ),
  ...DRIFT_DOWN.flatMap((sym) =>
    [
      { tag: "k2_kAtr0.5", k: 2, kAtr: 0.5 },
      { tag: "k3_kAtr0.5", k: 3, kAtr: 0.5 },
      { tag: "k3_kAtr1.0", k: 3, kAtr: 1.0 },
      { tag: "k4_kAtr0.5", k: 4, kAtr: 0.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Pullback-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => driftPullbackEqd(c, -1, v.k, v.kAtr),
    })))
  ),
  // D — Consec fade
  ...ALL_SYMS.flatMap((sym) =>
    [
      { tag: "n3_kAtr0.5", n: 3, kAtr: 0.5 },
      { tag: "n4_kAtr0.5", n: 4, kAtr: 0.5 },
      { tag: "n5_kAtr0.5", n: 5, kAtr: 0.5 },
      { tag: "n3_kAtr1.0", n: 3, kAtr: 1.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Consec-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => consecFade(c, v.n, v.kAtr),
    })))
  ),
  // E — EMA pullback
  ...DRIFT_UP.flatMap((sym) =>
    [
      { tag: "ema9_kAtr0.5", e: 9, kAtr: 0.5 },
      { tag: "ema20_kAtr0.5", e: 20, kAtr: 0.5 },
      { tag: "ema50_kAtr1.0", e: 50, kAtr: 1.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `EmaPB-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => emaPullbackEqd(c, v.e, 1, v.kAtr),
    })))
  ),
  ...DRIFT_DOWN.flatMap((sym) =>
    [
      { tag: "ema9_kAtr0.5", e: 9, kAtr: 0.5 },
      { tag: "ema20_kAtr0.5", e: 20, kAtr: 0.5 },
      { tag: "ema50_kAtr1.0", e: 50, kAtr: 1.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `EmaPB-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => emaPullbackEqd(c, v.e, -1, v.kAtr),
    })))
  ),
];

async function main() {
  const c = new C(); await c.ready;
  const FETCH_BY_GR: Record<number, number> = { 60: 25000, 300: 9000 };
  const cache = new Map<string, Candle[]>();
  const cacheKey = (s: string, g: number) => `${s}_${g}`;
  const fetchPlan: Array<{ sym: string; gr: number }> = [];
  for (const v of VARIANTS) {
    if (!fetchPlan.find((p) => p.sym === v.symbol && p.gr === v.granularity)) {
      fetchPlan.push({ sym: v.symbol, gr: v.granularity });
    }
  }
  console.log(`Fast-research v3: ${VARIANTS.length} variants, ${fetchPlan.length} (sym × gr) data fetches.`);
  console.log(`Martingale params: base=$${M_BASE}, mult=${M_MULT}×, levels=${M_LEVELS} → bust loss=$${(M_BASE * (Math.pow(M_MULT, M_LEVELS) - 1) / (M_MULT - 1)).toFixed(2)}`);
  console.log("");
  let fetchIdx = 0;
  for (const { sym, gr } of fetchPlan) {
    fetchIdx++;
    process.stdout.write(`[${fetchIdx}/${fetchPlan.length}] fetch ${sym} ${gr === 60 ? "1m" : "5m"} (${FETCH_BY_GR[gr]} bars)...`);
    let candles: Candle[] | null = null; let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, gr, FETCH_BY_GR[gr]); break; }
      catch (e) { lastErr = e as Error; try { await c.reconnect(); } catch {} }
    }
    if (!candles) { console.log(` FAIL (${lastErr?.message ?? "unknown"})`); continue; }
    const span = candles.length > 0 ? (candles[candles.length - 1].epoch - candles[0].epoch) / 86400 : 0;
    console.log(` ${candles.length} bars (${span.toFixed(1)}d)`);
    cache.set(cacheKey(sym, gr), candles);
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  console.log("\nRunning variants...\n");
  type Result = { name: string; symbol: string; granularity: number; gr_label: string; days: number; stats: Stats };
  const results: Result[] = [];
  for (const v of VARIANTS) {
    const candles = cache.get(cacheKey(v.symbol, v.granularity));
    if (!candles || candles.length < 200) continue;
    const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
    let signals: SimSignal[] = [];
    try { signals = v.build(candles); } catch { continue; }
    const trades = simulate(candles, signals);
    if (trades.length < 30) continue;
    const stats = computeStats(trades, candles);
    results.push({ name: v.name, symbol: v.symbol, granularity: v.granularity, gr_label: v.granularity === 60 ? "1m" : "5m", days: span, stats });
  }

  // Sort by martingale daily expectation (descending).
  results.sort((a, b) => b.stats.martingaleDailyExp - a.stats.martingaleDailyExp);

  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("MARTINGALE-VIABLE: WR ≥ 55%, both halves positive, observed R:R ≥ 0.85, martingale daily EV > 0");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  const passed = results.filter((r) =>
    r.stats.wr >= 0.55 &&
    r.stats.bothPositive &&
    r.stats.obsRR >= 0.85 &&
    r.stats.martingaleDailyExp > 0
  );
  if (passed.length === 0) console.log("  ❌ No variant passed.");
  else {
    for (const r of passed.slice(0, 25)) {
      console.log(
        `  ✓ ${r.name.padEnd(48)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% rawR=${r.stats.expR.toFixed(2)} obsRR=${r.stats.obsRR.toFixed(2)} ` +
        `bust=${(r.stats.bustProb*100).toFixed(1)}% mtgEV/day=$${r.stats.martingaleDailyExp.toFixed(2)} cyEV=$${r.stats.martingaleCycleEv.toFixed(2)} ${r.stats.perDay.toFixed(0)}t/d`
      );
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 25 BY WIN RATE (≥30 trades, both halves positive)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  const topWr = [...results].filter((r) => r.stats.bothPositive).sort((a, b) => b.stats.wr - a.stats.wr).slice(0, 25);
  for (const r of topWr) {
    console.log(
      `  · ${r.name.padEnd(48)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% rawR=${r.stats.expR.toFixed(2)} obsRR=${r.stats.obsRR.toFixed(2)} ` +
      `bust=${(r.stats.bustProb*100).toFixed(1)}% mtgEV/day=$${r.stats.martingaleDailyExp.toFixed(2)} ${r.stats.perDay.toFixed(0)}t/d`
    );
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 25 BY MARTINGALE-DAILY-EV (≥30 trades, both halves positive)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  const topMtg = [...results].filter((r) => r.stats.bothPositive).sort((a, b) => b.stats.martingaleDailyExp - a.stats.martingaleDailyExp).slice(0, 25);
  for (const r of topMtg) {
    console.log(
      `  · ${r.name.padEnd(48)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% obsRR=${r.stats.obsRR.toFixed(2)} ` +
      `mtgEV/day=$${r.stats.martingaleDailyExp.toFixed(2)} cyEV=$${r.stats.martingaleCycleEv.toFixed(2)} bust=${(r.stats.bustProb*100).toFixed(2)}% ${r.stats.perDay.toFixed(0)}t/d`
    );
  }

  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  writeFileSync(".tmp/fast-research-v3-results.json", JSON.stringify({
    timestamp: new Date().toISOString(),
    martingale: { base: M_BASE, mult: M_MULT, levels: M_LEVELS },
    cost_bps: COST_BPS, stake: STAKE, mult: MULT,
    results,
  }, null, 2));
  console.log("\nSaved .tmp/fast-research-v3-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

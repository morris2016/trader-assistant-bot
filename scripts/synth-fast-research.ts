// Fast-research script — tests 5 hypothesized strategies against fresh Deriv
// synthetic data on 1m and 5m timeframes. Strategies don't map cleanly to the
// existing detectors (OB/FVG/Sweep/TrendCont) so we compute signals inline and
// simulate trades using the SAME TP/SL geometry, opposite-signal-close, and
// cost model as src/main/engine/backtest.ts (lines 222-324). Net result is
// directly comparable to engine-driven backtests.
//
// Strategies under test:
//   1. Post-spike fade on Boom/Crash 1m / 5m
//   2. Bollinger reversion on R_100 / 1HZ100V
//   3. Donchian breakout on stpRNG (Step Index)
//   4. RSI extremes reversion on 1HZ100V
//   5. 3-of-5 majority direction fade on R_100
//
// Output: per-variant stats + persisted .tmp/fast-research-results.json

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR, RSI, BollingerBands } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0; // matches existing synth scripts

// ── WS client (copied pattern from synth-screen-all.ts) ─────────────────────
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
    this.ws.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("ws closed"));
      this.pending.clear();
    });
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
      try {
        r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
        break;
      } catch (e) {
        if (attempt === 3) throw e;
        await new Promise((res) => setTimeout(res, 1500 + attempt * 1200));
      }
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

// ── Inline trade simulator — mirrors src/main/engine/backtest.ts geometry ────
// Each signal is { idx, side, stopPrice?, targetPrice? }. If stop/target are
// absent the simulator uses ATR(14) × atrSlMult/atrTpMult (engine default).
// Same conservative tie-break: if a single bar engulfs both stop & target,
// stop hits first.
type SimSignal = { idx: number; side: "BUY" | "SELL"; stopPrice?: number; targetPrice?: number };
type SimTrade = {
  side: "BUY" | "SELL";
  openIdx: number;
  closeIdx: number;
  entryPrice: number;
  exitPrice: number;
  stopPrice: number;
  targetPrice: number;
  pnlPct: number;
  exitReason: "tp" | "sl" | "opposite_signal" | "run_end";
  pnlUsd: number;
};

function simulate(
  candles: Candle[],
  signals: SimSignal[],
  opts: { atrSlMult: number; atrTpMult: number; costBps: number; atrPeriod?: number },
): SimTrade[] {
  const period = opts.atrPeriod ?? 14;
  const costFrac = opts.costBps / 10000;
  // Pre-compute ATR aligned to candle indices (technicalindicators returns
  // length N - period). atrAligned[i] = ATR sampled at candle i.
  const atrSeries = ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);

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

    // Check exits FIRST.
    if (open) {
      let hit: "tp" | "sl" | null = null;
      if (open.side === "BUY") {
        const stopHit = bar.low <= open.stopPrice;
        const tpHit = bar.high >= open.targetPrice;
        if (stopHit) hit = "sl";
        else if (tpHit) hit = "tp";
      } else {
        const stopHit = bar.high >= open.stopPrice;
        const tpHit = bar.low <= open.targetPrice;
        if (stopHit) hit = "sl";
        else if (tpHit) hit = "tp";
      }
      if (hit) {
        const exitPrice = hit === "tp" ? open.targetPrice : open.stopPrice;
        open.exitPrice = exitPrice;
        open.closeIdx = i;
        open.exitReason = hit;
        const gross = open.side === "BUY"
          ? (exitPrice - open.entryPrice) / open.entryPrice
          : (open.entryPrice - exitPrice) / open.entryPrice;
        open.pnlPct = gross - costFrac;
        open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
        trades.push(open);
        open = null;
      }
    }

    // Open / reverse on signal.
    const sigs = sigByIdx.get(i);
    if (sigs) {
      for (const sig of sigs) {
        if (open && open.side !== sig.side) {
          // Close at current close (opposite_signal exit).
          open.exitPrice = bar.close;
          open.closeIdx = i;
          open.exitReason = "opposite_signal";
          const gross = open.side === "BUY"
            ? (bar.close - open.entryPrice) / open.entryPrice
            : (open.entryPrice - bar.close) / open.entryPrice;
          open.pnlPct = gross - costFrac;
          open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
          trades.push(open);
          open = null;
        }
        if (!open) {
          const atr = atrAt(i);
          if (atr <= 0) continue;
          const entry = bar.close;
          let stopPrice: number, targetPrice: number;
          if (sig.stopPrice != null && sig.targetPrice != null) {
            stopPrice = sig.stopPrice;
            targetPrice = sig.targetPrice;
          } else {
            const stopDist = atr * opts.atrSlMult;
            const tpDist = atr * opts.atrTpMult;
            stopPrice = sig.side === "BUY" ? entry - stopDist : entry + stopDist;
            targetPrice = sig.side === "BUY" ? entry + tpDist : entry - tpDist;
          }
          open = {
            side: sig.side,
            openIdx: i,
            closeIdx: -1,
            entryPrice: entry,
            exitPrice: 0,
            stopPrice,
            targetPrice,
            pnlPct: 0,
            exitReason: "run_end",
            pnlUsd: 0,
          };
        }
      }
    }
  }
  // Close at run_end.
  if (open) {
    const last = candles[candles.length - 1];
    open.exitPrice = last.close;
    open.closeIdx = candles.length - 1;
    open.exitReason = "run_end";
    const gross = open.side === "BUY"
      ? (last.close - open.entryPrice) / open.entryPrice
      : (open.entryPrice - last.close) / open.entryPrice;
    open.pnlPct = gross - costFrac;
    open.pnlUsd = STAKE * Math.max(-1, open.pnlPct * MULT);
    trades.push(open);
  }
  return trades;
}

// ── Strategy 1: Post-spike fade ─────────────────────────────────────────────
// On bar i, if (high - low) ≥ N * ATR(14)[i-1] (spike), wait one bar to
// confirm spike-end (i.e. the bar at i+1 closes within the spike's range —
// no continuation), then fade on bar i+1 close.
//   - Spike direction = sign(close - open) of spike bar.
//   - Fade direction = opposite.
//   - Stop: at spike high/low + buffer (bufferAtrMul * ATR).
//   - Target: tpFracOfSpike * spike_range from entry (small fraction).
function spikeFade(
  candles: Candle[],
  spikeNAtr: number,
  bufferAtrMul: number,
  tpFracOfSpike: number,
  requireConfirmation: boolean,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);

  // Need at least 16 bars before we have prior-bar ATR.
  for (let i = 16; i < candles.length - 1; i++) {
    const spike = candles[i];
    const range = spike.high - spike.low;
    const priorAtr = atrAt(i - 1);
    if (priorAtr <= 0) continue;
    if (range < spikeNAtr * priorAtr) continue;

    // Confirmation: next bar must close within spike's range (no continuation).
    const conf = candles[i + 1];
    if (requireConfirmation) {
      const closedInside = conf.close <= spike.high && conf.close >= spike.low;
      if (!closedInside) continue;
    }

    const dir = spike.close >= spike.open ? "up" : "down";
    const fadeSide: "BUY" | "SELL" = dir === "up" ? "SELL" : "BUY";

    let stopPrice: number, targetPrice: number;
    const buffer = bufferAtrMul * priorAtr;
    const entry = conf.close;
    if (fadeSide === "SELL") {
      stopPrice = spike.high + buffer;
      targetPrice = entry - tpFracOfSpike * range;
      if (stopPrice <= entry) continue; // sanity
      if (targetPrice >= entry) continue;
    } else {
      stopPrice = spike.low - buffer;
      targetPrice = entry + tpFracOfSpike * range;
      if (stopPrice >= entry) continue;
      if (targetPrice <= entry) continue;
    }
    sigs.push({ idx: i + 1, side: fadeSide, stopPrice, targetPrice });
  }
  return sigs;
}

// ── Strategy 2: Bollinger reversion ─────────────────────────────────────────
// Close > upper → SELL, target = mean. Close < lower → BUY, target = mean.
// Stop: bbStopBuffer * (upper - mean) beyond the band.
function bollingerReversion(
  candles: Candle[],
  period: number,
  stdDev: number,
  stopBufferStdDev: number,
): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const bb = BollingerBands.calculate({ period, values: closes, stdDev });
  const offset = candles.length - bb.length;
  const sigs: SimSignal[] = [];
  for (let i = 0; i < bb.length; i++) {
    const idx = i + offset;
    const { upper, lower, middle } = bb[i];
    const close = candles[idx].close;
    const halfWidth = upper - middle;
    if (halfWidth <= 0) continue;
    if (close > upper) {
      const stop = upper + stopBufferStdDev * halfWidth;
      const target = middle;
      if (stop > close && target < close) sigs.push({ idx, side: "SELL", stopPrice: stop, targetPrice: target });
    } else if (close < lower) {
      const stop = lower - stopBufferStdDev * halfWidth;
      const target = middle;
      if (stop < close && target > close) sigs.push({ idx, side: "BUY", stopPrice: stop, targetPrice: target });
    }
  }
  return sigs;
}

// ── Strategy 3: Donchian breakout ───────────────────────────────────────────
// On bar i, if close > max(high[i-N..i-1]) → BUY, stop = recent low - buffer,
// target = entry + R * (entry - stop).
function donchianBreakout(
  candles: Candle[],
  lookback: number,
  rMult: number,
  bufferAtrMul: number,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);

  for (let i = lookback; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - lookback; k < i; k++) {
      if (candles[k].high > hi) hi = candles[k].high;
      if (candles[k].low < lo) lo = candles[k].low;
    }
    const c = candles[i].close;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const buf = bufferAtrMul * atr;
    if (c > hi) {
      const stop = lo - buf;
      const risk = c - stop;
      if (risk <= 0) continue;
      const target = c + rMult * risk;
      sigs.push({ idx: i, side: "BUY", stopPrice: stop, targetPrice: target });
    } else if (c < lo) {
      const stop = hi + buf;
      const risk = stop - c;
      if (risk <= 0) continue;
      const target = c - rMult * risk;
      sigs.push({ idx: i, side: "SELL", stopPrice: stop, targetPrice: target });
    }
  }
  return sigs;
}

// ── Strategy 4: RSI extremes reversion ──────────────────────────────────────
function rsiReversion(
  candles: Candle[],
  period: number,
  buyBelow: number,
  sellAbove: number,
  atrSlMult: number,
  atrTpMult: number,
): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const rsi = RSI.calculate({ period, values: closes });
  const offset = candles.length - rsi.length;
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 0; i < rsi.length; i++) {
    const idx = i + offset;
    const v = rsi[i];
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    const c = candles[idx].close;
    if (v < buyBelow) {
      sigs.push({ idx, side: "BUY", stopPrice: c - atrSlMult * atr, targetPrice: c + atrTpMult * atr });
    } else if (v > sellAbove) {
      sigs.push({ idx, side: "SELL", stopPrice: c + atrSlMult * atr, targetPrice: c - atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Strategy 5: 3-of-5 majority direction fade ──────────────────────────────
// If ≥4 of last 5 closes moved up → SELL (mean-revert). Mirror for down.
// Tight ATR-based stop & TP.
function majorityFade(
  candles: Candle[],
  window: number,
  threshold: number,
  atrSlMult: number,
  atrTpMult: number,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);

  for (let i = window; i < candles.length; i++) {
    let up = 0, down = 0;
    for (let k = i - window + 1; k <= i; k++) {
      const move = candles[k].close - candles[k].open;
      if (move > 0) up++;
      else if (move < 0) down++;
    }
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    if (up >= threshold) {
      sigs.push({ idx: i, side: "SELL", stopPrice: c + atrSlMult * atr, targetPrice: c - atrTpMult * atr });
    } else if (down >= threshold) {
      sigs.push({ idx: i, side: "BUY", stopPrice: c - atrSlMult * atr, targetPrice: c + atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Stats / scoring ─────────────────────────────────────────────────────────
type Stats = {
  trades: number;
  wins: number;
  losses: number;
  wr: number;
  expR: number;
  totalUsd: number;
  avgUsd: number;
  maxDDUsd: number;
  perDay: number;
  // Sub-period stability — split trades into 2 halves by epoch.
  halfA_total: number;
  halfA_trades: number;
  halfB_total: number;
  halfB_trades: number;
  bothPositive: boolean;
};

function computeStats(trades: SimTrade[], candles: Candle[]): Stats {
  const wins = trades.filter((t) => t.pnlUsd > 0).length;
  const losses = trades.filter((t) => t.pnlUsd <= 0).length;
  const totalUsd = trades.reduce((a, t) => a + t.pnlUsd, 0);
  const wr = trades.length > 0 ? wins / trades.length : 0;
  // R-expectancy: pnl / (entry - stop) * sign, averaged.
  let rSum = 0;
  for (const t of trades) {
    const risk = Math.abs(t.entryPrice - t.stopPrice);
    if (risk <= 0) continue;
    const r = (t.pnlPct * t.entryPrice) / risk;
    rSum += r;
  }
  const expR = trades.length > 0 ? rSum / trades.length : 0;

  // Equity drawdown.
  let eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    eq += t.pnlUsd;
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDD) maxDD = dd;
  }

  // Days span.
  const firstE = candles[0]?.epoch ?? 0;
  const lastE = candles[candles.length - 1]?.epoch ?? firstE;
  const days = Math.max(1, (lastE - firstE) / 86400);
  const perDay = trades.length / days;

  // Half-period stability — use trades' open epochs split at mid-time.
  const midEpoch = (firstE + lastE) / 2;
  const halfA = trades.filter((t) => candles[t.openIdx].epoch < midEpoch);
  const halfB = trades.filter((t) => candles[t.openIdx].epoch >= midEpoch);
  const halfA_total = halfA.reduce((a, t) => a + t.pnlUsd, 0);
  const halfB_total = halfB.reduce((a, t) => a + t.pnlUsd, 0);

  return {
    trades: trades.length, wins, losses, wr, expR, totalUsd,
    avgUsd: trades.length > 0 ? totalUsd / trades.length : 0,
    maxDDUsd: maxDD, perDay,
    halfA_total, halfA_trades: halfA.length,
    halfB_total, halfB_trades: halfB.length,
    bothPositive: halfA_total > 0 && halfB_total > 0,
  };
}

// ── Variant definitions ─────────────────────────────────────────────────────
type Variant = {
  name: string;
  symbol: string;
  granularity: number;       // 60 = 1m, 300 = 5m
  build: (candles: Candle[]) => SimSignal[];
  // Override default ATR-based stop/TP behaviour when a variant emits signals
  // without explicit stop/target. (All our strategies emit explicit levels
  // except via fallback — kept here for clarity / future use.)
  atrSlMult: number;
  atrTpMult: number;
};

const VARIANTS: Variant[] = [
  // ── 1. Spike fade — BOOM/CRASH 1m & 5m ────────────────────────────────────
  // BOOM has rare large UP spikes; CRASH has rare DOWN spikes. Fade them.
  // Variants vary spike threshold (smaller=more trades, bigger=cleaner spikes)
  // and tp fraction (faster reversion target = higher WR but lower R).
  ...["BOOM1000", "BOOM500", "BOOM300N", "CRASH1000", "CRASH500", "CRASH300N"].flatMap((sym) =>
    [
      { tag: "n3.0_buf0.1_tp0.3", spikeN: 3.0, buf: 0.1, tpFrac: 0.3, conf: true  },
      { tag: "n4.0_buf0.1_tp0.3", spikeN: 4.0, buf: 0.1, tpFrac: 0.3, conf: true  },
      { tag: "n5.0_buf0.1_tp0.3", spikeN: 5.0, buf: 0.1, tpFrac: 0.3, conf: true  },
      { tag: "n3.0_buf0.2_tp0.5", spikeN: 3.0, buf: 0.2, tpFrac: 0.5, conf: true  },
      { tag: "n3.0_buf0.1_tp0.3_noconf", spikeN: 3.0, buf: 0.1, tpFrac: 0.3, conf: false },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Spike-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => spikeFade(c, v.spikeN, v.buf, v.tpFrac, v.conf),
      atrSlMult: 1.0, atrTpMult: 2.0,
    })))
  ),
  // ── 2. Bollinger reversion — R_100 / 1HZ100V ──────────────────────────────
  ...["R_100", "1HZ100V"].flatMap((sym) =>
    [
      { tag: "20_2.0_0.2", p: 20, sd: 2.0, sb: 0.2 },
      { tag: "20_2.0_0.5", p: 20, sd: 2.0, sb: 0.5 },
      { tag: "20_2.5_0.2", p: 20, sd: 2.5, sb: 0.2 },
      { tag: "30_2.0_0.2", p: 30, sd: 2.0, sb: 0.2 },
      { tag: "20_2.0_1.0", p: 20, sd: 2.0, sb: 1.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Boll-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => bollingerReversion(c, v.p, v.sd, v.sb),
      atrSlMult: 1.0, atrTpMult: 2.0,
    })))
  ),
  // ── 3. Donchian breakout — Step Index ─────────────────────────────────────
  ...["stpRNG"].flatMap((sym) =>
    [
      { tag: "lb20_R2_buf0.2", lb: 20, rm: 2.0, buf: 0.2 },
      { tag: "lb50_R2_buf0.2", lb: 50, rm: 2.0, buf: 0.2 },
      { tag: "lb20_R3_buf0.2", lb: 20, rm: 3.0, buf: 0.2 },
      { tag: "lb20_R1.5_buf0.5", lb: 20, rm: 1.5, buf: 0.5 },
      { tag: "lb100_R2_buf0.2", lb: 100, rm: 2.0, buf: 0.2 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Donch-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => donchianBreakout(c, v.lb, v.rm, v.buf),
      atrSlMult: 1.0, atrTpMult: 2.0,
    })))
  ),
  // ── 4. RSI extremes — 1HZ100V ─────────────────────────────────────────────
  ...["1HZ100V"].flatMap((sym) =>
    [
      { tag: "p14_25_75_sl1_tp1.5", p: 14, lo: 25, hi: 75, sl: 1.0, tp: 1.5 },
      { tag: "p14_20_80_sl1_tp1.5", p: 14, lo: 20, hi: 80, sl: 1.0, tp: 1.5 },
      { tag: "p14_30_70_sl1_tp1",  p: 14, lo: 30, hi: 70, sl: 1.0, tp: 1.0 },
      { tag: "p14_25_75_sl0.5_tp1", p: 14, lo: 25, hi: 75, sl: 0.5, tp: 1.0 },
      { tag: "p7_25_75_sl1_tp1.5",  p: 7,  lo: 25, hi: 75, sl: 1.0, tp: 1.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `RSI-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => rsiReversion(c, v.p, v.lo, v.hi, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
  // ── 5. Majority-direction fade — R_100 ────────────────────────────────────
  ...["R_100"].flatMap((sym) =>
    [
      { tag: "w5_t4_sl1_tp1",   w: 5, th: 4, sl: 1.0, tp: 1.0 },
      { tag: "w5_t5_sl1_tp1",   w: 5, th: 5, sl: 1.0, tp: 1.0 },
      { tag: "w5_t4_sl0.5_tp1", w: 5, th: 4, sl: 0.5, tp: 1.0 },
      { tag: "w7_t6_sl1_tp1",   w: 7, th: 6, sl: 1.0, tp: 1.0 },
      { tag: "w5_t4_sl1_tp2",   w: 5, th: 4, sl: 1.0, tp: 2.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Maj-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => majorityFade(c, v.w, v.th, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
];

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const c = new C(); await c.ready;

  // 30 days of 1m bars = 43,200 bars; 30 days of 5m = 8,640 bars.
  // Cap fetch by granularity; round up to ensure we have ≥30 days of data.
  const FETCH_BY_GR: Record<number, number> = {
    60: 25000,    // ~17 days at 1m — Deriv caps fetches; 25k is what we can reliably collect with paging
    300: 9000,    // ~31 days at 5m
  };

  // Cache fetched candles per (symbol × granularity) — multiple variants share the same data.
  const cache = new Map<string, Candle[]>();
  const cacheKey = (s: string, g: number) => `${s}_${g}`;

  const symbolsNeeded = new Set<string>();
  const grNeeded = new Set<number>();
  for (const v of VARIANTS) { symbolsNeeded.add(v.symbol); grNeeded.add(v.granularity); }
  const fetchPlan: Array<{ sym: string; gr: number }> = [];
  for (const v of VARIANTS) {
    const k = cacheKey(v.symbol, v.granularity);
    if (!cache.has(k) && !fetchPlan.find((p) => p.sym === v.symbol && p.gr === v.granularity)) {
      fetchPlan.push({ sym: v.symbol, gr: v.granularity });
    }
  }

  console.log(`Fast-research: ${VARIANTS.length} variants, ${fetchPlan.length} (sym × gr) data fetches.`);
  console.log(`Symbols: ${Array.from(symbolsNeeded).join(", ")}`);
  console.log(`Granularities: ${Array.from(grNeeded).map((g) => g === 60 ? "1m" : "5m").join(", ")}`);
  console.log("");

  let fetchIdx = 0;
  for (const { sym, gr } of fetchPlan) {
    fetchIdx++;
    process.stdout.write(`[${fetchIdx}/${fetchPlan.length}] fetch ${sym} ${gr === 60 ? "1m" : "5m"} (${FETCH_BY_GR[gr]} bars)...`);
    let candles: Candle[] | null = null;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        candles = await fetchPaged(c, sym, gr, FETCH_BY_GR[gr]);
        break;
      } catch (e) {
        lastErr = e as Error;
        try { await c.reconnect(); } catch {}
      }
    }
    if (!candles) {
      console.log(` FAIL (${lastErr?.message ?? "unknown"})`);
      continue;
    }
    const span = candles.length > 0 ? (candles[candles.length - 1].epoch - candles[0].epoch) / 86400 : 0;
    console.log(` ${candles.length} bars (${span.toFixed(1)}d)`);
    cache.set(cacheKey(sym, gr), candles);
    await new Promise((r) => setTimeout(r, 200));
  }

  c.close();

  // Run all variants.
  console.log("");
  console.log("Running variants...");
  console.log("");

  type Result = {
    name: string; symbol: string; granularity: number; gr_label: string; days: number;
    stats: Stats;
  };
  const results: Result[] = [];

  for (const v of VARIANTS) {
    const candles = cache.get(cacheKey(v.symbol, v.granularity));
    if (!candles || candles.length < 200) {
      console.log(`  ${v.name.padEnd(50)}  no data — skip`);
      continue;
    }
    const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
    let signals: SimSignal[] = [];
    try {
      signals = v.build(candles);
    } catch (e) {
      console.log(`  ${v.name.padEnd(50)}  build error: ${(e as Error).message}`);
      continue;
    }
    const trades = simulate(candles, signals, {
      atrSlMult: v.atrSlMult,
      atrTpMult: v.atrTpMult,
      costBps: COST_BPS,
    });
    const stats = computeStats(trades, candles);
    results.push({
      name: v.name, symbol: v.symbol, granularity: v.granularity,
      gr_label: v.granularity === 60 ? "1m" : "5m",
      days: span, stats,
    });
    const wrPct = (stats.wr * 100).toFixed(0);
    const sign = stats.totalUsd >= 0 ? "+" : "";
    console.log(
      `  ${v.name.padEnd(52)} ` +
      `${String(stats.trades).padStart(4)}t  ` +
      `WR=${wrPct.padStart(2)}%  ` +
      `expR=${stats.expR.toFixed(2).padStart(5)}  ` +
      `${sign}$${stats.totalUsd.toFixed(0).padStart(5)}  ` +
      `DD=$${stats.maxDDUsd.toFixed(0).padStart(4)}  ` +
      `${stats.perDay.toFixed(1)}/d  ` +
      `[A:${stats.halfA_total >= 0 ? "+" : ""}$${stats.halfA_total.toFixed(0)} (${stats.halfA_trades}t) | B:${stats.halfB_total >= 0 ? "+" : ""}$${stats.halfB_total.toFixed(0)} (${stats.halfB_trades}t)]` +
      (stats.bothPositive ? "  STABLE" : "")
    );
  }

  // ── Top picks ────────────────────────────────────────────────────────────
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("PASS BAR: trades ≥ 30 (over data span), (WR ≥ 55% OR expR ≥ +0.3), bothPositive halves");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const passed = results
    .filter((r) => r.stats.trades >= 30 && (r.stats.wr >= 0.55 || r.stats.expR >= 0.3) && r.stats.bothPositive)
    .sort((a, b) => b.stats.totalUsd - a.stats.totalUsd);
  if (passed.length === 0) {
    console.log("  ❌ No variant passed strict bar.");
  } else {
    for (const r of passed) {
      console.log(`  ✓ ${r.name.padEnd(52)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} DD=$${r.stats.maxDDUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d`);
    }
  }

  // Looser bar — for "honest report" listings.
  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("LOOSER BAR: trades ≥ 30, totalUsd > 0, bothPositive halves (top 15)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const loose = results
    .filter((r) => r.stats.trades >= 30 && r.stats.totalUsd > 0 && r.stats.bothPositive)
    .sort((a, b) => b.stats.totalUsd - a.stats.totalUsd)
    .slice(0, 15);
  for (const r of loose) {
    console.log(`  · ${r.name.padEnd(52)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} DD=$${r.stats.maxDDUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d`);
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 15 BY $TOTAL (any criteria)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const topUsd = [...results].sort((a, b) => b.stats.totalUsd - a.stats.totalUsd).slice(0, 15);
  for (const r of topUsd) {
    const stable = r.stats.bothPositive ? "STABLE" : "unstable";
    console.log(`  · ${r.name.padEnd(52)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d ${stable}`);
  }

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 10 BY EXPECTANCY R (≥30 trades)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const topR = results.filter((r) => r.stats.trades >= 30).sort((a, b) => b.stats.expR - a.stats.expR).slice(0, 10);
  for (const r of topR) {
    console.log(`  · ${r.name.padEnd(52)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d`);
  }

  // Persist.
  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  writeFileSync(".tmp/fast-research-results.json", JSON.stringify({
    timestamp: new Date().toISOString(),
    cost_bps: COST_BPS, stake: STAKE, mult: MULT,
    results,
  }, null, 2));
  console.log("");
  console.log("Saved .tmp/fast-research-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

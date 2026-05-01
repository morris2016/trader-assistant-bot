// Fast-research v2 — expanded search around the v1 winner family.
//
// v1 found spike-fade had structural edge on BOOM300N + CRASH300N at 1m.
// v2 tests:
//   1. Spike-fade across ALL Boom/Crash variants (500, 1000, plus revisit 300N
//      with finer parameter grid).
//   2. Drift-pullback: trade in drift direction after N consecutive bars
//      against drift (mean-revert into drift).
//   3. Inside-bar breakout: bar fully inside prior bar → breakout = directional.
//   4. NR4 volatility expansion: narrowest range of 4 → expand = trade.
//   5. EMA-fast/slow crossover: trend-following on Vol indices.
//
// SAME simulator + scoring as v1 so results are directly comparable.

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR, EMA } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;

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

type SimSignal = { idx: number; side: "BUY" | "SELL"; stopPrice?: number; targetPrice?: number };
type SimTrade = {
  side: "BUY" | "SELL";
  openIdx: number; closeIdx: number;
  entryPrice: number; exitPrice: number;
  stopPrice: number; targetPrice: number;
  pnlPct: number; exitReason: "tp" | "sl" | "opposite_signal" | "run_end"; pnlUsd: number;
};

function simulate(
  candles: Candle[],
  signals: SimSignal[],
  opts: { atrSlMult: number; atrTpMult: number; costBps: number; atrPeriod?: number },
): SimTrade[] {
  const period = opts.atrPeriod ?? 14;
  const costFrac = opts.costBps / 10000;
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
    const sigs = sigByIdx.get(i);
    if (sigs) {
      for (const sig of sigs) {
        if (open && open.side !== sig.side) {
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
            openIdx: i, closeIdx: -1,
            entryPrice: entry, exitPrice: 0,
            stopPrice, targetPrice,
            pnlPct: 0, exitReason: "run_end", pnlUsd: 0,
          };
        }
      }
    }
  }
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

// ── Strategy 1: Spike-fade (same as v1, expanded grid) ────────────────────
function spikeFade(
  candles: Candle[],
  spikeNAtr: number, bufferAtrMul: number, tpFracOfSpike: number, requireConfirmation: boolean,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = 16; i < candles.length - 1; i++) {
    const spike = candles[i];
    const range = spike.high - spike.low;
    const priorAtr = atrAt(i - 1);
    if (priorAtr <= 0) continue;
    if (range < spikeNAtr * priorAtr) continue;
    const conf = candles[i + 1];
    if (requireConfirmation) {
      const inside = conf.close <= spike.high && conf.close >= spike.low;
      if (!inside) continue;
    }
    const dirUp = spike.close >= spike.open;
    const fadeSide: "BUY" | "SELL" = dirUp ? "SELL" : "BUY";
    const buffer = bufferAtrMul * priorAtr;
    const entry = conf.close;
    let stopPrice: number, targetPrice: number;
    if (fadeSide === "SELL") {
      stopPrice = spike.high + buffer;
      targetPrice = entry - tpFracOfSpike * range;
      if (stopPrice <= entry || targetPrice >= entry) continue;
    } else {
      stopPrice = spike.low - buffer;
      targetPrice = entry + tpFracOfSpike * range;
      if (stopPrice >= entry || targetPrice <= entry) continue;
    }
    sigs.push({ idx: i + 1, side: fadeSide, stopPrice, targetPrice });
  }
  return sigs;
}

// ── Strategy 2: Drift pullback ─────────────────────────────────────────────
// On assets with strong drift (BOOM=down, CRASH=up, RDBULL=up), a pullback
// against drift is a buying/selling opportunity. After N consecutive
// against-drift bars, fade back into drift direction.
function driftPullback(
  candles: Candle[],
  driftDirection: 1 | -1,        // +1 = up-drift (CRASH/RDBULL), -1 = down-drift (BOOM)
  consecAgainst: number,         // require this many in a row against drift
  atrSlMult: number, atrTpMult: number,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = consecAgainst; i < candles.length; i++) {
    let allAgainst = true;
    for (let k = i - consecAgainst + 1; k <= i; k++) {
      const prev = candles[k - 1]?.close ?? candles[k].open;
      const moved = candles[k].close - prev;
      // Against drift means: moved against driftDirection
      if (driftDirection === 1 && moved >= 0) { allAgainst = false; break; }
      if (driftDirection === -1 && moved <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    if (driftDirection === 1) {
      sigs.push({ idx: i, side: "BUY", stopPrice: c - atrSlMult * atr, targetPrice: c + atrTpMult * atr });
    } else {
      sigs.push({ idx: i, side: "SELL", stopPrice: c + atrSlMult * atr, targetPrice: c - atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Strategy 3: Inside-bar breakout ────────────────────────────────────────
// Bar i is inside bar i-1 (high < prev.high AND low > prev.low). On bar i+1
// close, trade in the direction of breakout from bar i-1's range.
function insideBarBreakout(
  candles: Candle[],
  atrSlMult: number, atrTpMult: number,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = 2; i < candles.length; i++) {
    const prev = candles[i - 2];
    const inside = candles[i - 1];
    const trigger = candles[i];
    if (!(inside.high < prev.high && inside.low > prev.low)) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = trigger.close;
    if (c > prev.high) {
      sigs.push({ idx: i, side: "BUY", stopPrice: c - atrSlMult * atr, targetPrice: c + atrTpMult * atr });
    } else if (c < prev.low) {
      sigs.push({ idx: i, side: "SELL", stopPrice: c + atrSlMult * atr, targetPrice: c - atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Strategy 4: NR4 volatility expansion ───────────────────────────────────
// Bar i has the smallest range of the last 4. On bar i+1, if it breaks above
// the NR4 bar's high → BUY, breaks below → SELL.
function nr4Breakout(
  candles: Candle[],
  atrSlMult: number, atrTpMult: number,
): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = 4; i < candles.length; i++) {
    const nr4Idx = i - 1;
    const nr4 = candles[nr4Idx];
    let isNr4 = true;
    const nr4Range = nr4.high - nr4.low;
    for (let k = nr4Idx - 3; k < nr4Idx; k++) {
      if (candles[k].high - candles[k].low <= nr4Range) { isNr4 = false; break; }
    }
    if (!isNr4) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    if (c > nr4.high) {
      sigs.push({ idx: i, side: "BUY", stopPrice: nr4.low, targetPrice: c + atrTpMult * atr });
    } else if (c < nr4.low) {
      sigs.push({ idx: i, side: "SELL", stopPrice: nr4.high, targetPrice: c - atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Strategy 5: EMA fast/slow crossover ────────────────────────────────────
function emaCrossover(
  candles: Candle[],
  fastP: number, slowP: number,
  atrSlMult: number, atrTpMult: number,
): SimSignal[] {
  if (candles.length < slowP + 2) return [];
  const closes = candles.map((c) => c.close);
  const fast = EMA.calculate({ period: fastP, values: closes });
  const slow = EMA.calculate({ period: slowP, values: closes });
  const fastOff = candles.length - fast.length;
  const slowOff = candles.length - slow.length;
  const fAt = (i: number) => (i < fastOff ? NaN : fast[i - fastOff]);
  const sAt = (i: number) => (i < slowOff ? NaN : slow[i - slowOff]);
  const atrSeries = ATR.calculate({
    period: 14,
    high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close),
  });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = slowP + 1; i < candles.length; i++) {
    const fNow = fAt(i), fPrev = fAt(i - 1);
    const sNow = sAt(i), sPrev = sAt(i - 1);
    if (!Number.isFinite(fNow) || !Number.isFinite(sNow) || !Number.isFinite(fPrev) || !Number.isFinite(sPrev)) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    const c = candles[i].close;
    if (fPrev <= sPrev && fNow > sNow) {
      sigs.push({ idx: i, side: "BUY", stopPrice: c - atrSlMult * atr, targetPrice: c + atrTpMult * atr });
    } else if (fPrev >= sPrev && fNow < sNow) {
      sigs.push({ idx: i, side: "SELL", stopPrice: c + atrSlMult * atr, targetPrice: c - atrTpMult * atr });
    }
  }
  return sigs;
}

// ── Stats / scoring (same as v1) ───────────────────────────────────────────
type Stats = {
  trades: number; wins: number; losses: number;
  wr: number; expR: number;
  totalUsd: number; avgUsd: number; maxDDUsd: number;
  perDay: number;
  halfA_total: number; halfA_trades: number;
  halfB_total: number; halfB_trades: number;
  bothPositive: boolean;
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
  return {
    trades: trades.length, wins, losses, wr, expR, totalUsd,
    avgUsd: trades.length > 0 ? totalUsd / trades.length : 0,
    maxDDUsd: maxDD, perDay: trades.length / days,
    halfA_total, halfA_trades: halfA.length,
    halfB_total, halfB_trades: halfB.length,
    bothPositive: halfA_total > 0 && halfB_total > 0,
  };
}

type Variant = {
  name: string; symbol: string; granularity: number;
  build: (candles: Candle[]) => SimSignal[];
  atrSlMult: number; atrTpMult: number;
};

// Symbols with drift (for drift-pullback)
const DRIFT_UP = ["CRASH300N", "CRASH500", "CRASH1000", "CRASH1000N", "RDBULL"];
const DRIFT_DOWN = ["BOOM300N", "BOOM500", "BOOM1000", "BOOM1000N", "RDBEAR"];

const VARIANTS: Variant[] = [
  // 1. Spike-fade EXPANDED — all Boom/Crash variants
  ...["BOOM1000", "BOOM500", "BOOM300N", "CRASH1000", "CRASH500", "CRASH300N"].flatMap((sym) =>
    [
      { tag: "n2.5_buf0.2_tp0.5", spikeN: 2.5, buf: 0.2, tpFrac: 0.5, conf: true  },
      { tag: "n3.0_buf0.2_tp0.5", spikeN: 3.0, buf: 0.2, tpFrac: 0.5, conf: true  },
      { tag: "n3.5_buf0.2_tp0.5", spikeN: 3.5, buf: 0.2, tpFrac: 0.5, conf: true  },
      { tag: "n3.0_buf0.3_tp0.5", spikeN: 3.0, buf: 0.3, tpFrac: 0.5, conf: true  },
      { tag: "n3.0_buf0.2_tp0.7", spikeN: 3.0, buf: 0.2, tpFrac: 0.7, conf: true  },
      { tag: "n3.0_buf0.2_tp0.4", spikeN: 3.0, buf: 0.2, tpFrac: 0.4, conf: true  },
      { tag: "n3.0_buf0.2_tp0.5_5m", spikeN: 3.0, buf: 0.2, tpFrac: 0.5, conf: true  },
    ].flatMap((v) => {
      const grs = v.tag.endsWith("_5m") ? [300] : [60];
      return grs.map((gr) => ({
        name: `Spike-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
        symbol: sym, granularity: gr,
        build: (c: Candle[]) => spikeFade(c, v.spikeN, v.buf, v.tpFrac, v.conf),
        atrSlMult: 1.0, atrTpMult: 1.0,
      }));
    })
  ),
  // 2. Drift pullback — UP-drift symbols
  ...DRIFT_UP.flatMap((sym) =>
    [
      { tag: "k2_sl1_tp1.5", k: 2, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl1_tp1.5", k: 3, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl0.5_tp1", k: 3, sl: 0.5, tp: 1.0 },
      { tag: "k4_sl1_tp1.5", k: 4, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl1_tp2",   k: 3, sl: 1.0, tp: 2.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Pullback-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => driftPullback(c, 1, v.k, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
  // ... DOWN-drift symbols
  ...DRIFT_DOWN.flatMap((sym) =>
    [
      { tag: "k2_sl1_tp1.5", k: 2, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl1_tp1.5", k: 3, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl0.5_tp1", k: 3, sl: 0.5, tp: 1.0 },
      { tag: "k4_sl1_tp1.5", k: 4, sl: 1.0, tp: 1.5 },
      { tag: "k3_sl1_tp2",   k: 3, sl: 1.0, tp: 2.0 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Pullback-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => driftPullback(c, -1, v.k, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
  // 3. Inside-bar breakout
  ...["BOOM300N", "BOOM500", "CRASH300N", "CRASH500", "R_100", "1HZ100V", "RDBULL", "JD100"].flatMap((sym) =>
    [
      { tag: "sl1_tp2",     sl: 1.0, tp: 2.0 },
      { tag: "sl0.5_tp1.5", sl: 0.5, tp: 1.5 },
      { tag: "sl1_tp1.5",   sl: 1.0, tp: 1.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `Inside-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => insideBarBreakout(c, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
  // 4. NR4 volatility expansion
  ...["BOOM300N", "BOOM500", "CRASH300N", "CRASH500", "R_100", "1HZ100V", "RDBULL"].flatMap((sym) =>
    [
      { tag: "sl1_tp2",     sl: 1.0, tp: 2.0 },
      { tag: "sl1_tp3",     sl: 1.0, tp: 3.0 },
      { tag: "sl0.5_tp1.5", sl: 0.5, tp: 1.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `NR4-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => nr4Breakout(c, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
    })))
  ),
  // 5. EMA crossover
  ...["BOOM300N", "BOOM500", "CRASH300N", "CRASH500", "R_100", "1HZ100V", "RDBULL", "JD100"].flatMap((sym) =>
    [
      { tag: "9_21_sl1_tp2",   f: 9, s: 21, sl: 1.0, tp: 2.0 },
      { tag: "9_21_sl0.5_tp1.5", f: 9, s: 21, sl: 0.5, tp: 1.5 },
      { tag: "20_50_sl1_tp2",  f: 20, s: 50, sl: 1.0, tp: 2.0 },
      { tag: "5_13_sl1_tp1.5", f: 5, s: 13, sl: 1.0, tp: 1.5 },
    ].flatMap((v) => [60, 300].map((gr) => ({
      name: `EMA-${sym}-${gr === 60 ? "1m" : "5m"}-${v.tag}`,
      symbol: sym, granularity: gr,
      build: (c: Candle[]) => emaCrossover(c, v.f, v.s, v.sl, v.tp),
      atrSlMult: v.sl, atrTpMult: v.tp,
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
  console.log(`Fast-research v2: ${VARIANTS.length} variants, ${fetchPlan.length} (sym × gr) data fetches.`);
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
    if (!candles || candles.length < 200) {
      console.log(`  ${v.name.padEnd(50)}  no data — skip`);
      continue;
    }
    const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
    let signals: SimSignal[] = [];
    try { signals = v.build(candles); }
    catch (e) { console.log(`  ${v.name.padEnd(50)}  build error: ${(e as Error).message}`); continue; }
    const trades = simulate(candles, signals, { atrSlMult: v.atrSlMult, atrTpMult: v.atrTpMult, costBps: COST_BPS });
    const stats = computeStats(trades, candles);
    results.push({ name: v.name, symbol: v.symbol, granularity: v.granularity, gr_label: v.granularity === 60 ? "1m" : "5m", days: span, stats });
    const wrPct = (stats.wr * 100).toFixed(0);
    const sign = stats.totalUsd >= 0 ? "+" : "";
    console.log(
      `  ${v.name.padEnd(56)} ` +
      `${String(stats.trades).padStart(4)}t  WR=${wrPct.padStart(2)}%  expR=${stats.expR.toFixed(2).padStart(5)}  ` +
      `${sign}$${stats.totalUsd.toFixed(0).padStart(5)}  DD=$${stats.maxDDUsd.toFixed(0).padStart(4)}  ` +
      `${stats.perDay.toFixed(1)}/d  ` +
      `[A:${stats.halfA_total >= 0 ? "+" : ""}$${stats.halfA_total.toFixed(0)} (${stats.halfA_trades}t) | B:${stats.halfB_total >= 0 ? "+" : ""}$${stats.halfB_total.toFixed(0)} (${stats.halfB_trades}t)]` +
      (stats.bothPositive ? "  STABLE" : "")
    );
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("PASS BAR: trades ≥ 30, (WR ≥ 55% OR expR ≥ +0.3), bothPositive halves");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const passed = results
    .filter((r) => r.stats.trades >= 30 && (r.stats.wr >= 0.55 || r.stats.expR >= 0.3) && r.stats.bothPositive)
    .sort((a, b) => b.stats.totalUsd - a.stats.totalUsd);
  if (passed.length === 0) {
    console.log("  ❌ No variant passed strict bar.");
  } else {
    for (const r of passed) {
      console.log(`  ✓ ${r.name.padEnd(56)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} DD=$${r.stats.maxDDUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d`);
    }
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 20 BY $TOTAL (any criteria, ≥30 trades)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const topUsd = results.filter((r) => r.stats.trades >= 30).sort((a, b) => b.stats.totalUsd - a.stats.totalUsd).slice(0, 20);
  for (const r of topUsd) {
    const stable = r.stats.bothPositive ? "STABLE" : "unstable";
    console.log(`  · ${r.name.padEnd(56)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} DD=$${r.stats.maxDDUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d ${stable}`);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TOP 15 BY EXPECTANCY R (≥30 trades)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════");
  const topR = results.filter((r) => r.stats.trades >= 30).sort((a, b) => b.stats.expR - a.stats.expR).slice(0, 15);
  for (const r of topR) {
    const stable = r.stats.bothPositive ? "STABLE" : "unstable";
    console.log(`  · ${r.name.padEnd(56)} ${r.stats.trades}t WR=${(r.stats.wr*100).toFixed(0)}% expR=${r.stats.expR.toFixed(2)} +$${r.stats.totalUsd.toFixed(0)} ${r.stats.perDay.toFixed(1)}/d ${stable}`);
  }

  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  writeFileSync(".tmp/fast-research-v2-results.json", JSON.stringify({
    timestamp: new Date().toISOString(),
    cost_bps: COST_BPS, stake: STAKE, mult: MULT,
    results,
  }, null, 2));
  console.log("\nSaved .tmp/fast-research-v2-results.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

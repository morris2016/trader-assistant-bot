// RDBEAR loss-streak pattern analysis — detection side.
// Find every ≥5-loss streak in 152 days, capture bar-level context for each
// trade in the streak (vs neutral W trades), see what features distinguish
// streak-trades from baseline. Goal: find a bar-level filter that would skip
// the trades that turn into streaks without dropping winners.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

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

function adx(c: Candle[], i: number, period = 14): number {
  if (i < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const upMove = c[j].high - c[j - 1].high;
    const dnMove = c[j - 1].low - c[j].low;
    const pdm = upMove > dnMove && upMove > 0 ? upMove : 0;
    const ndm = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    plusDM += pdm; minusDM += ndm;
    tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
}

function efficiency(c: Candle[], i: number, w: number): number {
  if (i < w) return 0;
  const net = Math.abs(c[i].close - c[i - w].close);
  let sum = 0;
  for (let j = i - w + 1; j <= i; j++) sum += Math.abs(c[j].close - c[j - 1].close);
  return sum > 0 ? net / sum : 0;
}

// Slope of close over last N bars (regression slope normalized by ATR)
function priceSlope(c: Candle[], i: number, n: number): number {
  if (i < n) return 0;
  const a = atr(c, i, 14);
  if (a <= 0) return 0;
  // Simple linear regression slope on (j, close[j])
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let k = 0; k < n; k++) {
    const j = i - n + 1 + k;
    sumX += k;
    sumY += c[j].close;
    sumXY += k * c[j].close;
    sumXX += k * k;
  }
  const denom = n * sumXX - sumX * sumX;
  if (denom === 0) return 0;
  const slope = (n * sumXY - sumX * sumY) / denom;
  return slope / a; // bars-per-ATR-unit slope
}

// Recent up-spike count: bars in last N where range >= 3×ATR and close > open
function recentUpSpikes(c: Candle[], i: number, n: number): number {
  let count = 0;
  for (let j = Math.max(14, i - n); j < i; j++) {
    const a = atr(c, j, 14);
    if (a > 0 && (c[j].high - c[j].low) >= 3.0 * a && c[j].close > c[j].open) count++;
  }
  return count;
}

// Bars since last winning fade (proxy: bars since last sharp down move)
// Use this: how high above SMA(50) is current close, in ATR units?
function distanceAboveSma(c: Candle[], i: number, n: number): number {
  if (i < n) return 0;
  let sum = 0;
  for (let j = i - n + 1; j <= i; j++) sum += c[j].close;
  const sma = sum / n;
  const a = atr(c, i, 14);
  if (a <= 0) return 0;
  return (c[i].close - sma) / a;
}

type Sig = { idx: number; entry: number; stop: number; target: number; result: "TP" | "SL" };

function detectAndResolve(candles: Candle[]): Sig[] {
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
      // Resolve TP/SL
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
      if (exit) out.push({ idx: i, entry: cur.close, stop: cur.close + dist, target: cur.close - dist, result: exit });
    }
  }
  return out;
}

async function main() {
  console.log(`RDBEAR streak-pattern analysis — Dec 1 2025 → today\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, Math.ceil((TODAY - DEC_1) / GR) + 100, TODAY);
  c.close();

  const trades = detectAndResolve(candles).filter((t) => candles[t.idx].epoch >= DEC_1);
  console.log(`${trades.length} trades resolved\n`);

  // Identify streaks (≥5 consecutive SL)
  type StreakTrade = { sigIdx: number; barIdx: number; epoch: number; pos: number; streakLen: number; result: "TP" | "SL" };
  const streakTrades: StreakTrade[] = [];
  let cur = 0;
  let streakStart = 0;
  for (let i = 0; i < trades.length; i++) {
    if (trades[i].result === "SL") {
      if (cur === 0) streakStart = i;
      cur++;
    } else {
      if (cur >= 5) {
        // record this streak
        for (let k = 0; k < cur; k++) {
          const t = trades[streakStart + k];
          streakTrades.push({ sigIdx: streakStart + k, barIdx: t.idx, epoch: candles[t.idx].epoch, pos: k, streakLen: cur, result: "SL" });
        }
      }
      cur = 0;
    }
  }
  if (cur >= 5) {
    for (let k = 0; k < cur; k++) {
      const t = trades[streakStart + k];
      streakTrades.push({ sigIdx: streakStart + k, barIdx: t.idx, epoch: candles[t.idx].epoch, pos: k, streakLen: cur, result: "SL" });
    }
  }

  console.log(`Found ${streakTrades.length} trades inside ≥5-streaks`);
  // Group streaks
  const streakGroups = new Map<number, { len: number; trades: StreakTrade[] }>();
  let lastStart = -1;
  for (const t of streakTrades) {
    if (t.pos === 0) lastStart = t.sigIdx;
    if (!streakGroups.has(lastStart)) streakGroups.set(lastStart, { len: t.streakLen, trades: [] });
    streakGroups.get(lastStart)!.trades.push(t);
  }
  console.log(`${streakGroups.size} unique streaks of ≥5 losses\n`);
  console.log(`Streak length distribution:`);
  const lenCounts = new Map<number, number>();
  for (const g of streakGroups.values()) lenCounts.set(g.len, (lenCounts.get(g.len) ?? 0) + 1);
  for (const [l, n] of [...lenCounts.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${l}-streak: ${n} occurrence${n > 1 ? "s" : ""}`);
  }

  // Now compute features for each trade and split: streak vs non-streak
  type FeatRec = { f: Record<string, number>; result: "TP" | "SL"; inStreak: boolean; pos: number };
  const featRecs: FeatRec[] = [];
  const streakTradeIdxSet = new Set(streakTrades.map((s) => s.sigIdx));

  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const idx = t.barIdx ?? t.idx;
    const f: Record<string, number> = {
      adx: adx(candles, idx, 14),
      eff24: efficiency(candles, idx, 24),
      eff60: efficiency(candles, idx, 60),
      slope60: priceSlope(candles, idx, 60),
      slope200: priceSlope(candles, idx, 200),
      distSma50: distanceAboveSma(candles, idx, 50),
      distSma200: distanceAboveSma(candles, idx, 200),
      upSpikes30: recentUpSpikes(candles, idx, 30),
      upSpikes100: recentUpSpikes(candles, idx, 100),
      hour: new Date(candles[idx].epoch * 1000).getUTCHours(),
    };
    const stPos = streakTrades.find((x) => x.sigIdx === i)?.pos ?? -1;
    featRecs.push({ f, result: t.result, inStreak: streakTradeIdxSet.has(i), pos: stPos });
  }

  // Mean of each feature, split: in-streak SLs vs non-streak SLs vs all TPs
  const inStreakSL = featRecs.filter((r) => r.inStreak && r.result === "SL");
  const isolatedSL = featRecs.filter((r) => !r.inStreak && r.result === "SL");
  const allTP = featRecs.filter((r) => r.result === "TP");

  const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const features = ["adx", "eff24", "eff60", "slope60", "slope200", "distSma50", "distSma200", "upSpikes30", "upSpikes100", "hour"];

  console.log(`\nFEATURE MEANS by group:`);
  console.log(`  feature        TP(${allTP.length})    iso-SL(${isolatedSL.length})    streak-SL(${inStreakSL.length})    Δ(streak-TP)`);
  for (const k of features) {
    const tpM = mean(allTP.map((r) => r.f[k]));
    const isoM = mean(isolatedSL.map((r) => r.f[k]));
    const stM = mean(inStreakSL.map((r) => r.f[k]));
    const d = stM - tpM;
    const sig = Math.abs(d) > Math.abs(tpM) * 0.15 ? " *" : "";
    console.log(`  ${k.padEnd(13)}  ${tpM.toFixed(2).padStart(7)}     ${isoM.toFixed(2).padStart(7)}      ${stM.toFixed(2).padStart(7)}        ${d >= 0 ? "+" : ""}${d.toFixed(2)}${sig}`);
  }

  // First-trade-of-streak features (this is the prediction signal we need!)
  console.log(`\n*** FIRST-TRADE-OF-STREAK features (these are the signals we'd need to skip): ***`);
  const firstStreakTrades = featRecs.filter((r) => r.inStreak && r.pos === 0);
  console.log(`  feature        TP(all)    first-of-streak(${firstStreakTrades.length})    Δ`);
  for (const k of features) {
    const tpM = mean(allTP.map((r) => r.f[k]));
    const fsM = mean(firstStreakTrades.map((r) => r.f[k]));
    const d = fsM - tpM;
    const sig = Math.abs(d) > Math.abs(tpM) * 0.15 ? " *" : "";
    console.log(`  ${k.padEnd(13)}  ${tpM.toFixed(2).padStart(7)}     ${fsM.toFixed(2).padStart(15)}    ${d >= 0 ? "+" : ""}${d.toFixed(2)}${sig}`);
  }

  // Threshold scan: for each feature, find a cut that drops the most streak-starts while keeping the most TPs
  console.log(`\nFEATURE-BASED SKIP-RULE TEST (each rule simulates: skip when feature exceeds threshold):`);
  console.log(`  goal: reduce streak entries WITHOUT killing TP rate`);
  console.log(`  rule                    skipped  kept-TP   kept-iso-SL  kept-streak-SL  W-rate-after`);
  type Rule = { name: string; pred: (r: FeatRec) => boolean };
  const rules: Rule[] = [
    { name: "skip slope60 > +0.5",   pred: (r) => r.f.slope60 > 0.5 },
    { name: "skip slope60 > +1.0",   pred: (r) => r.f.slope60 > 1.0 },
    { name: "skip slope200 > +0.3",  pred: (r) => r.f.slope200 > 0.3 },
    { name: "skip distSma50 > +1.0", pred: (r) => r.f.distSma50 > 1.0 },
    { name: "skip distSma50 > +2.0", pred: (r) => r.f.distSma50 > 2.0 },
    { name: "skip distSma200 > +2.0",pred: (r) => r.f.distSma200 > 2.0 },
    { name: "skip eff60 > 0.50",     pred: (r) => r.f.eff60 > 0.50 },
    { name: "skip adx > 35",         pred: (r) => r.f.adx > 35 },
    { name: "skip upSpikes30 > 1",   pred: (r) => r.f.upSpikes30 > 1 },
    { name: "skip upSpikes100 > 5",  pred: (r) => r.f.upSpikes100 > 5 },
  ];
  const baseW = allTP.length;
  const baseStreak = inStreakSL.length;
  const baseTotal = featRecs.length;
  for (const r of rules) {
    const skip = featRecs.filter(r.pred);
    const kept = featRecs.filter((x) => !r.pred(x));
    const skipTP = skip.filter((x) => x.result === "TP").length;
    const skipStreakSL = skip.filter((x) => x.inStreak && x.result === "SL").length;
    const skipIsoSL = skip.filter((x) => !x.inStreak && x.result === "SL").length;
    const keptTP = kept.filter((x) => x.result === "TP").length;
    const keptIsoSL = kept.filter((x) => !x.inStreak && x.result === "SL").length;
    const keptStreakSL = kept.filter((x) => x.inStreak && x.result === "SL").length;
    const wrAfter = kept.length > 0 ? keptTP / kept.length : 0;
    console.log(`  ${r.name.padEnd(24)}  skip ${String(skip.length).padStart(4)} (TP-${skipTP}/iso-${skipIsoSL}/streak-${skipStreakSL})  kept TP=${keptTP} iso=${keptIsoSL} streak=${keptStreakSL}  WR=${(wrAfter*100).toFixed(1)}%`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

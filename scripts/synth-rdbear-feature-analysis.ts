// RDBEAR deep feature analysis — what wins, what loses, why.
// For every signal across 9 months: compute 20+ features, classify TP vs SL,
// then find which features have monotonic predictive relationships.
// Goal: build a smart score so the strategy can score each signal and skip
// the bottom decile (the losers) while keeping the rest. Train/test split.

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

// Indicators ─────────────────────────────────────────────────────────────────
function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}
function sma(c: Candle[], i: number, n: number): number {
  if (i < n) return c[i].close;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += c[j].close;
  return s / n;
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
function eff(c: Candle[], i: number, w: number): number {
  if (i < w) return 0;
  const net = Math.abs(c[i].close - c[i - w].close);
  let sum = 0;
  for (let j = i - w + 1; j <= i; j++) sum += Math.abs(c[j].close - c[j - 1].close);
  return sum > 0 ? net / sum : 0;
}
function slope(c: Candle[], i: number, n: number): number {
  if (i < n) return 0;
  const a = atr(c, i, 14);
  if (a <= 0) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < n; k++) {
    const j = i - n + 1 + k;
    sx += k; sy += c[j].close; sxy += k * c[j].close; sxx += k * k;
  }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return ((n * sxy - sx * sy) / denom) / a;
}

// ─── Detector + outcome resolver ─────────────────────────────────────────────
type Trade = { idx: number; entry: number; stop: number; target: number; result: "TP" | "SL"; barsToExit: number };

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
      let barsToExit = 0;
      for (let j = i + 1; j < candles.length; j++) {
        barsToExit++;
        const b = candles[j];
        if (b.high >= stop) { exit = "SL"; break; }
        if (b.low <= target) { exit = "TP"; break; }
      }
      if (exit) out.push({ idx: i, entry: cur.close, stop: cur.close + dist, target: cur.close - dist, result: exit, barsToExit });
    }
  }
  return out;
}

// ─── Feature extraction ──────────────────────────────────────────────────────
const FEATURES: Array<[string, (c: Candle[], i: number) => number]> = [
  // Volatility regime
  ["atr14_atrMed",      (c, i) => { const a = atr(c, i, 14); const med = atr(c, i, 100); return med > 0 ? a / med : 1; }],
  // Bar shape
  ["bar_range_atr",     (c, i) => { const a = atr(c, i, 14); return a > 0 ? (c[i].high - c[i].low) / a : 0; }],
  ["bar_body_pct",      (c, i) => { const r = c[i].high - c[i].low; return r > 0 ? Math.abs(c[i].close - c[i].open) / r : 0; }],
  ["bar_close_pos",     (c, i) => { const r = c[i].high - c[i].low; return r > 0 ? (c[i].close - c[i].low) / r : 0.5; }],
  ["bar_upper_wick",    (c, i) => { const r = c[i].high - c[i].low; return r > 0 ? (c[i].high - Math.max(c[i].open, c[i].close)) / r : 0; }],
  ["bar_lower_wick",    (c, i) => { const r = c[i].high - c[i].low; return r > 0 ? (Math.min(c[i].open, c[i].close) - c[i].low) / r : 0; }],
  // Breakout magnitude
  ["overshoot_atr",     (c, i) => { const a = atr(c, i, 14); let hi = -Infinity; for (let m = i - LOOKBACK; m < i; m++) if (c[m].high > hi) hi = c[m].high; return a > 0 ? (c[i].close - hi) / a : 0; }],
  // Distance from various means
  ["dist_sma20_atr",    (c, i) => { const a = atr(c, i, 14); return a > 0 ? (c[i].close - sma(c, i, 20)) / a : 0; }],
  ["dist_sma50_atr",    (c, i) => { const a = atr(c, i, 14); return a > 0 ? (c[i].close - sma(c, i, 50)) / a : 0; }],
  ["dist_sma200_atr",   (c, i) => { const a = atr(c, i, 14); return a > 0 ? (c[i].close - sma(c, i, 200)) / a : 0; }],
  // Trend strength
  ["adx14",             (c, i) => adx(c, i, 14)],
  ["eff24",             (c, i) => eff(c, i, 24)],
  ["eff60",             (c, i) => eff(c, i, 60)],
  ["eff200",            (c, i) => eff(c, i, 200)],
  ["slope20_atr",       (c, i) => slope(c, i, 20)],
  ["slope60_atr",       (c, i) => slope(c, i, 60)],
  ["slope200_atr",      (c, i) => slope(c, i, 200)],
  // Recent activity
  ["bull_bars_20",      (c, i) => { let n = 0; for (let j = i - 19; j <= i; j++) if (c[j].close > c[j].open) n++; return n; }],
  ["new_highs_20",      (c, i) => { let n = 0; for (let j = i - 19; j <= i; j++) { let prevHi = -Infinity; for (let k = j - 5; k < j; k++) if (k >= 0 && c[k].high > prevHi) prevHi = c[k].high; if (c[j].high > prevHi) n++; } return n; }],
  // Time
  ["hour_utc",          (c, i) => new Date(c[i].epoch * 1000).getUTCHours()],
  ["dow",               (c, i) => new Date(c[i].epoch * 1000).getUTCDay()],
];

type Row = { idx: number; f: number[]; result: "TP" | "SL"; barsToExit: number };

function buildRows(candles: Candle[], trades: Trade[]): Row[] {
  return trades.map((t) => ({
    idx: t.idx,
    f: FEATURES.map(([_, fn]) => fn(candles, t.idx)),
    result: t.result,
    barsToExit: t.barsToExit,
  }));
}

// ─── Decile analysis: TP rate by feature decile ─────────────────────────────
function decileAnalysis(rows: Row[], featIdx: number, featName: string): { name: string; bins: Array<{ lo: number; hi: number; n: number; tps: number; rate: number }>; monotonic: number } {
  const sorted = [...rows].sort((a, b) => a.f[featIdx] - b.f[featIdx]);
  const N = sorted.length;
  const binSize = Math.floor(N / 10);
  const bins = [];
  for (let d = 0; d < 10; d++) {
    const start = d * binSize;
    const end = d === 9 ? N : start + binSize;
    const slice = sorted.slice(start, end);
    const tps = slice.filter((r) => r.result === "TP").length;
    bins.push({
      lo: slice[0]?.f[featIdx] ?? 0,
      hi: slice[slice.length - 1]?.f[featIdx] ?? 0,
      n: slice.length,
      tps,
      rate: slice.length > 0 ? tps / slice.length : 0,
    });
  }
  // Monotonicity: correlation between bin index and TP rate
  let mean = 0; for (const b of bins) mean += b.rate; mean /= 10;
  let sxy = 0, sxx = 0, syy = 0;
  for (let d = 0; d < 10; d++) {
    sxy += (d - 4.5) * (bins[d].rate - mean);
    sxx += (d - 4.5) ** 2;
    syy += (bins[d].rate - mean) ** 2;
  }
  const monotonic = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  return { name: featName, bins, monotonic };
}

async function main() {
  console.log(`RDBEAR feature analysis — Jan 1 2025 → today, signal-level pattern detection\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  console.log(`Fetching ${need} bars...`);
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`  ${candles.length} bars (${(candles.length * GR / 86400).toFixed(1)} days)\n`);

  const trades = detectAndResolve(candles).filter((t) => candles[t.idx].epoch >= JAN_1_2025);
  const tpCount = trades.filter((t) => t.result === "TP").length;
  console.log(`${trades.length} trades · ${tpCount} TPs (${(tpCount/trades.length*100).toFixed(1)}% baseline WR)\n`);

  const rows = buildRows(candles, trades);

  // 70/30 train/test split (chronological)
  const splitIdx = Math.floor(rows.length * 0.7);
  const train = rows.slice(0, splitIdx);
  const test = rows.slice(splitIdx);
  console.log(`Train: ${train.length}  ·  Test: ${test.length}\n`);

  // Decile analysis on train
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`PER-FEATURE DECILE TP-RATE (train set, sorted by |monotonicity|)`);
  console.log(`${"".padEnd(110, "═")}`);
  const analyses = FEATURES.map(([name], idx) => decileAnalysis(train, idx, name));
  analyses.sort((a, b) => Math.abs(b.monotonic) - Math.abs(a.monotonic));

  for (const a of analyses) {
    const ratesStr = a.bins.map((b) => `${(b.rate * 100).toFixed(0).padStart(2)}%`).join(" ");
    const dir = a.monotonic > 0 ? "↑" : a.monotonic < 0 ? "↓" : "·";
    console.log(`  ${a.name.padEnd(20)}  mono=${a.monotonic.toFixed(2).padStart(5)} ${dir}  decile-rates: ${ratesStr}`);
  }

  // Top-3 monotonic features → simple score
  const top = analyses.slice(0, 3);
  console.log(`\nTop monotonic predictors:`);
  for (const a of top) {
    const dir = a.monotonic > 0 ? "HIGHER = MORE TPs" : "LOWER = MORE TPs";
    console.log(`  ${a.name}  (mono=${a.monotonic.toFixed(2)})  → ${dir}`);
    console.log(`    decile boundaries: ${a.bins.map((b) => b.hi.toFixed(2)).join(" ")}`);
    console.log(`    TP rates:          ${a.bins.map((b) => (b.rate * 100).toFixed(0) + "%").join(" ")}`);
  }

  // Build a simple linear score using top 3
  const scoreFeats = top.map((a) => {
    const idx = FEATURES.findIndex(([n]) => n === a.name);
    return { idx, sign: a.monotonic > 0 ? 1 : -1 };
  });
  function score(r: Row): number {
    let s = 0;
    for (const sf of scoreFeats) s += sf.sign * r.f[sf.idx];
    return s;
  }

  // Evaluate score on TEST set: skip bottom decile by score, see TP rate change
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`OUT-OF-SAMPLE TEST — skip bottom-N% by score, measure resulting WR`);
  console.log(`${"".padEnd(110, "═")}`);
  const testScored = test.map((r) => ({ r, s: score(r) })).sort((a, b) => a.s - b.s);
  const baselineTP = test.filter((r) => r.result === "TP").length;
  const baselineWR = baselineTP / test.length;
  console.log(`  baseline (no skip):     ${test.length}t  ${baselineTP}TP  WR=${(baselineWR*100).toFixed(1)}%`);
  for (const skipPct of [0.05, 0.10, 0.15, 0.20, 0.30]) {
    const skipN = Math.floor(test.length * skipPct);
    const kept = testScored.slice(skipN);
    const tps = kept.filter((x) => x.r.result === "TP").length;
    const wr = tps / kept.length;
    const skipped = testScored.slice(0, skipN);
    const skipTPs = skipped.filter((x) => x.r.result === "TP").length;
    const skipWR = skipTPs / skipped.length;
    const lift = (wr - baselineWR) * 100;
    console.log(`  skip bottom ${(skipPct*100).toFixed(0).padStart(2)}%:        ${kept.length}t  ${tps}TP  WR=${(wr*100).toFixed(1)}%   skipped: ${skipN}t  ${skipTPs}TP  WR=${(skipWR*100).toFixed(1)}%   lift=${lift >= 0 ? "+" : ""}${lift.toFixed(2)}pp`);
  }

  // Hour-of-day breakdown (simple, often informative)
  console.log(`\nHOUR-OF-DAY breakdown (UTC):`);
  const hourIdx = FEATURES.findIndex(([n]) => n === "hour_utc");
  for (let h = 0; h < 24; h++) {
    const slice = rows.filter((r) => Math.floor(r.f[hourIdx]) === h);
    if (slice.length === 0) continue;
    const tps = slice.filter((r) => r.result === "TP").length;
    const wr = tps / slice.length;
    const bar = "█".repeat(Math.round(wr * 30));
    console.log(`  ${h.toString().padStart(2)}h  n=${slice.length.toString().padStart(3)}  WR=${(wr*100).toFixed(0).padStart(2)}%  ${bar}`);
  }

  // Bars-to-exit analysis
  console.log(`\nBARS-TO-EXIT distribution:`);
  const tpExit = trades.filter((t) => t.result === "TP").map((t) => t.barsToExit);
  const slExit = trades.filter((t) => t.result === "SL").map((t) => t.barsToExit);
  const meanArr = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const medArr = (xs: number[]) => xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  console.log(`  TPs: median=${medArr(tpExit)}  mean=${meanArr(tpExit).toFixed(1)}  bars`);
  console.log(`  SLs: median=${medArr(slExit)}  mean=${meanArr(slExit).toFixed(1)}  bars`);
}

main().catch((e) => { console.error(e); process.exit(1); });

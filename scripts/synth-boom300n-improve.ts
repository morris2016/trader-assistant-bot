// BOOM 300N spike-fade improvement search.
// Run validated detector across full Deriv history, capture features per
// signal, find bar-level patterns distinguishing TP from SL. Then OOS test
// the candidate filters and pick the one that actually lifts net P&L.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const STAKE = 3;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.2;
const TP_FRAC_OF_SPIKE = 0.5;
const ATR_PERIOD = 14;

const SYM = "BOOM300N";
const GR = 60;

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
  const pdi = (plusDM / tr) * 100;
  const ndi = (minusDM / tr) * 100;
  return Math.abs(pdi - ndi) / (pdi + ndi || 1) * 100;
}
function eff(c: Candle[], i: number, w: number): number {
  if (i < w) return 0;
  const net = Math.abs(c[i].close - c[i - w].close);
  let sum = 0;
  for (let j = i - w + 1; j <= i; j++) sum += Math.abs(c[j].close - c[j - 1].close);
  return sum > 0 ? net / sum : 0;
}

type Trade = {
  idx: number;
  result: "TP" | "SL";
  pnl: number;
  // Features
  spike_size_atr: number;     // spike bar range / ATR
  confirm_strength: number;   // (spike.close - confirm.close) / ATR (how far below spike close confirm closed)
  confirm_body_pct: number;   // confirm bar body / range
  bars_since_high: number;    // bars since prior 30-bar high before spike
  dist_sma50_atr: number;
  dist_sma200_atr: number;
  adx14: number;
  eff60: number;
  hour: number;
  prior_5bar_uprun: number;   // # of consecutive bull bars immediately before spike
  spike_upper_wick_pct: number; // upper wick / range on spike bar
  prior_atr_avg: number;      // prev 30-bar mean ATR
  atr_ratio: number;          // current ATR / prior 30-bar mean ATR
};

function detectAndAnalyze(candles: Candle[]): Trade[] {
  const out: Trade[] = [];
  for (let i = ATR_PERIOD + 30 + 1; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    if (!(spike.close > spike.open)) continue;
    if (!(confirm.close < spike.close)) continue;

    // Resolve outcome
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = confirm.close - confirm.close * ENTRY_SPREAD_FRAC;
    const stop = spike.high + BUFFER_ATR * a;
    const target = confirm.close - TP_FRAC_OF_SPIKE * range;
    if (target <= 0 || stop <= confirm.close) continue;
    const delta = finalE - confirm.close;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null;
    let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    let netRaw = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (netRaw < -STAKE) netRaw = -STAKE;

    // Compute features
    let priorHi = -Infinity, barsSinceHi = 30;
    for (let m = i - 30; m < i - 1; m++) if (candles[m].high > priorHi) { priorHi = candles[m].high; barsSinceHi = i - 1 - m; }
    const priorAtrSum = (() => { let s = 0, n = 0; for (let m = i - 30; m < i; m++) { const aa = atr(candles, m, 14); if (aa > 0) { s += aa; n++; } } return n > 0 ? s / n : 0; })();
    let priorRun = 0;
    for (let m = i - 2; m >= i - 6; m--) {
      if (candles[m].close > candles[m].open) priorRun++; else break;
    }
    const spikeRange = spike.high - spike.low;
    const upperWick = spike.high - Math.max(spike.open, spike.close);
    out.push({
      idx: i,
      result: exit,
      pnl: Math.round(netRaw * 100) / 100,
      spike_size_atr: spikeRange / a,
      confirm_strength: (spike.close - confirm.close) / a,
      confirm_body_pct: (confirm.high - confirm.low) > 0 ? Math.abs(confirm.close - confirm.open) / (confirm.high - confirm.low) : 0,
      bars_since_high: barsSinceHi,
      dist_sma50_atr: a > 0 ? (confirm.close - sma(candles, i, 50)) / a : 0,
      dist_sma200_atr: a > 0 ? (confirm.close - sma(candles, i, 200)) / a : 0,
      adx14: adx(candles, i, 14),
      eff60: eff(candles, i, 60),
      hour: new Date(confirm.epoch * 1000).getUTCHours(),
      prior_5bar_uprun: priorRun,
      spike_upper_wick_pct: spikeRange > 0 ? upperWick / spikeRange : 0,
      prior_atr_avg: priorAtrSum,
      atr_ratio: priorAtrSum > 0 ? a / priorAtrSum : 1,
    });
  }
  return out;
}

const FEATURES: Array<keyof Trade> = [
  "spike_size_atr", "confirm_strength", "confirm_body_pct", "bars_since_high",
  "dist_sma50_atr", "dist_sma200_atr", "adx14", "eff60", "hour",
  "prior_5bar_uprun", "spike_upper_wick_pct", "atr_ratio",
];

function decileAnalysis(trades: Trade[], feat: keyof Trade): { name: string; bins: { rate: number; net: number; n: number }[]; mono: number } {
  const sorted = [...trades].sort((a, b) => (a[feat] as number) - (b[feat] as number));
  const N = sorted.length;
  const sz = Math.floor(N / 10);
  const bins: { rate: number; net: number; n: number }[] = [];
  for (let d = 0; d < 10; d++) {
    const start = d * sz, end = d === 9 ? N : start + sz;
    const slice = sorted.slice(start, end);
    const tps = slice.filter((t) => t.result === "TP").length;
    const net = slice.reduce((s, t) => s + t.pnl, 0);
    bins.push({ rate: slice.length > 0 ? tps / slice.length : 0, net, n: slice.length });
  }
  let mean = 0; for (const b of bins) mean += b.rate; mean /= 10;
  let sxy = 0, sxx = 0, syy = 0;
  for (let d = 0; d < 10; d++) {
    sxy += (d - 4.5) * (bins[d].rate - mean);
    sxx += (d - 4.5) ** 2;
    syy += (bins[d].rate - mean) ** 2;
  }
  const mono = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 0;
  return { name: feat as string, bins, mono };
}

async function main() {
  console.log(`BOOM 300N spike-fade improvement search\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  console.log(`Fetching ${need} bars of BOOM300N 1m...`);
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`  ${candles.length} bars (${(candles.length * GR / 86400).toFixed(1)} days)\n`);

  const allTrades = detectAndAnalyze(candles).filter((t) => candles[t.idx].epoch >= JAN_1_2025);
  console.log(`${allTrades.length} resolved trades`);
  const tps = allTrades.filter((t) => t.result === "TP").length;
  const totalNet = allTrades.reduce((s, t) => s + t.pnl, 0);
  console.log(`Baseline: ${tps}TP/${allTrades.length - tps}SL = ${(tps/allTrades.length*100).toFixed(1)}% WR  net=${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(2)}  (per-trade ${totalNet >= 0 ? "+" : ""}$${(totalNet/allTrades.length).toFixed(3)})\n`);

  // 70/30 chronological split
  const splitIdx = Math.floor(allTrades.length * 0.7);
  const train = allTrades.slice(0, splitIdx);
  const test = allTrades.slice(splitIdx);
  console.log(`Train: ${train.length} · Test: ${test.length}\n`);

  // Decile analysis on train, sorted by monotonicity
  console.log(`${"".padEnd(120, "═")}`);
  console.log(`PER-FEATURE DECILE ANALYSIS (TRAIN) — TP rate AND net $ per decile`);
  console.log(`${"".padEnd(120, "═")}`);
  const analyses = FEATURES.map((f) => decileAnalysis(train, f));
  analyses.sort((a, b) => Math.abs(b.mono) - Math.abs(a.mono));
  for (const a of analyses) {
    const ratesStr = a.bins.map((b) => `${(b.rate * 100).toFixed(0).padStart(2)}%`).join(" ");
    const netsStr = a.bins.map((b) => `${b.net >= 0 ? "+" : ""}$${b.net.toFixed(0).padStart(3)}`).join(" ");
    const dir = a.mono > 0 ? "↑" : a.mono < 0 ? "↓" : "·";
    console.log(`  ${a.name.padEnd(22)} mono=${a.mono.toFixed(2).padStart(5)} ${dir}  WR: ${ratesStr}`);
    console.log(`  ${" ".padEnd(22)}              net: ${netsStr}`);
  }

  // For each feature, find threshold that maximizes train net by skipping bottom-N% (or top-N% if mono<0)
  console.log(`\n${"".padEnd(120, "═")}`);
  console.log(`OOS TEST — apply each candidate filter to TEST set, see if net actually lifts`);
  console.log(`${"".padEnd(120, "═")}`);
  const trainNet = train.reduce((s, t) => s + t.pnl, 0);
  const testNet = test.reduce((s, t) => s + t.pnl, 0);
  console.log(`  baseline TRAIN: ${trainNet >= 0 ? "+" : ""}$${trainNet.toFixed(2)}  TEST: ${testNet >= 0 ? "+" : ""}$${testNet.toFixed(2)}`);

  // Test top features one by one
  for (const a of analyses.slice(0, 6)) {
    const sortedTrain = [...train].sort((x, y) => (x[a.name as keyof Trade] as number) - (y[a.name as keyof Trade] as number));
    // Test threshold = 10th, 20th, 30th percentile (skip bottom or top depending on direction)
    for (const pct of [0.10, 0.20, 0.30]) {
      let thr: number;
      if (a.mono > 0) {
        // higher = better → skip bottom pct → threshold is value at index pct*N
        thr = sortedTrain[Math.floor(sortedTrain.length * pct)][a.name as keyof Trade] as number;
      } else {
        // lower = better → skip top pct → threshold is value at index (1-pct)*N
        thr = sortedTrain[Math.floor(sortedTrain.length * (1 - pct))][a.name as keyof Trade] as number;
      }
      const keep = test.filter((t) => {
        const v = t[a.name as keyof Trade] as number;
        return a.mono > 0 ? v >= thr : v <= thr;
      });
      const skipped = test.filter((t) => {
        const v = t[a.name as keyof Trade] as number;
        return a.mono > 0 ? v < thr : v > thr;
      });
      const keepNet = keep.reduce((s, t) => s + t.pnl, 0);
      const keepWR = keep.length > 0 ? keep.filter((t) => t.result === "TP").length / keep.length : 0;
      const skipNet = skipped.reduce((s, t) => s + t.pnl, 0);
      const skipWR = skipped.length > 0 ? skipped.filter((t) => t.result === "TP").length / skipped.length : 0;
      const lift = keepNet - testNet;
      console.log(`  ${a.name.padEnd(22)} ${a.mono > 0 ? "≥" : "≤"} ${thr.toFixed(2).padStart(7)}  (skip ${(pct*100).toFixed(0)}%)  kept ${keep.length}t WR=${(keepWR*100).toFixed(1)}% net=${keepNet >= 0 ? "+" : ""}$${keepNet.toFixed(2)}  skip ${skipped.length}t WR=${(skipWR*100).toFixed(1)}% net=${skipNet >= 0 ? "+" : ""}$${skipNet.toFixed(2)}  lift=${lift >= 0 ? "+" : ""}$${lift.toFixed(2)}`);
    }
  }

  // Hour-of-day
  console.log(`\nHOUR-OF-DAY (full data):`);
  for (let h = 0; h < 24; h++) {
    const slice = allTrades.filter((t) => t.hour === h);
    if (slice.length === 0) continue;
    const w = slice.filter((t) => t.result === "TP").length;
    const wr = w / slice.length;
    const net = slice.reduce((s, t) => s + t.pnl, 0);
    const epd = net / slice.length;
    const flag = epd < -0.05 ? " 🔴 BAD" : epd > 0.05 ? " 🟢 GOOD" : "";
    console.log(`  ${h.toString().padStart(2)}h  n=${slice.length.toString().padStart(3)}  WR=${(wr*100).toFixed(0).padStart(2)}%  net=${net >= 0 ? "+" : ""}$${net.toFixed(2).padStart(7)}  epd=${epd >= 0 ? "+" : ""}$${epd.toFixed(3)}${flag}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

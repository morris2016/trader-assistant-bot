// Shared HF screen harness — loaded by every bucket script.
//
// Each bucket file registers ≤10 strategies and calls runBucket(). The lib
// handles cache loading, indicator computation, exit sim (trail-arm + 4h
// timeout), per-asset metrics, and JSON output that downstream Stage-2 CV
// can consume.
//
// Strategy contract: function takes a BarContext (current 15m bar +
// pre-computed indicators + asset name + 1h-aligned context) and returns
// { side } | null. Lib calls it once per (asset, 15m bar) across the
// screen window, then simulates each fired signal.
//
// Window default: most recent 12 months from today. Override via SCREEN_START
// / SCREEN_END env (YYYY-MM-DD).

import * as fs from "fs";
import * as path from "path";

export const ASSETS = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","AVAXUSDT","LDOUSDT","ADAUSDT","LINKUSDT","UNIUSDT","AAVEUSDT","DOTUSDT","BCHUSDT","POLUSDT"];
export const CACHE_DIR = "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop/kline-cache";
export const RESULTS_DIR = "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop/scripts/hf-screen/results";

// Sizing — matches the live HF stack at the time of writing.
export const STAKE = +(process.env.STAKE ?? "20");
export const LEV = +(process.env.LEV ?? "75");
export const COST_RT = 0.000836;  // taker fee both sides + ~1bp slippage each
export const TRAIL_ARM_ATR = 1.0;
export const TRAIL_RETRACE_ATR = 0.3;
export const HARD_TIMEOUT_MIN = 240;
// Hard SL at 1×ATR adverse from entry.
export const HARD_SL_ATR = 1.0;
// Exit mode: "trail" = trail-arm + hard SL (original); "fixedRR" = fixed TP/SL.
// FixedRR uses TP_ATR / SL_ATR multipliers (default 2 / 1 = 2:1 RR, breakeven
// WR 33%). Set via EXIT env: EXIT=fixedRR or EXIT=trail.
export const EXIT_MODE: "trail" | "fixedRR" = (process.env.EXIT === "fixedRR" ? "fixedRR" : "trail");
export const TP_ATR = +(process.env.TP_ATR ?? "2.0");
export const SL_ATR = +(process.env.SL_ATR ?? "1.0");

export type Bar = {
  epoch: number; open: number; high: number; low: number; close: number;
  volume: number; quoteVolume: number; trades: number; takerBuyVolume: number; takerBuyQuote: number;
};

export function load1m(sym: string, fromEpoch?: number, toEpoch?: number): Bar[] {
  const all: Bar[] = [];
  const prefix = `ticks-${sym}-1m-`;
  for (const f of fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(prefix) && f.endsWith(".json"))) {
    try {
      const partial = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
      for (const b of partial) {
        const ep = +b.epoch;
        if (fromEpoch !== undefined && ep < fromEpoch) continue;
        if (toEpoch !== undefined && ep > toEpoch) continue;
        all.push({
          epoch: ep, open: +b.open, high: +b.high, low: +b.low, close: +b.close,
          volume: +(b.volume ?? 0), quoteVolume: +(b.quoteVolume ?? 0),
          trades: +(b.trades ?? 0), takerBuyVolume: +(b.takerBuyVolume ?? 0), takerBuyQuote: +(b.takerBuyQuote ?? 0),
        });
      }
    } catch {}
  }
  const map = new Map<number, Bar>(); for (const b of all) map.set(b.epoch, b);
  return Array.from(map.values()).sort((a, b) => a.epoch - b.epoch);
}

export function roll(bars1m: Bar[], tfSec: number): Bar[] {
  const out: Bar[] = []; let bucket: Bar[] = []; let be = -1;
  const push = () => {
    if (!bucket.length) return;
    out.push({
      epoch: be, open: bucket[0].open, close: bucket[bucket.length - 1].close,
      high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)),
      volume: bucket.reduce((s, x) => s + x.volume, 0),
      quoteVolume: bucket.reduce((s, x) => s + x.quoteVolume, 0),
      trades: bucket.reduce((s, x) => s + x.trades, 0),
      takerBuyVolume: bucket.reduce((s, x) => s + x.takerBuyVolume, 0),
      takerBuyQuote: bucket.reduce((s, x) => s + x.takerBuyQuote, 0),
    });
  };
  for (const b of bars1m) {
    const e = Math.floor(b.epoch / tfSec) * tfSec;
    if (be === -1) be = e;
    if (e !== be) { push(); bucket = []; be = e; }
    bucket.push(b);
  }
  push();
  return out;
}

export function sma(values: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += values[j];
  return s / n;
}
export function ema(values: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  const k = 2 / (n + 1);
  let e = values[i - n + 1];
  for (let j = i - n + 2; j <= i; j++) e = values[j] * k + e * (1 - k);
  return e;
}
export function stdev(values: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  let sum = 0, sq = 0;
  for (let j = i - n + 1; j <= i; j++) { sum += values[j]; sq += values[j] * values[j]; }
  const m = sum / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}
export function atr(bars: Bar[], n: number, i: number): number {
  if (i < n) return NaN;
  let s = 0;
  for (let j = i - n + 1; j <= i; j++) {
    s += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
  }
  return s / n;
}
export function rsi(closes: number[], n: number, i: number): number {
  if (i < n) return NaN;
  let gain = 0, loss = 0;
  for (let j = i - n + 1; j <= i; j++) {
    const ch = closes[j] - closes[j - 1];
    if (ch >= 0) gain += ch; else loss += -ch;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}
export function bb(closes: number[], n: number, k: number, i: number): { mid: number; upper: number; lower: number } | null {
  if (i < n - 1) return null;
  const mid = sma(closes, n, i);
  const sd = stdev(closes, n, i);
  return { mid, upper: mid + k * sd, lower: mid - k * sd };
}
export function percentileRank(values: number[], n: number, i: number, current: number): number {
  if (i < n - 1) return 0.5;
  let below = 0, total = 0;
  for (let j = i - n + 1; j <= i; j++) { if (values[j] <= current) below++; total++; }
  return below / total;
}

// Find 1h bar index aligned with 15m bar epoch.
export function alignTo1h(bars1h: Bar[], epoch15m: number): number {
  const e1h = Math.floor(epoch15m / 3600) * 3600;
  // Binary search since bars1h is sorted
  let lo = 0, hi = bars1h.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars1h[mid].epoch === e1h) { found = mid; break; }
    if (bars1h[mid].epoch < e1h) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// Build a 1m epoch → index map for fast exit-sim entry lookup.
export function buildMinuteIdx(bars1m: Bar[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < bars1m.length; i++) m.set(bars1m[i].epoch, i);
  return m;
}

export type Side = "LONG" | "SHORT";
export type SignalOut = { side: Side } | null;

export type BarContext = {
  asset: string;
  bars15m: Bar[]; i: number;        // 15m bar index (just closed)
  bars1h: Bar[]; i1h: number;       // aligned 1h index (-1 if not available)
  closes15m: number[];              // closes for quick access
  // Pre-computed indicators at i:
  bbObj: { mid: number; upper: number; lower: number } | null;
  bbWidth: number;                  // (upper - lower) / mid
  bbWidthPct: number;               // percentile rank over 60 bars
  atr14: number;
  atrPct: number;                   // percentile rank of atr14 over 60 bars
  rsi14: number;
  ema20: number; ema50: number;
  ema50_1h: number;                 // 1h EMA50
  volSma20: number;
  volPct: number;                   // percentile rank of vol over 60 bars
  hourUtc: number;
  dow: number;                      // 0-6
  // Pre-computed series (length = bars15m.length, NaN before warmup)
  series: {
    rsi: Float64Array;
    macdHist: Float64Array;
    obv: Float64Array;
    cvd: Float64Array;
    mfi: Float64Array;
    atr14: Float64Array;
    ema20: Float64Array;
    ema50: Float64Array;
    bbWidth: Float64Array;
  };
};

export type Strategy = { id: string; name: string; fn: (ctx: BarContext) => SignalOut };

export type StrategyResult = {
  id: string; name: string;
  trades: number; wins: number; losses: number;
  winRate: number;
  netDollars: number;
  avgWin: number; avgLoss: number; expR: number;
  perAsset: Record<string, { n: number; w: number; net: number }>;
  // For Stage-2 reuse, store trades compactly
  tradesData: Array<{ asset: string; ts: number; side: Side; entry: number; exit: number; pnl: number; armed: boolean; reason: "trail" | "timeout" | "sl" }>;
};

function simulateExit(bars1m: Bar[], minMap: Map<number, number>, entryEpoch: number, entry: number, atrVal: number, side: Side): { exitEpoch: number; exit: number; armed: boolean; reason: "trail" | "timeout" | "sl" } {
  const startIdx = minMap.get(entryEpoch);
  if (startIdx === undefined) {
    // fallback: find first 1m bar >= entryEpoch via linear scan from end
    let s = 0;
    for (let i = 0; i < bars1m.length; i++) if (bars1m[i].epoch >= entryEpoch) { s = i; break; }
    return doSim(bars1m, s, entry, atrVal, side);
  }
  return doSim(bars1m, startIdx, entry, atrVal, side);
}
function doSim(bars1m: Bar[], startIdx: number, entry: number, atrVal: number, side: Side) {
  const slDist = (EXIT_MODE === "fixedRR" ? SL_ATR : HARD_SL_ATR) * atrVal;
  const tpDist = TP_ATR * atrVal;
  const armDist = TRAIL_ARM_ATR * atrVal;
  const trailDist = TRAIL_RETRACE_ATR * atrVal;
  const slPrice = side === "LONG" ? entry - slDist : entry + slDist;
  const tpPrice = side === "LONG" ? entry + tpDist : entry - tpDist;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPrice) return { exitEpoch: b.epoch, exit: slPrice, armed, reason: "sl" as const };
      if (EXIT_MODE === "fixedRR") {
        if (b.high >= tpPrice) return { exitEpoch: b.epoch, exit: tpPrice, armed: true, reason: "trail" as const };
      } else {
        if (b.high > peak) peak = b.high;
        if (!armed && peak >= entry + armDist) armed = true;
        if (armed && b.low <= peak - trailDist) return { exitEpoch: b.epoch, exit: peak - trailDist, armed: true, reason: "trail" as const };
      }
    } else {
      if (b.high >= slPrice) return { exitEpoch: b.epoch, exit: slPrice, armed, reason: "sl" as const };
      if (EXIT_MODE === "fixedRR") {
        if (b.low <= tpPrice) return { exitEpoch: b.epoch, exit: tpPrice, armed: true, reason: "trail" as const };
      } else {
        if (b.low < peak) peak = b.low;
        if (!armed && peak <= entry - armDist) armed = true;
        if (armed && b.high >= peak + trailDist) return { exitEpoch: b.epoch, exit: peak + trailDist, armed: true, reason: "trail" as const };
      }
    }
  }
  return { exitEpoch: bars1m[maxIdx].epoch, exit: bars1m[maxIdx].close, armed, reason: "timeout" as const };
}

export function defaultWindow(): { fromEpoch: number; toEpoch: number; label: string } {
  // Most recent 12 months — anchor on the latest 15m bar epoch typical of cache.
  const now = Date.now();
  const toEpoch = Math.floor(now / 1000);
  const fromEpoch = toEpoch - 365 * 86400;
  const env = (k: string) => process.env[k];
  if (env("SCREEN_START") && env("SCREEN_END")) {
    const f = Math.floor(new Date(env("SCREEN_START")!).getTime() / 1000);
    const t = Math.floor(new Date(env("SCREEN_END")!).getTime() / 1000);
    return { fromEpoch: f, toEpoch: t, label: `${env("SCREEN_START")} → ${env("SCREEN_END")}` };
  }
  return { fromEpoch, toEpoch, label: `last 12mo` };
}

export async function runBucket(bucketId: string, strategies: Strategy[]): Promise<void> {
  const { fromEpoch, toEpoch, label } = defaultWindow();
  console.log(`\n══ ${bucketId} — ${strategies.length} strategies — window: ${label} ══`);
  console.log(`Sizing: $${STAKE} × ${LEV}× | cost RT ${(COST_RT*100).toFixed(4)}% | trail arm ${TRAIL_ARM_ATR}×ATR retrace ${TRAIL_RETRACE_ATR}×ATR | timeout ${HARD_TIMEOUT_MIN}m\n`);

  // Initialize per-strategy results
  const results: Record<string, StrategyResult> = {};
  for (const s of strategies) results[s.id] = {
    id: s.id, name: s.name, trades: 0, wins: 0, losses: 0, winRate: 0,
    netDollars: 0, avgWin: 0, avgLoss: 0, expR: 0,
    perAsset: {}, tradesData: [],
  };

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} loading…`);
    const t0 = Date.now();
    // load a bit earlier than fromEpoch to warm up indicators (need ~200 15m bars = ~3000 min)
    const bars1m = load1m(sym, fromEpoch - 30 * 86400, toEpoch);
    if (bars1m.length === 0) { console.log(` no data`); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const vols15m = bars15m.map(b => b.volume);
    const closes1h = bars1h.map(b => b.close);
    process.stdout.write(` scanning ${bars15m.length} 15m bars…`);

    // Pre-compute per-bar indicators once
    const bbObjArr: ({ mid: number; upper: number; lower: number } | null)[] = new Array(bars15m.length);
    const bbWidthArr = new Float64Array(bars15m.length);
    const atrArr = new Float64Array(bars15m.length);
    const rsiArr = new Float64Array(bars15m.length);
    const ema20Arr = new Float64Array(bars15m.length);
    const ema50Arr = new Float64Array(bars15m.length);
    const volSmaArr = new Float64Array(bars15m.length);
    for (let i = 0; i < bars15m.length; i++) {
      const b = bb(closes15m, 20, 2.0, i);
      bbObjArr[i] = b;
      bbWidthArr[i] = b ? (b.upper - b.lower) / b.mid : NaN;
      atrArr[i] = atr(bars15m, 14, i);
      rsiArr[i] = rsi(closes15m, 14, i);
      ema20Arr[i] = ema(closes15m, 20, i);
      ema50Arr[i] = ema(closes15m, 50, i);
      volSmaArr[i] = sma(vols15m, 20, i);
    }
    const ema50_1hArr = new Float64Array(bars1h.length);
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = ema(closes1h, 50, i);

    // Extra series for divergence/structural strategies — pre-compute once
    const seriesRsi = new Float64Array(bars15m.length);
    const seriesMacdHist = new Float64Array(bars15m.length);
    const seriesObv = new Float64Array(bars15m.length);
    const seriesCvd = new Float64Array(bars15m.length);
    const seriesMfi = new Float64Array(bars15m.length);
    for (let i = 0; i < bars15m.length; i++) seriesRsi[i] = rsi(closes15m, 14, i);
    // MACD hist (12, 26, 9-SMA signal)
    const macdRaw = new Float64Array(bars15m.length);
    for (let i = 0; i < bars15m.length; i++) {
      const e12 = ema(closes15m, 12, i); const e26 = ema(closes15m, 26, i);
      macdRaw[i] = (isFinite(e12) && isFinite(e26)) ? e12 - e26 : NaN;
    }
    for (let i = 0; i < bars15m.length; i++) {
      if (i < 35) { seriesMacdHist[i] = NaN; continue; }
      let s = 0, n = 0;
      for (let j = i - 8; j <= i; j++) if (isFinite(macdRaw[j])) { s += macdRaw[j]; n++; }
      const sig = n ? s / n : 0;
      seriesMacdHist[i] = macdRaw[i] - sig;
    }
    // OBV
    seriesObv[0] = 0;
    for (let i = 1; i < bars15m.length; i++) {
      const ch = bars15m[i].close - bars15m[i - 1].close;
      seriesObv[i] = seriesObv[i - 1] + (ch > 0 ? bars15m[i].volume : ch < 0 ? -bars15m[i].volume : 0);
    }
    // CVD
    seriesCvd[0] = 0;
    for (let i = 1; i < bars15m.length; i++) {
      const tb = bars15m[i].takerBuyVolume; const v = bars15m[i].volume;
      seriesCvd[i] = seriesCvd[i - 1] + (2 * tb - v);
    }
    // MFI(14)
    for (let i = 0; i < bars15m.length; i++) {
      if (i < 14) { seriesMfi[i] = NaN; continue; }
      let pos = 0, neg = 0;
      for (let k = i - 13; k <= i; k++) {
        const tp = (bars15m[k].high + bars15m[k].low + bars15m[k].close) / 3;
        const tpPrev = (bars15m[k - 1].high + bars15m[k - 1].low + bars15m[k - 1].close) / 3;
        const mf = tp * bars15m[k].volume;
        if (tp > tpPrev) pos += mf; else if (tp < tpPrev) neg += mf;
      }
      seriesMfi[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
    }
    const sharedSeries = {
      rsi: seriesRsi, macdHist: seriesMacdHist, obv: seriesObv, cvd: seriesCvd, mfi: seriesMfi,
      atr14: atrArr, ema20: ema20Arr, ema50: ema50Arr, bbWidth: bbWidthArr,
    };

    let signalsFired = 0;
    for (let i = 60; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < fromEpoch) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 0) continue;

      // bbWidth percentile over 60 bars
      const bbWdSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) if (isFinite(bbWidthArr[j])) bbWdSlice.push(bbWidthArr[j]);
      const bbWdPct = bbWdSlice.length ? (bbWdSlice.filter(x => x <= bbWidthArr[i]).length / bbWdSlice.length) : 0.5;

      // atr percentile
      const atrSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) if (isFinite(atrArr[j])) atrSlice.push(atrArr[j]);
      const atrPctVal = atrSlice.length ? (atrSlice.filter(x => x <= atrArr[i]).length / atrSlice.length) : 0.5;

      // vol percentile
      const volSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) volSlice.push(vols15m[j]);
      const volPctVal = volSlice.length ? (volSlice.filter(x => x <= vols15m[i]).length / volSlice.length) : 0.5;

      const d = new Date(b.epoch * 1000);
      const ctx: BarContext = {
        asset: sym,
        bars15m, i, bars1h, i1h, closes15m,
        bbObj: bbObjArr[i],
        bbWidth: bbWidthArr[i], bbWidthPct: bbWdPct,
        atr14: atrArr[i], atrPct: atrPctVal,
        rsi14: rsiArr[i],
        ema20: ema20Arr[i], ema50: ema50Arr[i],
        ema50_1h: ema50_1hArr[i1h],
        volSma20: volSmaArr[i], volPct: volPctVal,
        hourUtc: d.getUTCHours(), dow: d.getUTCDay(),
        series: sharedSeries,
      };

      for (const strat of strategies) {
        const sig = strat.fn(ctx);
        if (!sig) continue;
        signalsFired++;
        // Entry at next bar open (more honest than current close)
        const nextBar = bars15m[i + 1];
        if (!nextBar) continue;
        const entryPrice = nextBar.open;
        const exit = simulateExit(bars1m, minMap, nextBar.epoch, entryPrice, atrArr[i], sig.side);
        const grossPct = sig.side === "LONG" ? (exit.exit - entryPrice) / entryPrice : (entryPrice - exit.exit) / entryPrice;
        const netPct = grossPct - COST_RT;
        const pnl = STAKE * LEV * netPct;
        const r = results[strat.id];
        r.trades++;
        if (pnl > 0) r.wins++; else r.losses++;
        r.netDollars += pnl;
        if (!r.perAsset[sym]) r.perAsset[sym] = { n: 0, w: 0, net: 0 };
        r.perAsset[sym].n++;
        if (pnl > 0) r.perAsset[sym].w++;
        r.perAsset[sym].net += pnl;
        r.tradesData.push({ asset: sym, ts: nextBar.epoch, side: sig.side, entry: entryPrice, exit: exit.exit, pnl, armed: exit.armed, reason: exit.reason });
      }
    }
    console.log(` done in ${((Date.now() - t0) / 1000).toFixed(1)}s — signals=${signalsFired}`);
  }

  // Finalize metrics
  for (const s of strategies) {
    const r = results[s.id];
    r.winRate = r.trades ? r.wins / r.trades : 0;
    const wins = r.tradesData.filter(t => t.pnl > 0);
    const losses = r.tradesData.filter(t => t.pnl <= 0);
    r.avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    r.avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    r.expR = r.avgLoss !== 0 ? Math.abs(r.avgWin / r.avgLoss) * r.winRate - (1 - r.winRate) : 0;
  }

  // Summary table
  console.log(`\n── ${bucketId} RESULTS ──`);
  console.log(`${"id".padEnd(12)} ${"trades".padStart(6)} ${"WR%".padStart(6)} ${"net$".padStart(10)} ${"avgW".padStart(7)} ${"avgL".padStart(7)} ${"expR".padStart(6)}  name`);
  const ranked = strategies.map(s => results[s.id]).sort((a, b) => b.netDollars - a.netDollars);
  for (const r of ranked) {
    console.log(`${r.id.padEnd(12)} ${String(r.trades).padStart(6)} ${(r.winRate * 100).toFixed(1).padStart(6)} ${r.netDollars.toFixed(2).padStart(10)} ${r.avgWin.toFixed(2).padStart(7)} ${r.avgLoss.toFixed(2).padStart(7)} ${r.expR.toFixed(2).padStart(6)}  ${r.name}`);
  }

  // Stage-1 keep criteria — must have actual edge (positive net + positive expR)
  console.log(`\n── Stage-1 survivors (net > 0 AND expR ≥ 0.05 AND trades ≥ 30) ──`);
  const survivors = ranked.filter(r => r.trades >= 30 && r.netDollars > 0 && r.expR >= 0.05);
  for (const r of survivors) console.log(`  ✓ ${r.id}  ${r.name}`);
  if (!survivors.length) console.log(`  (none — bucket killed)`);

  // Save full result
  const out = { bucketId, label, window: { fromEpoch, toEpoch }, sizing: { STAKE, LEV, COST_RT }, results: ranked, survivors: survivors.map(s => s.id) };
  const outFile = path.join(RESULTS_DIR, `${bucketId}.json`);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outFile}`);
}

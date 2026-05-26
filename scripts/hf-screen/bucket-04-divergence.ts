// Bucket 4 — Divergence family (uses lib.series pre-computed indicators).
//
// Run: npx tsx scripts/hf-screen/bucket-04-divergence.ts

import { Strategy, BarContext, runBucket } from "./lib";

// Pivot detector: is bar (i - PIV_WINDOW) the lowest low in window i-2*PIV_WINDOW..i
const PIV_WINDOW = 3;

function isPivotLow(c: BarContext, atIdx: number): boolean {
  const low = c.bars15m[atIdx].low;
  for (let k = atIdx - PIV_WINDOW; k <= atIdx + PIV_WINDOW; k++) {
    if (k === atIdx || k < 0 || k >= c.bars15m.length) continue;
    if (c.bars15m[k].low < low) return false;
  }
  return true;
}
function isPivotHigh(c: BarContext, atIdx: number): boolean {
  const high = c.bars15m[atIdx].high;
  for (let k = atIdx - PIV_WINDOW; k <= atIdx + PIV_WINDOW; k++) {
    if (k === atIdx || k < 0 || k >= c.bars15m.length) continue;
    if (c.bars15m[k].high > high) return false;
  }
  return true;
}

// Find prior pivot low / high in the past `lookback` bars before `before` (exclusive of pivot zone).
function findPriorPivotLow(c: BarContext, before: number, lookback: number): number {
  for (let j = before - PIV_WINDOW * 2; j >= before - lookback; j--) {
    if (isPivotLow(c, j)) return j;
  }
  return -1;
}
function findPriorPivotHigh(c: BarContext, before: number, lookback: number): number {
  for (let j = before - PIV_WINDOW * 2; j >= before - lookback; j--) {
    if (isPivotHigh(c, j)) return j;
  }
  return -1;
}

// Generic bull-div check at pivot low at index `pivIdx` against an indicator series
function bullDiv(c: BarContext, pivIdx: number, indicator: Float64Array, lookback: number): boolean {
  const priorIdx = findPriorPivotLow(c, pivIdx, lookback);
  if (priorIdx < 0) return false;
  return c.bars15m[pivIdx].low < c.bars15m[priorIdx].low && indicator[pivIdx] > indicator[priorIdx];
}
function bearDiv(c: BarContext, pivIdx: number, indicator: Float64Array, lookback: number): boolean {
  const priorIdx = findPriorPivotHigh(c, pivIdx, lookback);
  if (priorIdx < 0) return false;
  return c.bars15m[pivIdx].high > c.bars15m[priorIdx].high && indicator[pivIdx] < indicator[priorIdx];
}

const LB = 40;  // lookback for prior pivot

// Strategies fire when a pivot is confirmed at (i - PIV_WINDOW). Entry on bar i (the
// confirming bar at +PIV_WINDOW after the pivot). That's a 45-min lag on 15m,
// realistic since pivots can only be confirmed retroactively.
const strategies: Strategy[] = [
  {
    id: "B4-01",
    name: "MACD-Hist bull-div at confirmed pivot low",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (!isPivotLow(c, piv)) return null;
      if (!isFinite(c.series.macdHist[piv])) return null;
      return bullDiv(c, piv, c.series.macdHist, LB) ? { side: "LONG" } : null;
    },
  },
  {
    id: "B4-02",
    name: "MACD-Hist bear-div at confirmed pivot high",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (!isPivotHigh(c, piv)) return null;
      if (!isFinite(c.series.macdHist[piv])) return null;
      return bearDiv(c, piv, c.series.macdHist, LB) ? { side: "SHORT" } : null;
    },
  },
  {
    id: "B4-03",
    name: "RSI(14) bull-div + EMA50 slope agrees",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (!isPivotLow(c, piv)) return null;
      if (!bullDiv(c, piv, c.series.rsi, LB)) return null;
      const ema50Now = c.series.ema50[c.i];
      const ema50Prev = c.series.ema50[c.i - 5];
      if (!isFinite(ema50Now) || !isFinite(ema50Prev)) return null;
      if (ema50Now <= ema50Prev) return null;
      return { side: "LONG" };
    },
  },
  {
    id: "B4-04",
    name: "RSI(14) bear-div + EMA50 slope agrees",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (!isPivotHigh(c, piv)) return null;
      if (!bearDiv(c, piv, c.series.rsi, LB)) return null;
      const ema50Now = c.series.ema50[c.i];
      const ema50Prev = c.series.ema50[c.i - 5];
      if (!isFinite(ema50Now) || !isFinite(ema50Prev)) return null;
      if (ema50Now >= ema50Prev) return null;
      return { side: "SHORT" };
    },
  },
  {
    id: "B4-05",
    name: "MACD-hist div + RSI extreme (composite)",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      const rsiAt = c.series.rsi[piv];
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.macdHist, LB) && rsiAt < 35) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.macdHist, LB) && rsiAt > 65) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B4-06",
    name: "OBV divergence",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.obv, LB)) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.obv, LB)) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B4-07",
    name: "CVD (taker-buy delta) divergence",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.cvd, LB)) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.cvd, LB)) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B4-08",
    name: "MFI(14) divergence",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.mfi, LB)) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.mfi, LB)) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B4-09",
    name: "Triple divergence — price + RSI + MACD-hist all agree",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      const piv = c.i - PIV_WINDOW;
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.rsi, LB) && bullDiv(c, piv, c.series.macdHist, LB)) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.rsi, LB) && bearDiv(c, piv, c.series.macdHist, LB)) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B4-10",
    name: "MACD-hist div + 1h trend agrees",
    fn: (c) => {
      if (c.i < LB + PIV_WINDOW) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const htfBull = c.bars1h[c.i1h].close > c.ema50_1h;
      const piv = c.i - PIV_WINDOW;
      if (isPivotLow(c, piv) && bullDiv(c, piv, c.series.macdHist, LB) && htfBull) return { side: "LONG" };
      if (isPivotHigh(c, piv) && bearDiv(c, piv, c.series.macdHist, LB) && !htfBull) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-04-divergence", strategies).catch(e => { console.error(e); process.exit(1); });

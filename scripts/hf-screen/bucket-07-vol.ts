// Bucket 7 — Volatility-regime trades.
// Hypothesis: edge depends on the volatility state, not the direction.
// Same entry trigger fires differently in low-vol vs high-vol regimes.
//
// Run: npx tsx scripts/hf-screen/bucket-07-vol.ts

import { Strategy, BarContext, runBucket } from "./lib";

function priorHighLow(c: BarContext, n: number): { hh: number; ll: number } {
  let hh = -Infinity, ll = Infinity;
  for (let j = c.i - n; j < c.i; j++) {
    if (c.bars15m[j].high > hh) hh = c.bars15m[j].high;
    if (c.bars15m[j].low < ll) ll = c.bars15m[j].low;
  }
  return { hh, ll };
}

const strategies: Strategy[] = [
  {
    id: "B7-01",
    name: "Low-vol breakout — ATR pct < 20, Donchian-20 break",
    fn: (c) => {
      if (c.atrPct > 0.20 || c.i < 21) return null;
      const { hh, ll } = priorHighLow(c, 20);
      const b = c.bars15m[c.i];
      if (b.close > hh) return { side: "LONG" };
      if (b.close < ll) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B7-02",
    name: "High-vol fade — ATR pct > 80, fade extreme bar (revert)",
    fn: (c) => {
      if (c.atrPct < 0.80) return null;
      const b = c.bars15m[c.i];
      const body = b.close - b.open;
      const range = b.high - b.low;
      if (range === 0) return null;
      // Strong directional bar (body > 60% of range) → fade
      if (body > 0 && body / range > 0.6) return { side: "SHORT" };
      if (body < 0 && -body / range > 0.6) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B7-03",
    name: "bbWidth percentile < 15 → break direction (squeeze fire)",
    fn: (c) => {
      if (c.bbWidthPct > 0.15 || !c.bbObj) return null;
      const b = c.bars15m[c.i];
      const prev = c.bars15m[c.i - 1];
      if (b.close > c.bbObj.upper && prev.close <= c.bbObj.upper) return { side: "LONG" };
      if (b.close < c.bbObj.lower && prev.close >= c.bbObj.lower) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B7-04",
    name: "bbWidth percentile > 85 → fade extreme",
    fn: (c) => {
      if (c.bbWidthPct < 0.85 || !c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B7-05",
    name: "Choppiness Index < 38 (trending) → momentum",
    fn: (c) => {
      if (c.i < 16) return null;
      // CI = 100*log10(sum(TR,14)/(maxH14-minL14))/log10(14)
      let sumTR = 0;
      let mxH = -Infinity, mnL = Infinity;
      for (let j = c.i - 13; j <= c.i; j++) {
        sumTR += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
        if (c.bars15m[j].high > mxH) mxH = c.bars15m[j].high;
        if (c.bars15m[j].low < mnL) mnL = c.bars15m[j].low;
      }
      if (mxH - mnL <= 0) return null;
      const ci = 100 * Math.log10(sumTR / (mxH - mnL)) / Math.log10(14);
      if (ci > 38) return null;
      // Trend direction via EMA20 slope
      const ema20Prev = c.series.ema20[c.i - 5];
      if (!isFinite(c.ema20) || !isFinite(ema20Prev)) return null;
      if (c.ema20 > ema20Prev && c.bars15m[c.i].close > c.ema20) return { side: "LONG" };
      if (c.ema20 < ema20Prev && c.bars15m[c.i].close < c.ema20) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B7-06",
    name: "Choppiness Index > 62 (choppy) → mean-revert at BB band",
    fn: (c) => {
      if (c.i < 16 || !c.bbObj) return null;
      let sumTR = 0;
      let mxH = -Infinity, mnL = Infinity;
      for (let j = c.i - 13; j <= c.i; j++) {
        sumTR += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
        if (c.bars15m[j].high > mxH) mxH = c.bars15m[j].high;
        if (c.bars15m[j].low < mnL) mnL = c.bars15m[j].low;
      }
      if (mxH - mnL <= 0) return null;
      const ci = 100 * Math.log10(sumTR / (mxH - mnL)) / Math.log10(14);
      if (ci < 62) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B7-07",
    name: "Williams VixFix > 30 (panic) → contrarian LONG",
    fn: (c) => {
      if (c.i < 23) return null;
      // VixFix = (highest(close,22) - low) / highest(close,22) * 100
      let mx = -Infinity;
      for (let j = c.i - 21; j <= c.i; j++) if (c.bars15m[j].close > mx) mx = c.bars15m[j].close;
      const vf = (mx - c.bars15m[c.i].low) / mx * 100;
      if (vf < 3.0) return null;  // 3% panic threshold
      const b = c.bars15m[c.i];
      if (b.close > b.open) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B7-08",
    name: "ATR-expansion momentum — ATR(7) > 1.5 × ATR(7, prior 7) → trend follow",
    fn: (c) => {
      if (c.i < 16) return null;
      let atrShort = 0, atrPrior = 0;
      for (let j = c.i - 6; j <= c.i; j++) {
        atrShort += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
      }
      for (let j = c.i - 13; j <= c.i - 7; j++) {
        atrPrior += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
      }
      if (atrShort < 1.5 * atrPrior) return null;
      const b = c.bars15m[c.i];
      if (b.close > b.open && b.close > c.ema20) return { side: "LONG" };
      if (b.close < b.open && b.close < c.ema20) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B7-09",
    name: "ATR contraction breakout — current ATR < 0.7× ATR-20, then break of range",
    fn: (c) => {
      if (c.i < 21) return null;
      let atrLong = 0;
      for (let j = c.i - 19; j <= c.i; j++) {
        atrLong += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
      }
      atrLong /= 20;
      if (c.atr14 > 0.7 * atrLong) return null;
      const { hh, ll } = priorHighLow(c, 10);
      const b = c.bars15m[c.i];
      if (b.close > hh) return { side: "LONG" };
      if (b.close < ll) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B7-10",
    name: "Vol-of-vol regime shift — rolling stdev of returns jumps 2× → fade momentum",
    fn: (c) => {
      if (c.i < 24) return null;
      // Compute realized vol over last 10 bars vs 10-20 bars ago
      let v1 = 0, v2 = 0;
      for (let j = c.i - 9; j <= c.i; j++) {
        const r = c.bars15m[j].close / c.bars15m[j - 1].close - 1;
        v1 += r * r;
      }
      for (let j = c.i - 19; j <= c.i - 10; j++) {
        const r = c.bars15m[j].close / c.bars15m[j - 1].close - 1;
        v2 += r * r;
      }
      if (v1 < 2 * v2) return null;
      // Recent move just spiked → fade direction of last 3 bars
      const dir = c.bars15m[c.i].close > c.bars15m[c.i - 3].close ? "up" : "down";
      if (dir === "up") return { side: "SHORT" };
      return { side: "LONG" };
    },
  },
];

runBucket("bucket-07-vol", strategies).catch(e => { console.error(e); process.exit(1); });

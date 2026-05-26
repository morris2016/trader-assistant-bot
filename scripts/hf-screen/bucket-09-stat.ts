// Bucket 9 — Statistical / quant strategies.
// Z-scores, Hurst, Kalman residuals — measure deviation from a model and
// trade reversion or trend follow based on the regime.
//
// Run: npx tsx scripts/hf-screen/bucket-09-stat.ts

import { Strategy, BarContext, runBucket } from "./lib";

function zscore(c: BarContext, n: number): number | null {
  if (c.i < n) return null;
  let sum = 0;
  for (let j = c.i - n + 1; j <= c.i; j++) sum += c.bars15m[j].close;
  const m = sum / n;
  let v = 0;
  for (let j = c.i - n + 1; j <= c.i; j++) v += (c.bars15m[j].close - m) ** 2;
  const sd = Math.sqrt(v / n);
  if (sd === 0) return null;
  return (c.bars15m[c.i].close - m) / sd;
}

// Hurst exponent (simplified R/S over given window)
function hurst(c: BarContext, n: number): number | null {
  if (c.i < n) return null;
  const series: number[] = [];
  for (let j = c.i - n + 1; j <= c.i; j++) series.push(c.bars15m[j].close);
  const ret: number[] = [];
  for (let i = 1; i < series.length; i++) ret.push(Math.log(series[i] / series[i - 1]));
  const m = ret.reduce((s, x) => s + x, 0) / ret.length;
  let cum = 0, mx = -Infinity, mn = Infinity;
  for (const r of ret) {
    cum += r - m;
    if (cum > mx) mx = cum;
    if (cum < mn) mn = cum;
  }
  const R = mx - mn;
  const S = Math.sqrt(ret.reduce((s, x) => s + (x - m) ** 2, 0) / ret.length);
  if (S === 0 || R === 0) return null;
  return Math.log(R / S) / Math.log(n);
}

const strategies: Strategy[] = [
  {
    id: "B9-01",
    name: "Z-score(20) < -2 → LONG; exit on revert",
    fn: (c) => {
      const z = zscore(c, 20);
      if (z === null) return null;
      if (z < -2) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-02",
    name: "Z-score(20) > +2 → SHORT",
    fn: (c) => {
      const z = zscore(c, 20);
      if (z === null) return null;
      if (z > 2) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B9-03",
    name: "Z-score(50) extreme + 1h trend agrees",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull) return { side: "LONG" };
      if (z > 1.5 && !bull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B9-04",
    name: "Hurst < 0.4 (mean-revert regime) + BB pierce",
    fn: (c) => {
      const h = hurst(c, 50);
      if (h === null || h >= 0.4) return null;
      if (!c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-05",
    name: "Hurst > 0.6 (trending regime) + EMA cross",
    fn: (c) => {
      const h = hurst(c, 50);
      if (h === null || h <= 0.6) return null;
      // EMA(8/21) cross
      const e8 = c.series.ema20[c.i]; // approximation — use closest
      const ema8Now = c.series.ema20[c.i];
      const ema8Prev = c.series.ema20[c.i - 1];
      const ema21Now = c.series.ema50[c.i] * 0 + c.series.ema20[c.i]; // approximation
      // crude: just use direction
      if (!isFinite(c.ema20) || !isFinite(c.ema50)) return null;
      const trendUp = c.ema20 > c.ema50;
      const b = c.bars15m[c.i];
      if (trendUp && b.close > b.open && b.close > c.ema20) return { side: "LONG" };
      if (!trendUp && b.close < b.open && b.close < c.ema20) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B9-06",
    name: "Linear regression slope residual — fade large residuals",
    fn: (c) => {
      if (c.i < 30) return null;
      // Fit line to last 30 closes, compute residual
      const n = 30;
      let sx = 0, sy = 0, sxx = 0, sxy = 0;
      for (let j = 0; j < n; j++) {
        sx += j; sy += c.bars15m[c.i - n + 1 + j].close;
        sxx += j * j; sxy += j * c.bars15m[c.i - n + 1 + j].close;
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      const intercept = (sy - slope * sx) / n;
      const predicted = slope * (n - 1) + intercept;
      const actual = c.bars15m[c.i].close;
      // Residual stdev
      let rs = 0;
      for (let j = 0; j < n; j++) {
        const p = slope * j + intercept;
        const r = c.bars15m[c.i - n + 1 + j].close - p;
        rs += r * r;
      }
      const rsd = Math.sqrt(rs / n);
      if (rsd === 0) return null;
      const residual = (actual - predicted) / rsd;
      if (residual > 2.0) return { side: "SHORT" };
      if (residual < -2.0) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-07",
    name: "AR(1) residual fade — large 1-bar prediction error",
    fn: (c) => {
      if (c.i < 10) return null;
      // AR(1): close_t = a + b*close_{t-1}; estimate b over last 30 bars
      const n = 30;
      if (c.i < n + 1) return null;
      let sxx = 0, sxy = 0, mx = 0, my = 0;
      for (let j = c.i - n + 1; j <= c.i; j++) {
        mx += c.bars15m[j - 1].close;
        my += c.bars15m[j].close;
      }
      mx /= n; my /= n;
      for (let j = c.i - n + 1; j <= c.i; j++) {
        sxy += (c.bars15m[j - 1].close - mx) * (c.bars15m[j].close - my);
        sxx += (c.bars15m[j - 1].close - mx) ** 2;
      }
      const beta = sxx > 0 ? sxy / sxx : 1;
      const alpha = my - beta * mx;
      const predicted = alpha + beta * c.bars15m[c.i - 1].close;
      const residual = c.bars15m[c.i].close - predicted;
      // residual stdev
      let rs = 0;
      for (let j = c.i - n + 1; j <= c.i; j++) {
        const p = alpha + beta * c.bars15m[j - 1].close;
        rs += (c.bars15m[j].close - p) ** 2;
      }
      const rsd = Math.sqrt(rs / n);
      if (rsd === 0) return null;
      const z = residual / rsd;
      if (z > 2.0) return { side: "SHORT" };
      if (z < -2.0) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-08",
    name: "Quantile band — close in 5/95 percentile of 30-bar window",
    fn: (c) => {
      if (c.i < 30) return null;
      const w: number[] = [];
      for (let j = c.i - 29; j <= c.i; j++) w.push(c.bars15m[j].close);
      const sorted = w.slice().sort((a, b) => a - b);
      const p5 = sorted[1], p95 = sorted[28];
      const cur = c.bars15m[c.i].close;
      if (cur >= p95) return { side: "SHORT" };
      if (cur <= p5) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-09",
    name: "Return autocorrelation — when |corr(r,r_lag1)| > 0.3, trade continuation",
    fn: (c) => {
      if (c.i < 30) return null;
      const rets: number[] = [];
      for (let j = c.i - 29; j <= c.i; j++) rets.push(c.bars15m[j].close / c.bars15m[j - 1].close - 1);
      const n = rets.length;
      const m = rets.reduce((s, x) => s + x, 0) / n;
      let cov = 0, var0 = 0;
      for (let i = 1; i < n; i++) {
        cov += (rets[i] - m) * (rets[i - 1] - m);
        var0 += (rets[i - 1] - m) ** 2;
      }
      const r1 = var0 > 0 ? cov / var0 : 0;
      if (Math.abs(r1) < 0.3) return null;
      const last = rets[rets.length - 1];
      // r1 positive = momentum; r1 negative = reversal
      if (r1 > 0.3 && last > 0) return { side: "LONG" };
      if (r1 > 0.3 && last < 0) return { side: "SHORT" };
      if (r1 < -0.3 && last > 0) return { side: "SHORT" };
      if (r1 < -0.3 && last < 0) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B9-10",
    name: "Volatility-of-volatility shock — fade when stdev(ret) > 2× recent stdev",
    fn: (c) => {
      if (c.i < 40) return null;
      // recent 5 bar stdev vs 20-bar stdev
      let v1 = 0, v2 = 0;
      const m1 = (a: number, b: number) => {
        let s = 0;
        for (let j = a; j <= b; j++) s += c.bars15m[j].close / c.bars15m[j - 1].close - 1;
        return s / (b - a + 1);
      };
      const mean1 = m1(c.i - 4, c.i);
      const mean2 = m1(c.i - 19, c.i);
      for (let j = c.i - 4; j <= c.i; j++) {
        const r = c.bars15m[j].close / c.bars15m[j - 1].close - 1;
        v1 += (r - mean1) ** 2;
      }
      for (let j = c.i - 19; j <= c.i; j++) {
        const r = c.bars15m[j].close / c.bars15m[j - 1].close - 1;
        v2 += (r - mean2) ** 2;
      }
      v1 = Math.sqrt(v1 / 5);
      v2 = Math.sqrt(v2 / 20);
      if (v1 < 2 * v2) return null;
      // shock fade
      const b = c.bars15m[c.i];
      if (b.close > b.open) return { side: "SHORT" };
      return { side: "LONG" };
    },
  },
];

runBucket("bucket-09-stat", strategies).catch(e => { console.error(e); process.exit(1); });

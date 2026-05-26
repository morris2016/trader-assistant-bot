// Bucket 10 — Composite / ensemble strategies.
// Hypothesis: stacking the best near-miss filters from buckets 1-9 should
// push WR above the ~60% needed for breakeven under current cost/exit.
// Two confirmed near-misses to combine: B7-09 (ATR contraction + Donchian)
// and B9-03 (Z-score(50) extreme + 1h trend).
//
// Run: npx tsx scripts/hf-screen/bucket-10-composite.ts

import { Strategy, BarContext, runBucket } from "./lib";

function priorHighLow(c: BarContext, n: number): { hh: number; ll: number } {
  let hh = -Infinity, ll = Infinity;
  for (let j = c.i - n; j < c.i; j++) {
    if (c.bars15m[j].high > hh) hh = c.bars15m[j].high;
    if (c.bars15m[j].low < ll) ll = c.bars15m[j].low;
  }
  return { hh, ll };
}
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

const strategies: Strategy[] = [
  {
    id: "B10-01",
    name: "B9-03 + ATR percentile > 60 (concentrated extreme + expansion regime)",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (c.atrPct < 0.60) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull) return { side: "LONG" };
      if (z > 1.5 && !bull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-02",
    name: "B9-03 + hour ∈ {12..22 UTC}",
    fn: (c) => {
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
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
    id: "B10-03",
    name: "B9-03 + RSI extreme alignment",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h) || !isFinite(c.rsi14)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull && c.rsi14 < 35) return { side: "LONG" };
      if (z > 1.5 && !bull && c.rsi14 > 65) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-04",
    name: "B7-09 + 1h trend (ATR contraction + Donchian + HTF agrees)",
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
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (b.close > hh && bull) return { side: "LONG" };
      if (b.close < ll && !bull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-05",
    name: "Triple stack: Z(50) + ATR contraction + 1h trend",
    fn: (c) => {
      if (c.i < 21) return null;
      const z = zscore(c, 50);
      if (z === null) return null;
      let atrLong = 0;
      for (let j = c.i - 19; j <= c.i; j++) {
        atrLong += Math.max(c.bars15m[j].high - c.bars15m[j].low,
          Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
          Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
      }
      atrLong /= 20;
      if (c.atr14 > 0.7 * atrLong) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull) return { side: "LONG" };
      if (z > 1.5 && !bull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-06",
    name: "Score-based: 4+ of {Z-extreme, RSI-extreme, bbWidth<30, vol>70, hour, HTF}",
    fn: (c) => {
      if (!isFinite(c.ema50_1h) || !isFinite(c.rsi14)) return null;
      const z = zscore(c, 50);
      if (z === null) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      // LONG candidate
      let scoreL = 0;
      if (z < -1.5) scoreL++;
      if (c.rsi14 < 35) scoreL++;
      if (c.bbWidthPct < 0.30) scoreL++;
      if (c.volPct > 0.70) scoreL++;
      if (c.hourUtc >= 12 && c.hourUtc <= 22) scoreL++;
      if (bull) scoreL++;
      if (scoreL >= 4) return { side: "LONG" };
      // SHORT candidate
      let scoreS = 0;
      if (z > 1.5) scoreS++;
      if (c.rsi14 > 65) scoreS++;
      if (c.bbWidthPct < 0.30) scoreS++;
      if (c.volPct > 0.70) scoreS++;
      if (c.hourUtc >= 12 && c.hourUtc <= 22) scoreS++;
      if (!bull) scoreS++;
      if (scoreS >= 4) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-07",
    name: "Z(50) extreme + 1h trend + RSI extreme + hour (4-stack)",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h) || !isFinite(c.rsi14)) return null;
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull && c.rsi14 < 35) return { side: "LONG" };
      if (z > 1.5 && !bull && c.rsi14 > 65) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-08",
    name: "B9-03 + skip if prior bar made 20-bar extreme (no falling knife)",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      const prev = c.bars15m[c.i - 1];
      // skip continuation
      let extreme = false;
      if (z < -1.5) {
        let minL = prev.low;
        for (let j = c.i - 20; j < c.i - 1; j++) if (c.bars15m[j].low < minL) minL = c.bars15m[j].low;
        if (prev.low <= minL) extreme = true;
      } else if (z > 1.5) {
        let maxH = prev.high;
        for (let j = c.i - 20; j < c.i - 1; j++) if (c.bars15m[j].high > maxH) maxH = c.bars15m[j].high;
        if (prev.high >= maxH) extreme = true;
      }
      if (extreme) return null;
      if (z < -1.5 && bull) return { side: "LONG" };
      if (z > 1.5 && !bull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-09",
    name: "Z(50) + 1h trend + confirmation candle direction",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      const b = c.bars15m[c.i];
      if (z < -1.5 && bull && b.close > b.open) return { side: "LONG" };
      if (z > 1.5 && !bull && b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B10-10",
    name: "Z(50) + 1h trend + ATR>median + confirmation candle (4-stack)",
    fn: (c) => {
      const z = zscore(c, 50);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      if (c.atrPct < 0.50) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      const b = c.bars15m[c.i];
      if (z < -1.5 && bull && b.close > b.open) return { side: "LONG" };
      if (z > 1.5 && !bull && b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-10-composite", strategies).catch(e => { console.error(e); process.exit(1); });

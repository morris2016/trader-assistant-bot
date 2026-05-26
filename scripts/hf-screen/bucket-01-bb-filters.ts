// Bucket 1 — Fix BB with regime / structural filters.
// Hypothesis: BB tag alone is a coinflip; layering one regime filter at a
// time tells us which factor actually adds edge. Strategies all detect the
// same BB pierce, then gate on a single discriminator.
//
// Run: npx tsx scripts/hf-screen/bucket-01-bb-filters.ts

import { Strategy, BarContext, runBucket } from "./lib";

// Helper: detect the underlying BB pierce. Returns the candidate side or null.
function bbPierce(c: BarContext): "LONG" | "SHORT" | null {
  if (!c.bbObj) return null;
  const b = c.bars15m[c.i];
  if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return "SHORT";
  if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return "LONG";
  return null;
}

const strategies: Strategy[] = [
  {
    id: "B1-01",
    name: "BB pierce + RSI extreme (LONG<30, SHORT>70) + EMA50 slope agrees",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (!isFinite(c.rsi14) || !isFinite(c.ema50)) return null;
      const ema50Prev = c.bars15m[c.i - 5] ? c.bars15m[c.i - 5].close : NaN;
      const slopeUp = isFinite(ema50Prev) ? c.ema50 > ema50Prev : false;
      if (side === "LONG" && c.rsi14 < 30 && slopeUp) return { side };
      if (side === "SHORT" && c.rsi14 > 70 && !slopeUp) return { side };
      return null;
    },
  },
  {
    id: "B1-02",
    name: "BB pierce + bbWidth percentile < 30 (squeeze setup)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (c.bbWidthPct > 0.30) return null;
      return { side };
    },
  },
  {
    id: "B1-03",
    name: "BB pierce + volume percentile > 70 (climax / capitulation)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (c.volPct < 0.70) return null;
      return { side };
    },
  },
  {
    id: "B1-04",
    name: "BB pierce + 1h close vs EMA50 trend agrees (LONG above, SHORT below)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const htfClose = c.bars1h[c.i1h].close;
      const bull = htfClose > c.ema50_1h;
      if (side === "LONG" && bull) return { side };
      if (side === "SHORT" && !bull) return { side };
      return null;
    },
  },
  {
    id: "B1-05",
    name: "BB pierce + rejection candle (lower/upper wick > 2× body)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      const b = c.bars15m[c.i];
      const body = Math.abs(b.close - b.open);
      if (body === 0) return null;
      const upperWick = b.high - Math.max(b.open, b.close);
      const lowerWick = Math.min(b.open, b.close) - b.low;
      if (side === "LONG" && lowerWick > 2 * body) return { side };
      if (side === "SHORT" && upperWick > 2 * body) return { side };
      return null;
    },
  },
  {
    id: "B1-06",
    name: "BB pierce + skip if prior bar made 20-bar extreme (no falling knife)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      // Look at the previous bar — if it set a new 20-bar low (for LONG) /
      // high (for SHORT), this is continuation, not reversal.
      const prev = c.bars15m[c.i - 1];
      let extremes = false;
      if (side === "LONG") {
        let minLow = prev.low;
        for (let j = c.i - 20; j < c.i - 1; j++) if (c.bars15m[j].low < minLow) { minLow = c.bars15m[j].low; }
        if (prev.low <= minLow) extremes = true;
      } else {
        let maxHigh = prev.high;
        for (let j = c.i - 20; j < c.i - 1; j++) if (c.bars15m[j].high > maxHigh) { maxHigh = c.bars15m[j].high; }
        if (prev.high >= maxHigh) extremes = true;
      }
      if (extremes) return null;
      return { side };
    },
  },
  {
    id: "B1-07",
    name: "BB pierce + confirmation candle (LONG: close > open; SHORT: close < open)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      const b = c.bars15m[c.i];
      if (side === "LONG" && b.close <= b.open) return null;
      if (side === "SHORT" && b.close >= b.open) return null;
      return { side };
    },
  },
  {
    id: "B1-08",
    name: "BB pierce + hour ∈ {12..22 UTC} (validated session window)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      return { side };
    },
  },
  {
    id: "B1-09",
    name: "BB pierce + ATR percentile in mid-range (0.3..0.7) — skip vol extremes",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (c.atrPct < 0.30 || c.atrPct > 0.70) return null;
      return { side };
    },
  },
  {
    id: "B1-10",
    name: "BB pierce + multi-filter (RSI extreme AND bbWidth low AND hour OK)",
    fn: (c) => {
      const side = bbPierce(c);
      if (!side) return null;
      if (!isFinite(c.rsi14)) return null;
      const rsiOk = (side === "LONG" && c.rsi14 < 35) || (side === "SHORT" && c.rsi14 > 65);
      if (!rsiOk) return null;
      if (c.bbWidthPct > 0.50) return null;
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      return { side };
    },
  },
];

runBucket("bucket-01-bb-filters", strategies).catch(e => { console.error(e); process.exit(1); });

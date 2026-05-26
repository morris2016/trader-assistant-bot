// Bucket 2 — Breakout from compression.
// Hypothesis: when volatility contracts (narrow range, low bbWidth, low ATR),
// energy builds. Trading the directional break of the contraction range
// captures expansion moves. This is the OPPOSITE direction of mean-reversion.
//
// Run: npx tsx scripts/hf-screen/bucket-02-compression.ts

import { Strategy, BarContext, runBucket } from "./lib";

// Helper: NR(N) — is bar i the narrowest range over the last N bars?
function isNarrowestRange(c: BarContext, n: number): boolean {
  const cur = c.bars15m[c.i].high - c.bars15m[c.i].low;
  for (let j = c.i - n + 1; j < c.i; j++) {
    if (c.bars15m[j].high - c.bars15m[j].low <= cur) return false;
  }
  return true;
}

// Helper: highest high / lowest low over previous N bars (excluding current).
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
    id: "B2-01",
    name: "NR4 break — narrowest 4-bar range, breakout direction trade",
    fn: (c) => {
      if (c.i < 5) return null;
      // NR4 trigger on prior bar (i-1), current bar (i) breaks the i-1 range
      const prev = c.bars15m[c.i - 1];
      const prevRange = prev.high - prev.low;
      let isNR4 = true;
      for (let j = c.i - 4; j < c.i - 1; j++) {
        if (c.bars15m[j].high - c.bars15m[j].low <= prevRange) { isNR4 = false; break; }
      }
      if (!isNR4) return null;
      const b = c.bars15m[c.i];
      if (b.close > prev.high) return { side: "LONG" };
      if (b.close < prev.low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-02",
    name: "NR7 break — narrowest 7-bar range + volume > 1.5× SMA",
    fn: (c) => {
      if (c.i < 8) return null;
      const prev = c.bars15m[c.i - 1];
      const prevRange = prev.high - prev.low;
      let isNR7 = true;
      for (let j = c.i - 7; j < c.i - 1; j++) {
        if (c.bars15m[j].high - c.bars15m[j].low <= prevRange) { isNR7 = false; break; }
      }
      if (!isNR7) return null;
      const b = c.bars15m[c.i];
      if (c.volSma20 <= 0 || b.volume < 1.5 * c.volSma20) return null;
      if (b.close > prev.high) return { side: "LONG" };
      if (b.close < prev.low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-03",
    name: "Donchian-20 break — close beyond prior 20-bar high/low",
    fn: (c) => {
      if (c.i < 21) return null;
      const { hh, ll } = priorHighLow(c, 20);
      const b = c.bars15m[c.i];
      if (b.close > hh) return { side: "LONG" };
      if (b.close < ll) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-04",
    name: "Donchian-20 break + ATR percentile > 60 (expansion regime)",
    fn: (c) => {
      if (c.i < 21) return null;
      if (c.atrPct < 0.60) return null;
      const { hh, ll } = priorHighLow(c, 20);
      const b = c.bars15m[c.i];
      if (b.close > hh) return { side: "LONG" };
      if (b.close < ll) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-05",
    name: "bbWidth pct < 20 then break of BB band (squeeze release)",
    fn: (c) => {
      if (!c.bbObj || c.i < 21) return null;
      // Need the PREVIOUS bbWidth to have been compressed
      const prev = c.bars15m[c.i - 1];
      const b = c.bars15m[c.i];
      // Compute prior bbWidthPct
      let priorBbWds: number[] = [];
      for (let j = c.i - 60; j < c.i - 1; j++) {
        // approximate — we don't have history of bbWidth here, but bbWidthPct
        // at i represents the same metric. Use the percentile drop check.
      }
      // Heuristic: current bbWidthPct ≤ 0.2 = still in squeeze; require break of band
      if (c.bbWidthPct > 0.20) return null;
      if (b.close > c.bbObj.upper && prev.close <= c.bbObj.upper) return { side: "LONG" };
      if (b.close < c.bbObj.lower && prev.close >= c.bbObj.lower) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-06",
    name: "Inside bar break — current bar breaks mother (i-1) high/low",
    fn: (c) => {
      if (c.i < 2) return null;
      const mother = c.bars15m[c.i - 2];
      const inside = c.bars15m[c.i - 1];
      // inside bar: inside.high <= mother.high && inside.low >= mother.low
      if (inside.high > mother.high || inside.low < mother.low) return null;
      const b = c.bars15m[c.i];
      if (b.close > mother.high) return { side: "LONG" };
      if (b.close < mother.low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-07",
    name: "3-bar TR contraction then expansion bar",
    fn: (c) => {
      if (c.i < 5) return null;
      const tr = (j: number) => Math.max(c.bars15m[j].high - c.bars15m[j].low,
        Math.abs(c.bars15m[j].high - c.bars15m[j - 1].close),
        Math.abs(c.bars15m[j].low - c.bars15m[j - 1].close));
      const t1 = tr(c.i - 3), t2 = tr(c.i - 2), t3 = tr(c.i - 1);
      if (!(t1 > t2 && t2 > t3)) return null;
      const curTR = tr(c.i);
      if (curTR < 1.5 * t3) return null;  // expansion required
      const b = c.bars15m[c.i];
      if (b.close > b.open) return { side: "LONG" };
      if (b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-08",
    name: "Range expansion bar (TR > 2× ATR-14) in EMA50 direction",
    fn: (c) => {
      if (!isFinite(c.atr14) || c.atr14 <= 0) return null;
      const b = c.bars15m[c.i];
      const tr = Math.max(b.high - b.low, Math.abs(b.high - c.bars15m[c.i - 1].close), Math.abs(b.low - c.bars15m[c.i - 1].close));
      if (tr < 2 * c.atr14) return null;
      if (!isFinite(c.ema50)) return null;
      if (b.close > c.ema50 && b.close > b.open) return { side: "LONG" };
      if (b.close < c.ema50 && b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-09",
    name: "Bollinger %B break — close > upper after 3 bars inside (band-ride start)",
    fn: (c) => {
      if (!c.bbObj || c.i < 4) return null;
      const b = c.bars15m[c.i];
      // Prior 3 bars inside the bands
      for (let j = c.i - 3; j < c.i; j++) {
        const bbj = c.bbObj; // current; approximation, fine for screening
        if (c.bars15m[j].close > bbj.upper || c.bars15m[j].close < bbj.lower) return null;
      }
      if (b.close > c.bbObj.upper) return { side: "LONG" };
      if (b.close < c.bbObj.lower) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B2-10",
    name: "Asia-range break — 00-08 UTC range broken between 08-12 UTC",
    fn: (c) => {
      if (c.hourUtc < 8 || c.hourUtc > 12) return null;
      // Compute Asia 0-8 UTC range from same calendar day
      const day = Math.floor(c.bars15m[c.i].epoch / 86400);
      let hi = -Infinity, lo = Infinity, found = false;
      for (let j = c.i; j >= Math.max(0, c.i - 48); j--) {
        const dj = Math.floor(c.bars15m[j].epoch / 86400);
        if (dj !== day) break;
        const hr = new Date(c.bars15m[j].epoch * 1000).getUTCHours();
        if (hr < 8) {
          if (c.bars15m[j].high > hi) hi = c.bars15m[j].high;
          if (c.bars15m[j].low < lo) lo = c.bars15m[j].low;
          found = true;
        }
      }
      if (!found || hi === -Infinity || lo === Infinity) return null;
      const b = c.bars15m[c.i];
      if (b.close > hi) return { side: "LONG" };
      if (b.close < lo) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-02-compression", strategies).catch(e => { console.error(e); process.exit(1); });

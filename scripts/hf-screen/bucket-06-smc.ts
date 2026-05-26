// Bucket 6 — SMC / structural on 15m.
// Hypothesis: liquidity-sweep + order-block + FVG patterns target specific
// market microstructure events. They're naturally selective (rare) and the
// SMC family has proven edge on 1h — try the same patterns on 15m.
//
// Run: npx tsx scripts/hf-screen/bucket-06-smc.ts

import { Strategy, BarContext, runBucket } from "./lib";

// Order block detection: bar with body > X×ATR and a strong follow-through
function detectOB(c: BarContext, atIdx: number, side: "BULL" | "BEAR"): boolean {
  if (atIdx < 1) return false;
  const b = c.bars15m[atIdx];
  const next = c.bars15m[atIdx + 1];
  if (!next) return false;
  const body = Math.abs(b.close - b.open);
  if (!isFinite(c.series.atr14[atIdx]) || body < 1.5 * c.series.atr14[atIdx]) return false;
  if (side === "BULL") return b.close > b.open && next.close > b.high;  // bullish OB
  return b.close < b.open && next.close < b.low;  // bearish OB
}

// FVG detection (3-bar gap)
function detectFVG(c: BarContext, atIdx: number, side: "BULL" | "BEAR"): { top: number; bot: number } | null {
  if (atIdx < 2) return null;
  const b0 = c.bars15m[atIdx - 2];
  const b2 = c.bars15m[atIdx];
  if (side === "BULL" && b0.high < b2.low) return { top: b2.low, bot: b0.high };
  if (side === "BEAR" && b0.low > b2.high) return { top: b0.low, bot: b2.high };
  return null;
}

// Recent N-bar high/low
function nHigh(c: BarContext, n: number): number {
  let h = -Infinity; for (let j = c.i - n; j < c.i; j++) if (c.bars15m[j].high > h) h = c.bars15m[j].high;
  return h;
}
function nLow(c: BarContext, n: number): number {
  let l = Infinity; for (let j = c.i - n; j < c.i; j++) if (c.bars15m[j].low < l) l = c.bars15m[j].low;
  return l;
}

const strategies: Strategy[] = [
  {
    id: "B6-01",
    name: "15m bullish OB test — recent bull OB tested from above (wick into OB then reclaim)",
    fn: (c) => {
      if (c.i < 10) return null;
      // Look back 3-10 bars for a bullish OB
      for (let j = c.i - 10; j <= c.i - 3; j++) {
        if (!detectOB(c, j, "BULL")) continue;
        const ob = c.bars15m[j];
        const b = c.bars15m[c.i];
        if (b.low <= ob.high && b.close > ob.high) return { side: "LONG" };
      }
      return null;
    },
  },
  {
    id: "B6-02",
    name: "15m bearish OB test — recent bear OB tested from below (wick into OB then reject)",
    fn: (c) => {
      if (c.i < 10) return null;
      for (let j = c.i - 10; j <= c.i - 3; j++) {
        if (!detectOB(c, j, "BEAR")) continue;
        const ob = c.bars15m[j];
        const b = c.bars15m[c.i];
        if (b.high >= ob.low && b.close < ob.low) return { side: "SHORT" };
      }
      return null;
    },
  },
  {
    id: "B6-03",
    name: "FVG 50% fill — bull FVG, price returns to 50% of gap and reclaims",
    fn: (c) => {
      if (c.i < 4) return null;
      // Look for a bullish FVG in the last 5-15 bars; require price returned to 50% then bounced
      for (let j = c.i - 15; j <= c.i - 3; j++) {
        const fvg = detectFVG(c, j, "BULL");
        if (!fvg) continue;
        const mid = (fvg.top + fvg.bot) / 2;
        const b = c.bars15m[c.i];
        if (b.low <= mid && b.close > mid && b.close > b.open) return { side: "LONG" };
      }
      return null;
    },
  },
  {
    id: "B6-04",
    name: "FVG 50% fill — bear FVG, symmetric",
    fn: (c) => {
      if (c.i < 4) return null;
      for (let j = c.i - 15; j <= c.i - 3; j++) {
        const fvg = detectFVG(c, j, "BEAR");
        if (!fvg) continue;
        const mid = (fvg.top + fvg.bot) / 2;
        const b = c.bars15m[c.i];
        if (b.high >= mid && b.close < mid && b.close < b.open) return { side: "SHORT" };
      }
      return null;
    },
  },
  {
    id: "B6-05",
    name: "Liquidity sweep low + reversal — break of 20-bar low then close back inside",
    fn: (c) => {
      if (c.i < 22) return null;
      const recentLow = nLow(c, 20);
      const b = c.bars15m[c.i];
      // Sweep: bar's low broke below recentLow but close back above
      if (b.low < recentLow && b.close > recentLow && b.close > b.open) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B6-06",
    name: "Liquidity sweep high + reversal — break of 20-bar high then close back inside",
    fn: (c) => {
      if (c.i < 22) return null;
      const recentHigh = nHigh(c, 20);
      const b = c.bars15m[c.i];
      if (b.high > recentHigh && b.close < recentHigh && b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B6-07",
    name: "Equal-highs sweep — two prior bars tagged the same high, current bar sweeps and rejects",
    fn: (c) => {
      if (c.i < 12) return null;
      // Find a level where 2+ prior bars had highs within 0.1% of each other
      const b = c.bars15m[c.i];
      let level = -Infinity;
      let count = 0;
      for (let j = c.i - 12; j <= c.i - 1; j++) {
        const h = c.bars15m[j].high;
        if (level === -Infinity) { level = h; count = 1; continue; }
        if (Math.abs(h - level) / level < 0.001) count++;
        else if (h > level) { level = h; count = 1; }
      }
      if (count < 2) return null;
      if (b.high > level && b.close < level) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B6-08",
    name: "Wyckoff spring — failed break below N-bar low + reclaim + close > prev close",
    fn: (c) => {
      if (c.i < 22) return null;
      const recentLow = nLow(c, 20);
      const prev = c.bars15m[c.i - 1];
      const b = c.bars15m[c.i];
      // Prev bar made new low (the "spring"); current bar reclaims and closes above
      if (prev.low < recentLow && b.close > prev.high) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B6-09",
    name: "Wyckoff upthrust — failed break above N-bar high + rejection",
    fn: (c) => {
      if (c.i < 22) return null;
      const recentHigh = nHigh(c, 20);
      const prev = c.bars15m[c.i - 1];
      const b = c.bars15m[c.i];
      if (prev.high > recentHigh && b.close < prev.low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B6-10",
    name: "Power-of-3 — consolidation (10 bars in tight range), then sweep, then reversal",
    fn: (c) => {
      if (c.i < 14) return null;
      // Past 10 bars (excl last 3) — tight range: (max-min)/avg < 0.5%
      let mx = -Infinity, mn = Infinity, sum = 0;
      for (let j = c.i - 13; j <= c.i - 4; j++) {
        if (c.bars15m[j].high > mx) mx = c.bars15m[j].high;
        if (c.bars15m[j].low < mn) mn = c.bars15m[j].low;
        sum += c.bars15m[j].close;
      }
      const avg = sum / 10;
      if ((mx - mn) / avg > 0.005) return null;
      // Sweep: prev bar pierced consolidation extreme
      const prev = c.bars15m[c.i - 1];
      const b = c.bars15m[c.i];
      if (prev.low < mn && b.close > mn) return { side: "LONG" };
      if (prev.high > mx && b.close < mx) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-06-smc", strategies).catch(e => { console.error(e); process.exit(1); });

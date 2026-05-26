// Bucket 5 — Session / time-of-day specialists.
// Hypothesis: liquidity regimes differ across sessions. Some signals only
// work in active hours; some only in low-vol overnight. Hour-filtered
// strategies can isolate hours where a setup actually has edge.
//
// Run: npx tsx scripts/hf-screen/bucket-05-sessions.ts

import { Strategy, BarContext, runBucket } from "./lib";

// Common breakout helper: prior-N high/low (excl current)
function priorHighLow(c: BarContext, n: number): { hh: number; ll: number } {
  let hh = -Infinity, ll = Infinity;
  for (let j = c.i - n; j < c.i; j++) {
    if (c.bars15m[j].high > hh) hh = c.bars15m[j].high;
    if (c.bars15m[j].low < ll) ll = c.bars15m[j].low;
  }
  return { hh, ll };
}

// Asia (00-08 UTC) range for same calendar day
function asiaRange(c: BarContext): { hi: number; lo: number } | null {
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
  return found ? { hi, lo } : null;
}

// Compute prior session's close-vs-open momentum (for trend continuation)
function priorSessionDir(c: BarContext, hoursBack: number): "up" | "down" | null {
  if (c.i < hoursBack * 4) return null;
  const start = c.i - hoursBack * 4;
  const open = c.bars15m[start].open;
  const close = c.bars15m[c.i - 1].close;
  if (close > open * 1.002) return "up";
  if (close < open * 0.998) return "down";
  return null;
}

const strategies: Strategy[] = [
  {
    id: "B5-01",
    name: "Asia range break — break in 08-12 UTC, direction trade",
    fn: (c) => {
      if (c.hourUtc < 8 || c.hourUtc > 12) return null;
      const range = asiaRange(c);
      if (!range) return null;
      const b = c.bars15m[c.i];
      const prev = c.bars15m[c.i - 1];
      // require close BREAKS the range (didn't already break in prior bar)
      if (b.close > range.hi && prev.close <= range.hi) return { side: "LONG" };
      if (b.close < range.lo && prev.close >= range.lo) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B5-02",
    name: "Asia range FADE — within 08-12 UTC, fade range extremes",
    fn: (c) => {
      if (c.hourUtc < 8 || c.hourUtc > 12) return null;
      const range = asiaRange(c);
      if (!range) return null;
      const b = c.bars15m[c.i];
      // Fade: price went above asia hi but closed back below = fade SHORT; symmetric for LONG
      if (b.high > range.hi && b.close < range.hi) return { side: "SHORT" };
      if (b.low < range.lo && b.close > range.lo) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-03",
    name: "London-open momentum (08:00 ± 30m UTC) — trade direction of first 1h bar",
    fn: (c) => {
      if (c.hourUtc !== 8) return null;
      // 8:00 UTC bar: direction trade based on bar's own body
      const b = c.bars15m[c.i];
      const body = b.close - b.open;
      if (body > 0 && Math.abs(body) > (b.high - b.low) * 0.5) return { side: "LONG" };
      if (body < 0 && Math.abs(body) > (b.high - b.low) * 0.5) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B5-04",
    name: "NY-open continuation (13:30 UTC) — continue prior-session direction",
    fn: (c) => {
      if (c.hourUtc !== 13) return null;
      const d = new Date(c.bars15m[c.i].epoch * 1000);
      if (d.getUTCMinutes() < 30) return null;
      const dir = priorSessionDir(c, 5);  // last 5h trend
      if (!dir) return null;
      // Confirm with current bar direction
      const b = c.bars15m[c.i];
      if (dir === "up" && b.close > b.open) return { side: "LONG" };
      if (dir === "down" && b.close < b.open) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B5-05",
    name: "NY-close fade (20-22 UTC) — fade the day's drift",
    fn: (c) => {
      if (c.hourUtc < 20 || c.hourUtc > 22) return null;
      // Take direction opposite to day-open-to-now move
      const day = Math.floor(c.bars15m[c.i].epoch / 86400);
      let dayOpen = NaN;
      for (let j = c.i; j >= Math.max(0, c.i - 96); j--) {
        const dj = Math.floor(c.bars15m[j].epoch / 86400);
        if (dj !== day) break;
        const hr = new Date(c.bars15m[j].epoch * 1000).getUTCHours();
        if (hr === 0) { dayOpen = c.bars15m[j].open; break; }
      }
      if (!isFinite(dayOpen)) return null;
      const b = c.bars15m[c.i];
      const drift = (b.close - dayOpen) / dayOpen;
      // Fade if drift > 1% in either direction
      if (drift > 0.015) return { side: "SHORT" };
      if (drift < -0.015) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-06",
    name: "Post-funding fade (00:00/08:00/16:00 UTC, first bar after) — fade pre-funding drift",
    fn: (c) => {
      const d = new Date(c.bars15m[c.i].epoch * 1000);
      const hr = d.getUTCHours();
      const min = d.getUTCMinutes();
      // First 15m bar of the funding hour
      if (!(hr === 0 || hr === 8 || hr === 16) || min >= 15) return null;
      // Look at last 4h (16 bars) drift
      const ref = c.i - 16;
      if (ref < 0) return null;
      const refClose = c.bars15m[ref].close;
      const curClose = c.bars15m[c.i].close;
      const drift = (curClose - refClose) / refClose;
      if (drift > 0.01) return { side: "SHORT" };
      if (drift < -0.01) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-07",
    name: "Weekend low-vol mean-revert — Sat 00 → Sun 23 UTC + BB pierce",
    fn: (c) => {
      if (c.dow !== 6 && c.dow !== 0) return null;
      if (!c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-08",
    name: "Hour-band ∈ {12..22 UTC} + BB pierce (proven session)",
    fn: (c) => {
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      if (!c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-09",
    name: "Worst-hour blacklist — avoid 03-07 UTC, otherwise BB pierce",
    fn: (c) => {
      if (c.hourUtc >= 3 && c.hourUtc <= 7) return null;
      if (!c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      if (b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B5-10",
    name: "Session-corner trade (00 / 08 / 13 / 20 UTC turns) — Donchian-12 break",
    fn: (c) => {
      const KEY_HOURS = new Set([0, 8, 13, 20]);
      if (!KEY_HOURS.has(c.hourUtc)) return null;
      if (c.i < 13) return null;
      const { hh, ll } = priorHighLow(c, 12);
      const b = c.bars15m[c.i];
      if (b.close > hh) return { side: "LONG" };
      if (b.close < ll) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-05-sessions", strategies).catch(e => { console.error(e); process.exit(1); });

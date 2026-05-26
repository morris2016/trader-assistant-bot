// Bucket 3 — Momentum continuation.
// Hypothesis: trends persist on 15m crypto. After a confirmed trend signal,
// betting on continuation in the same direction has edge — but ONLY when
// the trend is real (multiple confirming indicators, not just one cross).
//
// Run: npx tsx scripts/hf-screen/bucket-03-momentum.ts

import { Strategy, BarContext, runBucket } from "./lib";
import { ema as emaFn, sma as smaFn, atr as atrFn } from "./lib";

// EMA cross detection at bar i: returns "up" / "down" / null
function emaCrossAt(closes: number[], fast: number, slow: number, i: number): "up" | "down" | null {
  if (i < slow) return null;
  const fNow = emaFn(closes, fast, i), sNow = emaFn(closes, slow, i);
  const fPrev = emaFn(closes, fast, i - 1), sPrev = emaFn(closes, slow, i - 1);
  if (!isFinite(fNow) || !isFinite(sNow) || !isFinite(fPrev) || !isFinite(sPrev)) return null;
  if (fPrev <= sPrev && fNow > sNow) return "up";
  if (fPrev >= sPrev && fNow < sNow) return "down";
  return null;
}

// Compute ADX(14) at bar i — wilder smoothing approximation
function adx14(bars: any[], i: number): number {
  if (i < 28) return NaN;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let j = i - 13; j <= i; j++) {
    const up = bars[j].high - bars[j - 1].high;
    const dn = bars[j - 1].low - bars[j].low;
    plusDM += up > dn && up > 0 ? up : 0;
    minusDM += dn > up && dn > 0 ? dn : 0;
    tr += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
  }
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return isFinite(dx) ? dx : 0;
}

// SuperTrend(10, 3) at bar i — returns "up" / "down"
function superTrend(bars: any[], i: number): "up" | "down" | null {
  if (i < 20) return null;
  const atrVal = atrFn(bars, 10, i);
  if (!isFinite(atrVal)) return null;
  const mid = (bars[i].high + bars[i].low) / 2;
  const upper = mid + 3 * atrVal;
  const lower = mid - 3 * atrVal;
  return bars[i].close > upper ? "up" : bars[i].close < lower ? "down" : null;
}

const strategies: Strategy[] = [
  {
    id: "B3-01",
    name: "EMA(8/21) cross on 15m + 1h trend agrees",
    fn: (c) => {
      const cross = emaCrossAt(c.closes15m, 8, 21, c.i);
      if (!cross) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const htfBull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (cross === "up" && htfBull) return { side: "LONG" };
      if (cross === "down" && !htfBull) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-02",
    name: "ADX(14) > 25 + DI+ vs DI- + pullback to EMA20",
    fn: (c) => {
      const adx = adx14(c.bars15m, c.i);
      if (adx < 25) return null;
      if (!isFinite(c.ema20) || !isFinite(c.ema50)) return null;
      const b = c.bars15m[c.i];
      // Crude DI direction: ema20 slope
      const ema20Prev = c.bars15m[c.i - 3] ? emaFn(c.closes15m, 20, c.i - 3) : NaN;
      if (!isFinite(ema20Prev)) return null;
      const bullTrend = c.ema20 > ema20Prev && c.ema20 > c.ema50;
      const pullback = side => side === "LONG" ? b.low <= c.ema20 && b.close > c.ema20 : b.high >= c.ema20 && b.close < c.ema20;
      if (bullTrend && pullback("LONG")) return { side: "LONG" };
      if (!bullTrend && pullback("SHORT")) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-03",
    name: "SuperTrend flip + close confirms (rare, selective)",
    fn: (c) => {
      const cur = superTrend(c.bars15m, c.i);
      const prev = superTrend(c.bars15m, c.i - 1);
      if (!cur || !prev) return null;
      if (cur === prev) return null;
      if (cur === "up") return { side: "LONG" };
      if (cur === "down") return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-04",
    name: "MACD histogram expanding 3 bars + price > EMA20",
    fn: (c) => {
      if (c.i < 27) return null;
      const ema12 = (i: number) => emaFn(c.closes15m, 12, i);
      const ema26 = (i: number) => emaFn(c.closes15m, 26, i);
      const hist = (i: number) => {
        const e12 = ema12(i), e26 = ema26(i);
        const macd = e12 - e26;
        // signal: ema(macd, 9) — approximation: use sma of last 9 macd values
        let sum = 0; let count = 0;
        for (let j = Math.max(0, i - 8); j <= i; j++) {
          const m = ema12(j) - ema26(j);
          if (isFinite(m)) { sum += m; count++; }
        }
        const sig = count ? sum / count : 0;
        return macd - sig;
      };
      const h0 = hist(c.i), h1 = hist(c.i - 1), h2 = hist(c.i - 2);
      if (!isFinite(h0) || !isFinite(h1) || !isFinite(h2)) return null;
      if (!isFinite(c.ema20)) return null;
      const b = c.bars15m[c.i];
      // Bullish: hist expanding positively, price > ema20
      if (h0 > h1 && h1 > h2 && h0 > 0 && b.close > c.ema20) return { side: "LONG" };
      if (h0 < h1 && h1 < h2 && h0 < 0 && b.close < c.ema20) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-05",
    name: "Heikin-Ashi 3 consecutive same-color + expanding bodies",
    fn: (c) => {
      if (c.i < 4) return null;
      const ha: Array<{ o: number; h: number; l: number; cls: number }> = [];
      for (let j = c.i - 3; j <= c.i; j++) {
        const r = c.bars15m[j];
        const hc = (r.open + r.high + r.low + r.close) / 4;
        const ho = ha.length ? (ha[ha.length - 1].o + ha[ha.length - 1].cls) / 2 : (r.open + r.close) / 2;
        const hh = Math.max(r.high, hc, ho);
        const hl = Math.min(r.low, hc, ho);
        ha.push({ o: ho, h: hh, l: hl, cls: hc });
      }
      const bullSeq = ha[1].cls > ha[1].o && ha[2].cls > ha[2].o && ha[3].cls > ha[3].o;
      const bearSeq = ha[1].cls < ha[1].o && ha[2].cls < ha[2].o && ha[3].cls < ha[3].o;
      const expand = Math.abs(ha[3].cls - ha[3].o) > Math.abs(ha[2].cls - ha[2].o);
      if (bullSeq && expand) return { side: "LONG" };
      if (bearSeq && expand) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-06",
    name: "Pullback to EMA20 in strong trend (close > EMA50, low touches EMA20)",
    fn: (c) => {
      if (!isFinite(c.ema20) || !isFinite(c.ema50)) return null;
      const b = c.bars15m[c.i];
      const trendUp = b.close > c.ema50 && c.ema20 > c.ema50;
      const trendDn = b.close < c.ema50 && c.ema20 < c.ema50;
      // Pullback: prev bar's low touched ema20 from above (trendUp) or high touched from below (trendDn)
      const prev = c.bars15m[c.i - 1];
      if (trendUp && prev.low <= c.ema20 && b.close > prev.high) return { side: "LONG" };
      if (trendDn && prev.high >= c.ema20 && b.close < prev.low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-07",
    name: "5-bar fractal break in EMA50 direction",
    fn: (c) => {
      if (c.i < 7) return null;
      // Williams fractal: pivot at i-3 is highest of {i-5..i-1} for high pivot, etc.
      const piv = c.i - 3;
      const isHighPivot = c.bars15m[piv].high > c.bars15m[piv - 1].high && c.bars15m[piv].high > c.bars15m[piv - 2].high && c.bars15m[piv].high > c.bars15m[piv + 1].high && c.bars15m[piv].high > c.bars15m[piv + 2].high;
      const isLowPivot = c.bars15m[piv].low < c.bars15m[piv - 1].low && c.bars15m[piv].low < c.bars15m[piv - 2].low && c.bars15m[piv].low < c.bars15m[piv + 1].low && c.bars15m[piv].low < c.bars15m[piv + 2].low;
      const b = c.bars15m[c.i];
      if (!isFinite(c.ema50)) return null;
      const bull = b.close > c.ema50;
      if (isHighPivot && bull && b.close > c.bars15m[piv].high) return { side: "LONG" };
      if (isLowPivot && !bull && b.close < c.bars15m[piv].low) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-08",
    name: "Three-bar push (3 higher closes / 3 lower closes) + ATR expansion",
    fn: (c) => {
      if (c.i < 5) return null;
      const c0 = c.bars15m[c.i].close, c1 = c.bars15m[c.i - 1].close, c2 = c.bars15m[c.i - 2].close, c3 = c.bars15m[c.i - 3].close;
      const bull = c0 > c1 && c1 > c2 && c2 > c3;
      const bear = c0 < c1 && c1 < c2 && c2 < c3;
      if (!bull && !bear) return null;
      // ATR expanding
      const atrShort = atrFn(c.bars15m, 7, c.i);
      const atrPrior = atrFn(c.bars15m, 7, c.i - 7);
      if (!isFinite(atrShort) || !isFinite(atrPrior)) return null;
      if (atrShort <= atrPrior) return null;
      return { side: bull ? "LONG" : "SHORT" };
    },
  },
  {
    id: "B3-09",
    name: "VWAP slope + close above/below VWAP (1-day VWAP)",
    fn: (c) => {
      // Build VWAP from start-of-UTC-day to current bar
      const dayEpoch = Math.floor(c.bars15m[c.i].epoch / 86400) * 86400;
      let pv = 0, vv = 0;
      for (let j = c.i; j >= 0; j--) {
        if (c.bars15m[j].epoch < dayEpoch) break;
        const p = (c.bars15m[j].high + c.bars15m[j].low + c.bars15m[j].close) / 3;
        pv += p * c.bars15m[j].volume;
        vv += c.bars15m[j].volume;
      }
      if (vv === 0) return null;
      const vwap = pv / vv;
      // VWAP slope: compare to half-day-prior VWAP at i-12 bars
      let pv2 = 0, vv2 = 0;
      const halfIdx = c.i - 12;
      if (halfIdx < 0) return null;
      for (let j = halfIdx; j >= 0; j--) {
        if (c.bars15m[j].epoch < dayEpoch) break;
        const p = (c.bars15m[j].high + c.bars15m[j].low + c.bars15m[j].close) / 3;
        pv2 += p * c.bars15m[j].volume;
        vv2 += c.bars15m[j].volume;
      }
      if (vv2 === 0) return null;
      const vwapPrior = pv2 / vv2;
      const b = c.bars15m[c.i];
      if (vwap > vwapPrior && b.close > vwap && c.bars15m[c.i - 1].close <= vwap) return { side: "LONG" };
      if (vwap < vwapPrior && b.close < vwap && c.bars15m[c.i - 1].close >= vwap) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B3-10",
    name: "ADX > 30 + EMA(8/21) cross + 1h trend agrees (selective combo)",
    fn: (c) => {
      const adx = adx14(c.bars15m, c.i);
      if (adx < 30) return null;
      const cross = emaCrossAt(c.closes15m, 8, 21, c.i);
      if (!cross) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const htfBull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (cross === "up" && htfBull) return { side: "LONG" };
      if (cross === "down" && !htfBull) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-03-momentum", strategies).catch(e => { console.error(e); process.exit(1); });

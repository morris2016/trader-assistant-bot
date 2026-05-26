// Factor-mining harness — for every 15m bar across 15 assets × 12 months,
// tag ~25 factors at signal time and simulate the live exit (trail-arm at
// 1×ATR / 0.3×ATR retrace + 1×ATR hard SL + 4h timeout). Then pivot by
// factor-bucket to find combinations with edge.
//
// Output:
//   - results/factor-mine-tuples.bin (raw tuples, binary)
//   - results/factor-mine-pivots.json (ranked single + pair pivots)
//   - Console: top-30 single-factor pivots, top-30 factor pairs, candidate strategies
//
// Run: npx tsx scripts/hf-screen/factor-mine.ts

import * as fs from "fs";
import * as path from "path";
import {
  ASSETS, CACHE_DIR, RESULTS_DIR, STAKE, LEV, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, rsi as rsiFn, ema as emaFn, bb as bbFn,
  alignTo1h, buildMinuteIdx,
  defaultWindow,
  type Bar,
} from "./lib";

// ── Factor list ─────────────────────────────────────────────────────────
const FACTORS = [
  "z20", "z50", "z100",                  // mean-revert candidates
  "rsi14",                                // momentum/extreme
  "atrPct", "bbWidthPct", "volPct",       // regime
  "rangeAtr", "bodyRange", "closePos",    // bar shape
  "upperWick", "lowerWick",               // wick magnitudes
  "ema20Dist", "ema50Dist",               // trend distance
  "hourUtc", "dow",                       // time
  "htf1hTrend", "htf4hRet",               // higher TF
  "takerBuyRatio",                        // taker bias
  "ret5", "ret20",                        // momentum
  "atrExpand",                            // ATR(7)/ATR(28) ratio
  "consecBars",                           // consecutive same-direction
  "donPos",                               // close position in Donchian-20
  "volZ",                                 // volume z-score
] as const;
type FactorName = typeof FACTORS[number];

// ── Tuple struct ────────────────────────────────────────────────────────
type Tuple = {
  asset: string;
  epoch: number;
  factors: Float32Array;   // length FACTORS.length
  pnlLong: number;
  pnlShort: number;
  armedLong: boolean;
  armedShort: boolean;
};

function doSim(bars1m: Bar[], startIdx: number, entry: number, atrVal: number, side: "LONG" | "SHORT"): { exit: number; armed: boolean } {
  const armDist = TRAIL_ARM_ATR * atrVal;
  const trailDist = TRAIL_RETRACE_ATR * atrVal;
  const slDist = HARD_SL_ATR * atrVal;
  const slPrice = side === "LONG" ? entry - slDist : entry + slDist;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPrice) return { exit: slPrice, armed };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armDist) armed = true;
      if (armed && b.low <= peak - trailDist) return { exit: peak - trailDist, armed: true };
    } else {
      if (b.high >= slPrice) return { exit: slPrice, armed };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armDist) armed = true;
      if (armed && b.high >= peak + trailDist) return { exit: peak + trailDist, armed: true };
    }
  }
  return { exit: bars1m[maxIdx].close, armed };
}

function pnl(side: "LONG" | "SHORT", entry: number, exit: number): number {
  const grossPct = side === "LONG" ? (exit - entry) / entry : (entry - exit) / entry;
  return STAKE * LEV * (grossPct - COST_RT);
}

function pctileRank(sorted: number[], v: number): number {
  // Returns rank in [0,1] of v in sorted ascending
  if (!sorted.length) return 0.5;
  let lo = 0, hi = sorted.length - 1, idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= v) { idx = m + 1; lo = m + 1; } else hi = m - 1;
  }
  return idx / sorted.length;
}

async function main() {
  const { fromEpoch, toEpoch, label } = defaultWindow();
  console.log(`\n══ Factor mining — ${ASSETS.length} assets × ${label} ══`);
  console.log(`Factors (${FACTORS.length}): ${FACTORS.join(", ")}`);
  console.log(`Exit: trail ${TRAIL_ARM_ATR}/${TRAIL_RETRACE_ATR} ATR + SL ${HARD_SL_ATR}×ATR + ${HARD_TIMEOUT_MIN}m timeout`);
  console.log(`Sizing: $${STAKE} × ${LEV}×, cost ${(COST_RT*100).toFixed(4)}%\n`);

  const tuples: Tuple[] = [];

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} loading…`);
    const t0 = Date.now();
    const bars1m = load1m(sym, fromEpoch - 30 * 86400, toEpoch);
    if (bars1m.length === 0) { console.log(" no data"); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);
    process.stdout.write(` tagging ${bars15m.length} bars…`);

    // Pre-compute indicator arrays
    const atrArr = new Float64Array(bars15m.length);
    const rsiArr = new Float64Array(bars15m.length);
    const ema20Arr = new Float64Array(bars15m.length);
    const ema50Arr = new Float64Array(bars15m.length);
    const ema50_1hArr = new Float64Array(bars1h.length);
    const bbWidthArr = new Float64Array(bars15m.length);
    for (let i = 0; i < bars15m.length; i++) {
      atrArr[i] = atrFn(bars15m, 14, i);
      rsiArr[i] = rsiFn(closes15m, 14, i);
      ema20Arr[i] = emaFn(closes15m, 20, i);
      ema50Arr[i] = emaFn(closes15m, 50, i);
      const bb = bbFn(closes15m, 20, 2.0, i);
      bbWidthArr[i] = bb ? (bb.upper - bb.lower) / bb.mid : NaN;
    }
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = emaFn(closes1h, 50, i);

    // Sliding window helpers
    let processed = 0;
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < fromEpoch) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 50) continue;

      // ── Compute factors ──────────────────────────────────────────────
      // z-scores over 20/50/100
      const zN = (n: number) => {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += closes15m[j];
        const m = s / n;
        let v = 0;
        for (let j = i - n + 1; j <= i; j++) v += (closes15m[j] - m) ** 2;
        const sd = Math.sqrt(v / n);
        return sd === 0 ? 0 : (closes15m[i] - m) / sd;
      };
      const z20 = zN(20), z50 = zN(50), z100 = zN(100);

      // Percentiles over last 60 bars
      const atrSlice: number[] = []; const bbSlice: number[] = []; const volSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) {
        if (isFinite(atrArr[j])) atrSlice.push(atrArr[j]);
        if (isFinite(bbWidthArr[j])) bbSlice.push(bbWidthArr[j]);
        volSlice.push(bars15m[j].volume);
      }
      atrSlice.sort((a, b) => a - b); bbSlice.sort((a, b) => a - b); volSlice.sort((a, b) => a - b);
      const atrPct = pctileRank(atrSlice, atrArr[i]);
      const bbWidthPct = pctileRank(bbSlice, bbWidthArr[i]);
      const volPct = pctileRank(volSlice, b.volume);

      // Bar shape
      const range = b.high - b.low;
      const rangeAtr = range / atrArr[i];
      const bodyRange = range > 0 ? Math.abs(b.close - b.open) / range : 0;
      const closePos = range > 0 ? (b.close - b.low) / range : 0.5;
      const upperWick = range > 0 ? (b.high - Math.max(b.open, b.close)) / range : 0;
      const lowerWick = range > 0 ? (Math.min(b.open, b.close) - b.low) / range : 0;

      // Distance from MAs
      const ema20Dist = isFinite(ema20Arr[i]) ? (b.close - ema20Arr[i]) / ema20Arr[i] : 0;
      const ema50Dist = isFinite(ema50Arr[i]) ? (b.close - ema50Arr[i]) / ema50Arr[i] : 0;

      // Time
      const d = new Date(b.epoch * 1000);
      const hourUtc = d.getUTCHours();
      const dow = d.getUTCDay();

      // HTF
      const htf1hTrend = isFinite(ema50_1hArr[i1h]) ? (closes1h[i1h] > ema50_1hArr[i1h] ? 1 : 0) : 0.5;
      const i1hPrev16 = Math.max(0, i1h - 16);
      const htf4hRet = (closes1h[i1h] - closes1h[i1hPrev16]) / closes1h[i1hPrev16];

      // Taker bias
      const takerBuyRatio = b.volume > 0 ? b.takerBuyVolume / b.volume : 0.5;

      // Returns
      const ret5 = (closes15m[i] - closes15m[i - 5]) / closes15m[i - 5];
      const ret20 = (closes15m[i] - closes15m[i - 20]) / closes15m[i - 20];

      // ATR expansion (ATR7 / ATR28)
      const atr7 = atrFn(bars15m, 7, i);
      const atr28 = atrFn(bars15m, 28, i);
      const atrExpand = (isFinite(atr7) && isFinite(atr28) && atr28 > 0) ? atr7 / atr28 : 1;

      // Consecutive bars
      let consec = 0;
      const dir = b.close > b.open ? 1 : (b.close < b.open ? -1 : 0);
      if (dir !== 0) {
        for (let j = i; j >= 0; j--) {
          const dj = bars15m[j].close > bars15m[j].open ? 1 : (bars15m[j].close < bars15m[j].open ? -1 : 0);
          if (dj === dir) consec++;
          else break;
        }
      }
      const consecBars = consec * dir;  // signed

      // Donchian position over 20 bars
      let hh = -Infinity, ll = Infinity;
      for (let j = i - 19; j <= i; j++) {
        if (bars15m[j].high > hh) hh = bars15m[j].high;
        if (bars15m[j].low < ll) ll = bars15m[j].low;
      }
      const donPos = hh > ll ? (b.close - ll) / (hh - ll) : 0.5;

      // Volume z-score over 60 bars
      let vS = 0; for (let j = i - 59; j <= i; j++) vS += bars15m[j].volume;
      const vM = vS / 60;
      let vV = 0; for (let j = i - 59; j <= i; j++) vV += (bars15m[j].volume - vM) ** 2;
      const vSd = Math.sqrt(vV / 60);
      const volZ = vSd === 0 ? 0 : (b.volume - vM) / vSd;

      // ── Simulate fwd-pnl for LONG and SHORT ────────────────────────────
      const next = bars15m[i + 1];
      const startIdx = minMap.get(next.epoch);
      if (startIdx === undefined) continue;
      const entry = next.open;
      const longExit = doSim(bars1m, startIdx, entry, atrArr[i], "LONG");
      const shortExit = doSim(bars1m, startIdx, entry, atrArr[i], "SHORT");
      const pnlLong = pnl("LONG", entry, longExit.exit);
      const pnlShort = pnl("SHORT", entry, shortExit.exit);

      const f = new Float32Array(FACTORS.length);
      f[0] = z20; f[1] = z50; f[2] = z100;
      f[3] = rsiArr[i];
      f[4] = atrPct; f[5] = bbWidthPct; f[6] = volPct;
      f[7] = rangeAtr; f[8] = bodyRange; f[9] = closePos;
      f[10] = upperWick; f[11] = lowerWick;
      f[12] = ema20Dist; f[13] = ema50Dist;
      f[14] = hourUtc; f[15] = dow;
      f[16] = htf1hTrend; f[17] = htf4hRet;
      f[18] = takerBuyRatio;
      f[19] = ret5; f[20] = ret20;
      f[21] = atrExpand;
      f[22] = consecBars;
      f[23] = donPos;
      f[24] = volZ;

      tuples.push({
        asset: sym, epoch: b.epoch, factors: f,
        pnlLong, pnlShort,
        armedLong: longExit.armed, armedShort: shortExit.armed,
      });
      processed++;
    }
    console.log(` ${processed} tuples in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log(`\nTotal tuples: ${tuples.length.toLocaleString()}`);

  // ── Quintile breakpoints per factor (pooled across all assets) ─────────
  const quintiles: Record<FactorName, number[]> = {} as any;
  for (let k = 0; k < FACTORS.length; k++) {
    const name = FACTORS[k];
    const vals: number[] = [];
    for (const t of tuples) if (isFinite(t.factors[k])) vals.push(t.factors[k]);
    vals.sort((a, b) => a - b);
    // 5 quintiles → 4 breakpoints at 20/40/60/80%
    quintiles[name] = [vals[Math.floor(vals.length * 0.2)], vals[Math.floor(vals.length * 0.4)], vals[Math.floor(vals.length * 0.6)], vals[Math.floor(vals.length * 0.8)]];
  }
  // Assign quintile bucket per tuple per factor
  function bucketOf(v: number, breaks: number[]): number {
    let b = 0;
    for (const t of breaks) if (v >= t) b++;
    return b;  // 0..4
  }

  // ── Stage B: single-factor quintile pivots ─────────────────────────────
  // For each (factor, quintile, side) compute count, mean pnl, WR
  type Cell = { n: number; wins: number; netSum: number };
  const single: Record<string, Cell> = {};
  for (const t of tuples) {
    for (let k = 0; k < FACTORS.length; k++) {
      const v = t.factors[k];
      if (!isFinite(v)) continue;
      const q = bucketOf(v, quintiles[FACTORS[k]]);
      for (const side of ["L", "S"] as const) {
        const key = `${FACTORS[k]}|q${q}|${side}`;
        if (!single[key]) single[key] = { n: 0, wins: 0, netSum: 0 };
        const pnl = side === "L" ? t.pnlLong : t.pnlShort;
        single[key].n++;
        if (pnl > 0) single[key].wins++;
        single[key].netSum += pnl;
      }
    }
  }
  // Rank single cells
  const singleRanked = Object.entries(single)
    .filter(([_, c]) => c.n >= 1000)  // need sample size
    .map(([key, c]) => ({ key, n: c.n, wr: c.wins / c.n, net: c.netSum, avg: c.netSum / c.n }))
    .sort((a, b) => b.avg - a.avg);

  console.log(`\n── Top 20 single-factor quintile cells (n ≥ 1,000, ranked by avg P&L per trade) ──`);
  console.log(`${"factor|quintile|side".padEnd(28)} ${"n".padStart(7)} ${"WR%".padStart(6)} ${"net$".padStart(10)} ${"avg$".padStart(7)}`);
  for (const r of singleRanked.slice(0, 20)) {
    console.log(`${r.key.padEnd(28)} ${String(r.n).padStart(7)} ${(r.wr*100).toFixed(1).padStart(6)} ${r.net.toFixed(0).padStart(10)} ${r.avg.toFixed(3).padStart(7)}`);
  }

  console.log(`\n── Bottom 5 (avoid these regions) ──`);
  for (const r of singleRanked.slice(-5).reverse()) {
    console.log(`${r.key.padEnd(28)} ${String(r.n).padStart(7)} ${(r.wr*100).toFixed(1).padStart(6)} ${r.net.toFixed(0).padStart(10)} ${r.avg.toFixed(3).padStart(7)}`);
  }

  // ── Stage C: top-K factor-pair pivots ──────────────────────────────────
  // Take top-12 single-factor-quintile cells (the most predictive single conditions),
  // and for EACH such cell, intersect with EVERY other factor's quintile to find
  // pair combinations with even higher edge.
  console.log(`\n── Top factor PAIRS (each starts with a top single-cell, adds 2nd factor) ──`);
  const topSingles = singleRanked.slice(0, 12);
  const pairResults: Array<{ pair: string; n: number; wr: number; net: number; avg: number }> = [];
  for (const top of topSingles) {
    const [fName, qStr, sideStr] = top.key.split("|");
    const fIdx = FACTORS.indexOf(fName as FactorName);
    const qVal = parseInt(qStr.slice(1), 10);
    const side = sideStr as "L" | "S";
    // For every other factor, bin by its quintile and tally
    for (let k2 = 0; k2 < FACTORS.length; k2++) {
      if (k2 === fIdx) continue;
      const buckets: Cell[] = [{ n: 0, wins: 0, netSum: 0 }, { n: 0, wins: 0, netSum: 0 }, { n: 0, wins: 0, netSum: 0 }, { n: 0, wins: 0, netSum: 0 }, { n: 0, wins: 0, netSum: 0 }];
      for (const t of tuples) {
        const v1 = t.factors[fIdx];
        if (!isFinite(v1)) continue;
        if (bucketOf(v1, quintiles[fName as FactorName]) !== qVal) continue;
        const v2 = t.factors[k2];
        if (!isFinite(v2)) continue;
        const q2 = bucketOf(v2, quintiles[FACTORS[k2]]);
        const pnl = side === "L" ? t.pnlLong : t.pnlShort;
        buckets[q2].n++;
        if (pnl > 0) buckets[q2].wins++;
        buckets[q2].netSum += pnl;
      }
      for (let q2 = 0; q2 < 5; q2++) {
        const c = buckets[q2];
        if (c.n < 300) continue;
        pairResults.push({ pair: `${fName}=q${qVal}, ${FACTORS[k2]}=q${q2}, ${side}`, n: c.n, wr: c.wins / c.n, net: c.netSum, avg: c.netSum / c.n });
      }
    }
  }
  pairResults.sort((a, b) => b.avg - a.avg);
  console.log(`${"pair (n ≥ 300)".padEnd(58)} ${"n".padStart(6)} ${"WR%".padStart(6)} ${"net$".padStart(8)} ${"avg$".padStart(7)}`);
  for (const r of pairResults.slice(0, 30)) {
    console.log(`${r.pair.padEnd(58).slice(0, 58)} ${String(r.n).padStart(6)} ${(r.wr*100).toFixed(1).padStart(6)} ${r.net.toFixed(0).padStart(8)} ${r.avg.toFixed(3).padStart(7)}`);
  }

  // ── Save raw + ranked ──────────────────────────────────────────────────
  const out = {
    label, factors: FACTORS, quintiles, singleRankedTop50: singleRanked.slice(0, 50), pairRankedTop50: pairResults.slice(0, 50),
  };
  const outFile = path.join(RESULTS_DIR, "factor-mine-pivots.json");
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`\nSaved → ${outFile}`);
  console.log(`\nNext: pick top pair candidates and CV-validate via stage2-cv-mined.ts`);
}

main().catch(e => { console.error(e); process.exit(1); });

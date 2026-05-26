// Factor-mining CV — re-tag every bar, then split into TRAIN/TEST/W0
// windows. Compute quintile breakpoints from TRAIN ONLY. Apply those
// fixed breakpoints to TEST and W0. Measure each top mined pair across
// all 3 windows. Survivors are net-positive in ALL THREE windows.
//
// Then for survivors, run triple-factor mining (add a 3rd factor to the
// pair) and surface the best triples — those are the "production rules".
//
// Run: npx tsx scripts/hf-screen/factor-mine-cv.ts

import * as fs from "fs";
import * as path from "path";
import {
  ASSETS, CACHE_DIR, RESULTS_DIR, STAKE, LEV, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, rsi as rsiFn, ema as emaFn, bb as bbFn,
  alignTo1h, buildMinuteIdx,
  type Bar,
} from "./lib";

const FACTORS = [
  "z20", "z50", "z100",
  "rsi14",
  "atrPct", "bbWidthPct", "volPct",
  "rangeAtr", "bodyRange", "closePos",
  "upperWick", "lowerWick",
  "ema20Dist", "ema50Dist",
  "hourUtc", "dow",
  "htf1hTrend", "htf4hRet",
  "takerBuyRatio",
  "ret5", "ret20",
  "atrExpand",
  "consecBars",
  "donPos",
  "volZ",
] as const;
type FactorName = typeof FACTORS[number];

const WINDOWS = [
  { id: "TRAIN", start: "2025-05-26", end: "2025-12-31" },
  { id: "TEST",  start: "2026-01-01", end: "2026-04-30" },
  { id: "W0",    start: "2026-05-01", end: "2026-05-25" },
];

function doSim(bars1m: Bar[], startIdx: number, entry: number, atrVal: number, side: "LONG" | "SHORT"): number {
  const armDist = TRAIL_ARM_ATR * atrVal;
  const trailDist = TRAIL_RETRACE_ATR * atrVal;
  const slDist = HARD_SL_ATR * atrVal;
  const slPrice = side === "LONG" ? entry - slDist : entry + slDist;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPrice) return slPrice;
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armDist) armed = true;
      if (armed && b.low <= peak - trailDist) return peak - trailDist;
    } else {
      if (b.high >= slPrice) return slPrice;
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armDist) armed = true;
      if (armed && b.high >= peak + trailDist) return peak + trailDist;
    }
  }
  return bars1m[maxIdx].close;
}
function pnlFn(side: "LONG" | "SHORT", entry: number, exit: number): number {
  const grossPct = side === "LONG" ? (exit - entry) / entry : (entry - exit) / entry;
  return STAKE * LEV * (grossPct - COST_RT);
}
function pctileRank(sorted: number[], v: number): number {
  if (!sorted.length) return 0.5;
  let lo = 0, hi = sorted.length - 1, idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= v) { idx = m + 1; lo = m + 1; } else hi = m - 1;
  }
  return idx / sorted.length;
}

type Tuple = {
  asset: string; epoch: number; window: string;
  factors: Float32Array;
  pnlLong: number; pnlShort: number;
};

async function main() {
  console.log(`\n══ Factor-mining CV — TRAIN-only breakpoints applied to all windows ══`);
  const winFromTo = WINDOWS.map(w => ({
    id: w.id, label: `${w.start}→${w.end}`,
    from: Math.floor(new Date(w.start).getTime() / 1000),
    to: Math.floor(new Date(w.end).getTime() / 1000),
  }));
  const fullFrom = Math.floor(new Date("2025-04-01").getTime() / 1000);
  const fullTo = Math.floor(new Date("2026-05-31").getTime() / 1000);

  const tuples: Tuple[] = [];

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const t0 = Date.now();
    const bars1m = load1m(sym, fullFrom - 30 * 86400, fullTo);
    if (bars1m.length === 0) { console.log("no data"); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);
    process.stdout.write(`tagging ${bars15m.length} bars…`);

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

    let processed = 0;
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      let win: typeof winFromTo[0] | null = null;
      for (const w of winFromTo) if (b.epoch >= w.from && b.epoch <= w.to) { win = w; break; }
      if (!win) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 50) continue;

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

      const range = b.high - b.low;
      const rangeAtr = range / atrArr[i];
      const bodyRange = range > 0 ? Math.abs(b.close - b.open) / range : 0;
      const closePos = range > 0 ? (b.close - b.low) / range : 0.5;
      const upperWick = range > 0 ? (b.high - Math.max(b.open, b.close)) / range : 0;
      const lowerWick = range > 0 ? (Math.min(b.open, b.close) - b.low) / range : 0;
      const ema20Dist = isFinite(ema20Arr[i]) ? (b.close - ema20Arr[i]) / ema20Arr[i] : 0;
      const ema50Dist = isFinite(ema50Arr[i]) ? (b.close - ema50Arr[i]) / ema50Arr[i] : 0;
      const d = new Date(b.epoch * 1000);
      const hourUtc = d.getUTCHours();
      const dow = d.getUTCDay();
      const htf1hTrend = isFinite(ema50_1hArr[i1h]) ? (closes1h[i1h] > ema50_1hArr[i1h] ? 1 : 0) : 0.5;
      const i1hPrev16 = Math.max(0, i1h - 16);
      const htf4hRet = (closes1h[i1h] - closes1h[i1hPrev16]) / closes1h[i1hPrev16];
      const takerBuyRatio = b.volume > 0 ? b.takerBuyVolume / b.volume : 0.5;
      const ret5 = (closes15m[i] - closes15m[i - 5]) / closes15m[i - 5];
      const ret20 = (closes15m[i] - closes15m[i - 20]) / closes15m[i - 20];
      const atr7 = atrFn(bars15m, 7, i);
      const atr28 = atrFn(bars15m, 28, i);
      const atrExpand = (isFinite(atr7) && isFinite(atr28) && atr28 > 0) ? atr7 / atr28 : 1;
      let consec = 0;
      const dir = b.close > b.open ? 1 : (b.close < b.open ? -1 : 0);
      if (dir !== 0) {
        for (let j = i; j >= 0; j--) {
          const dj = bars15m[j].close > bars15m[j].open ? 1 : (bars15m[j].close < bars15m[j].open ? -1 : 0);
          if (dj === dir) consec++;
          else break;
        }
      }
      const consecBars = consec * dir;
      let hh = -Infinity, ll = Infinity;
      for (let j = i - 19; j <= i; j++) {
        if (bars15m[j].high > hh) hh = bars15m[j].high;
        if (bars15m[j].low < ll) ll = bars15m[j].low;
      }
      const donPos = hh > ll ? (b.close - ll) / (hh - ll) : 0.5;
      let vS = 0; for (let j = i - 59; j <= i; j++) vS += bars15m[j].volume;
      const vM = vS / 60;
      let vV = 0; for (let j = i - 59; j <= i; j++) vV += (bars15m[j].volume - vM) ** 2;
      const vSd = Math.sqrt(vV / 60);
      const volZ = vSd === 0 ? 0 : (b.volume - vM) / vSd;

      const next = bars15m[i + 1];
      const startIdx = minMap.get(next.epoch);
      if (startIdx === undefined) continue;
      const entry = next.open;
      const lExit = doSim(bars1m, startIdx, entry, atrArr[i], "LONG");
      const sExit = doSim(bars1m, startIdx, entry, atrArr[i], "SHORT");
      const pnlLong = pnlFn("LONG", entry, lExit);
      const pnlShort = pnlFn("SHORT", entry, sExit);

      const f = new Float32Array(FACTORS.length);
      f[0]=z20; f[1]=z50; f[2]=z100; f[3]=rsiArr[i]; f[4]=atrPct; f[5]=bbWidthPct; f[6]=volPct;
      f[7]=rangeAtr; f[8]=bodyRange; f[9]=closePos; f[10]=upperWick; f[11]=lowerWick;
      f[12]=ema20Dist; f[13]=ema50Dist; f[14]=hourUtc; f[15]=dow; f[16]=htf1hTrend; f[17]=htf4hRet;
      f[18]=takerBuyRatio; f[19]=ret5; f[20]=ret20; f[21]=atrExpand; f[22]=consecBars; f[23]=donPos; f[24]=volZ;

      tuples.push({ asset: sym, epoch: b.epoch, window: win.id, factors: f, pnlLong, pnlShort });
      processed++;
    }
    console.log(` ${processed} tuples in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Per-window tuple counts
  const trainTuples = tuples.filter(t => t.window === "TRAIN");
  const testTuples = tuples.filter(t => t.window === "TEST");
  const w0Tuples = tuples.filter(t => t.window === "W0");
  console.log(`\nTRAIN: ${trainTuples.length}  TEST: ${testTuples.length}  W0: ${w0Tuples.length}`);

  // ── Compute TRAIN-only quintile breakpoints ────────────────────────────
  const trainQuintiles: Record<FactorName, number[]> = {} as any;
  for (let k = 0; k < FACTORS.length; k++) {
    const name = FACTORS[k];
    const vals: number[] = [];
    for (const t of trainTuples) if (isFinite(t.factors[k])) vals.push(t.factors[k]);
    vals.sort((a, b) => a - b);
    trainQuintiles[name] = [vals[Math.floor(vals.length * 0.2)], vals[Math.floor(vals.length * 0.4)], vals[Math.floor(vals.length * 0.6)], vals[Math.floor(vals.length * 0.8)]];
  }
  function bucketOf(v: number, breaks: number[]): number {
    let b = 0;
    for (const t of breaks) if (v >= t) b++;
    return b;
  }

  // ── Re-mine TRAIN pair edges (now using only TRAIN data) ───────────────
  type Cell = { n: number; wins: number; netSum: number };
  console.log(`\n── TRAIN-only pair mining (n ≥ 200, looking for >60% WR, positive avg) ──`);

  // First, single-factor on TRAIN
  const singleTrain: Record<string, Cell> = {};
  for (const t of trainTuples) {
    for (let k = 0; k < FACTORS.length; k++) {
      const v = t.factors[k];
      if (!isFinite(v)) continue;
      const q = bucketOf(v, trainQuintiles[FACTORS[k]]);
      for (const side of ["L", "S"] as const) {
        const key = `${FACTORS[k]}|q${q}|${side}`;
        if (!singleTrain[key]) singleTrain[key] = { n: 0, wins: 0, netSum: 0 };
        const pnl = side === "L" ? t.pnlLong : t.pnlShort;
        singleTrain[key].n++;
        if (pnl > 0) singleTrain[key].wins++;
        singleTrain[key].netSum += pnl;
      }
    }
  }
  const singleRanked = Object.entries(singleTrain)
    .filter(([_, c]) => c.n >= 1000)
    .map(([key, c]) => ({ key, n: c.n, wr: c.wins / c.n, net: c.netSum, avg: c.netSum / c.n }))
    .sort((a, b) => b.avg - a.avg);

  // Pair: top-12 single → each other factor
  const topSingles = singleRanked.slice(0, 12);
  const pairResults: Array<{ pairKey: string; train: Cell; test?: Cell; w0?: Cell }> = [];

  for (const top of topSingles) {
    const [fName, qStr, sideStr] = top.key.split("|");
    const fIdx = FACTORS.indexOf(fName as FactorName);
    const qVal = parseInt(qStr.slice(1), 10);
    const side = sideStr as "L" | "S";

    for (let k2 = 0; k2 < FACTORS.length; k2++) {
      if (k2 === fIdx) continue;
      for (let q2 = 0; q2 < 5; q2++) {
        const pairKey = `${fName}=q${qVal}, ${FACTORS[k2]}=q${q2}, ${side}`;
        // Score TRAIN
        const trainC: Cell = { n: 0, wins: 0, netSum: 0 };
        for (const t of trainTuples) {
          const v1 = t.factors[fIdx], v2 = t.factors[k2];
          if (!isFinite(v1) || !isFinite(v2)) continue;
          if (bucketOf(v1, trainQuintiles[fName as FactorName]) !== qVal) continue;
          if (bucketOf(v2, trainQuintiles[FACTORS[k2]]) !== q2) continue;
          const pnl = side === "L" ? t.pnlLong : t.pnlShort;
          trainC.n++;
          if (pnl > 0) trainC.wins++;
          trainC.netSum += pnl;
        }
        if (trainC.n < 200) continue;
        if (trainC.netSum / trainC.n < 0.5) continue;  // require strong TRAIN edge
        pairResults.push({ pairKey, train: trainC });
      }
    }
  }
  console.log(`  ${pairResults.length} pairs survived TRAIN edge filter (n ≥ 200 AND avg ≥ +$0.50)`);

  // ── Score TEST + W0 with TRAIN breakpoints ─────────────────────────────
  console.log(`\n── Scoring TRAIN survivors on TEST + W0 (locked TRAIN breakpoints) ──`);
  for (const pr of pairResults) {
    // Parse pairKey: "fA=qX, fB=qY, side"
    const parts = pr.pairKey.split(", ");
    const [fa, qa] = parts[0].split("=");
    const [fb, qb] = parts[1].split("=");
    const side = parts[2] as "L" | "S";
    const ia = FACTORS.indexOf(fa as FactorName);
    const ib = FACTORS.indexOf(fb as FactorName);
    const qaN = parseInt(qa.slice(1), 10), qbN = parseInt(qb.slice(1), 10);

    const score = (ts: Tuple[]): Cell => {
      const c: Cell = { n: 0, wins: 0, netSum: 0 };
      for (const t of ts) {
        const v1 = t.factors[ia], v2 = t.factors[ib];
        if (!isFinite(v1) || !isFinite(v2)) continue;
        if (bucketOf(v1, trainQuintiles[fa as FactorName]) !== qaN) continue;
        if (bucketOf(v2, trainQuintiles[fb as FactorName]) !== qbN) continue;
        const pnl = side === "L" ? t.pnlLong : t.pnlShort;
        c.n++;
        if (pnl > 0) c.wins++;
        c.netSum += pnl;
      }
      return c;
    };
    pr.test = score(testTuples);
    pr.w0 = score(w0Tuples);
  }

  // Filter to triple-positive
  const triplePositive = pairResults.filter(pr =>
    pr.train.netSum > 0 && pr.test && pr.test.netSum > 0 && pr.w0 && pr.w0.netSum > -50
  );
  // Rank by TRAIN avg (since other windows have smaller samples)
  triplePositive.sort((a, b) => (b.train.netSum / b.train.n) - (a.train.netSum / a.train.n));

  console.log(`\n${"pair (TRAIN-mined)".padEnd(60)} | ${"TRAIN".padEnd(22)} | ${"TEST".padEnd(22)} | ${"W0".padEnd(22)}`);
  console.log(`${"".padEnd(60)} | ${"n/WR/net/avg".padEnd(22)} | ${"n/WR/net/avg".padEnd(22)} | ${"n/WR/net/avg".padEnd(22)}`);
  for (const pr of triplePositive.slice(0, 30)) {
    const fmt = (c: Cell) => `${String(c.n).padStart(4)}/${(c.n ? c.wins / c.n * 100 : 0).toFixed(0).padStart(2)}%/$${c.netSum.toFixed(0).padStart(5)}/${(c.netSum / c.n).toFixed(2).padStart(5)}`;
    console.log(`${pr.pairKey.padEnd(60).slice(0, 60)} | ${fmt(pr.train)} | ${fmt(pr.test!)} | ${fmt(pr.w0!)}`);
  }
  console.log(`\n  ${triplePositive.length} pairs survived 3-window CV (net+ on TRAIN+TEST, W0 ≥ -$50)`);

  // Save survivor breakpoints + rules
  const survivors = triplePositive.slice(0, 30).map(pr => ({
    pairKey: pr.pairKey,
    train: { n: pr.train.n, wr: pr.train.wins / pr.train.n, net: pr.train.netSum, avg: pr.train.netSum / pr.train.n },
    test: { n: pr.test!.n, wr: pr.test!.n ? pr.test!.wins / pr.test!.n : 0, net: pr.test!.netSum, avg: pr.test!.n ? pr.test!.netSum / pr.test!.n : 0 },
    w0: { n: pr.w0!.n, wr: pr.w0!.n ? pr.w0!.wins / pr.w0!.n : 0, net: pr.w0!.netSum, avg: pr.w0!.n ? pr.w0!.netSum / pr.w0!.n : 0 },
  }));
  const outFile = path.join(RESULTS_DIR, "factor-mine-cv.json");
  fs.writeFileSync(outFile, JSON.stringify({
    trainQuintiles, factors: FACTORS, survivors, windows: WINDOWS,
  }, null, 2));
  console.log(`\nSaved → ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });

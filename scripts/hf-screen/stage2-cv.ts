// Stage 2 — 3-window cross-validation on Bucket 10 survivors + near-misses.
//
// Windows:
//   TRAIN: 2025-05-26 → 2025-12-31 (~7 mo)
//   TEST:  2026-01-01 → 2026-04-30 (4 mo)
//   W0:    2026-05-01 → 2026-05-25 (most recent ~25 days)
//
// Keep only strategies that are net-positive in ALL 3 windows. Then per-asset
// breakdown shows which assets carry the edge for the survivor basket.
//
// Run: npx tsx scripts/hf-screen/stage2-cv.ts

import * as fs from "fs";
import * as path from "path";
import { Strategy, BarContext, ASSETS, CACHE_DIR, RESULTS_DIR, STAKE, LEV, COST_RT, TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR, load1m, roll, sma, ema, atr as atrFn, rsi as rsiFn, bb, alignTo1h, buildMinuteIdx } from "./lib";

// Re-import the 5 top composites that showed net-positive
function zscore(closes: number[], n: number, i: number): number | null {
  if (i < n) return null;
  let sum = 0;
  for (let j = i - n + 1; j <= i; j++) sum += closes[j];
  const m = sum / n;
  let v = 0;
  for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) ** 2;
  const sd = Math.sqrt(v / n);
  if (sd === 0) return null;
  return (closes[i] - m) / sd;
}
function priorHighLow(bars: any[], i: number, n: number): { hh: number; ll: number } {
  let hh = -Infinity, ll = Infinity;
  for (let j = i - n; j < i; j++) {
    if (bars[j].high > hh) hh = bars[j].high;
    if (bars[j].low < ll) ll = bars[j].low;
  }
  return { hh, ll };
}

type StrategyDef = {
  id: string; name: string;
  // Returns "LONG" / "SHORT" / null. Has access to: bars15m, i, closes15m, bars1h, i1h,
  // pre-computed: atr14, atrPct, rsi14, bbWidthPct, bbObj, ema50_1h, hourUtc
  fn: (ctx: any) => "LONG" | "SHORT" | null;
};

const STRATS: StrategyDef[] = [
  {
    id: "B10-01",
    name: "B9-03 + ATR percentile > 60",
    fn: (c) => {
      const z = zscore(c.closes15m, 50, c.i);
      if (z === null) return null;
      if (c.atrPct < 0.60) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull) return "LONG";
      if (z > 1.5 && !bull) return "SHORT";
      return null;
    },
  },
  {
    id: "B10-02",
    name: "B9-03 + hour ∈ {12..22 UTC}",
    fn: (c) => {
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      const z = zscore(c.closes15m, 50, c.i);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull) return "LONG";
      if (z > 1.5 && !bull) return "SHORT";
      return null;
    },
  },
  {
    id: "B10-04",
    name: "B7-09 + 1h trend (ATR contraction + Donchian + HTF)",
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
      const { hh, ll } = priorHighLow(c.bars15m, c.i, 10);
      const b = c.bars15m[c.i];
      if (!isFinite(c.ema50_1h)) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (b.close > hh && bull) return "LONG";
      if (b.close < ll && !bull) return "SHORT";
      return null;
    },
  },
  {
    id: "B10-07",
    name: "Z(50) + 1h trend + RSI extreme + hour (4-stack)",
    fn: (c) => {
      const z = zscore(c.closes15m, 50, c.i);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h) || !isFinite(c.rsi14)) return null;
      if (c.hourUtc < 12 || c.hourUtc > 22) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      if (z < -1.5 && bull && c.rsi14 < 35) return "LONG";
      if (z > 1.5 && !bull && c.rsi14 > 65) return "SHORT";
      return null;
    },
  },
  {
    id: "B10-10",
    name: "Z(50) + 1h trend + ATR>median + confirmation candle",
    fn: (c) => {
      const z = zscore(c.closes15m, 50, c.i);
      if (z === null) return null;
      if (!isFinite(c.ema50_1h)) return null;
      if (c.atrPct < 0.50) return null;
      const bull = c.bars1h[c.i1h].close > c.ema50_1h;
      const b = c.bars15m[c.i];
      if (z < -1.5 && bull && b.close > b.open) return "LONG";
      if (z > 1.5 && !bull && b.close < b.open) return "SHORT";
      return null;
    },
  },
];

const WINDOWS = [
  { id: "TRAIN", start: "2025-05-26", end: "2025-12-31" },
  { id: "TEST",  start: "2026-01-01", end: "2026-04-30" },
  { id: "W0",    start: "2026-05-01", end: "2026-05-25" },
];

function doSim(bars1m: any[], startIdx: number, entry: number, atrVal: number, side: "LONG"|"SHORT") {
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

async function main() {
  // Load FULL window once per asset; reuse across windows.
  const fullFrom = Math.floor(new Date("2025-04-01").getTime() / 1000);
  const fullTo = Math.floor(new Date("2026-05-31").getTime() / 1000);

  const winFromTo = WINDOWS.map(w => ({
    id: w.id, label: `${w.start}→${w.end}`,
    from: Math.floor(new Date(w.start).getTime() / 1000),
    to: Math.floor(new Date(w.end).getTime() / 1000),
  }));

  // Results matrix: strategy × window → {trades, wins, net}
  const grid: Record<string, Record<string, { trades: number; wins: number; net: number; perAsset: Record<string, { n: number; w: number; net: number }> }>> = {};
  for (const s of STRATS) {
    grid[s.id] = {};
    for (const w of winFromTo) grid[s.id][w.id] = { trades: 0, wins: 0, net: 0, perAsset: {} };
  }

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
    const vols15m = bars15m.map(b => b.volume);
    const bbObjArr: ({ mid: number; upper: number; lower: number } | null)[] = [];
    const atrArr: number[] = [], rsiArr: number[] = [], ema50_1hArr: number[] = [], bbWidthArr: number[] = [];
    for (let i = 0; i < bars15m.length; i++) {
      const b = bb(closes15m, 20, 2.0, i);
      bbObjArr.push(b);
      bbWidthArr.push(b ? (b.upper - b.lower) / b.mid : NaN);
      atrArr.push(atrFn(bars15m, 14, i));
      rsiArr.push(rsiFn(closes15m, 14, i));
    }
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr.push(ema(closes1h, 50, i));

    let processed = 0;
    for (let i = 60; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      // Which window?
      let win: typeof winFromTo[0] | null = null;
      for (const w of winFromTo) if (b.epoch >= w.from && b.epoch <= w.to) { win = w; break; }
      if (!win) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 0) continue;

      // bbWidth percentile (60 bar) and ATR percentile
      const bbSlice: number[] = []; const atrSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) {
        if (isFinite(bbWidthArr[j])) bbSlice.push(bbWidthArr[j]);
        if (isFinite(atrArr[j])) atrSlice.push(atrArr[j]);
      }
      const atrPct = atrSlice.length ? atrSlice.filter(x => x <= atrArr[i]).length / atrSlice.length : 0.5;
      const bbWidthPct = bbSlice.length ? bbSlice.filter(x => x <= bbWidthArr[i]).length / bbSlice.length : 0.5;
      const d = new Date(b.epoch * 1000);

      const ctx = {
        asset: sym, bars15m, i, bars1h, i1h, closes15m,
        atr14: atrArr[i], atrPct, rsi14: rsiArr[i],
        bbObj: bbObjArr[i], bbWidthPct,
        ema50_1h: ema50_1hArr[i1h],
        hourUtc: d.getUTCHours(),
      };

      for (const strat of STRATS) {
        const side = strat.fn(ctx);
        if (!side) continue;
        const next = bars15m[i + 1];
        if (!next) continue;
        const entry = next.open;
        const startIdx = minMap.get(next.epoch);
        if (startIdx === undefined) continue;
        const exit = doSim(bars1m, startIdx, entry, atrArr[i], side);
        const grossPct = side === "LONG" ? (exit.exit - entry) / entry : (entry - exit.exit) / entry;
        const netPct = grossPct - COST_RT;
        const pnl = STAKE * LEV * netPct;
        const g = grid[strat.id][win.id];
        g.trades++;
        if (pnl > 0) g.wins++;
        g.net += pnl;
        if (!g.perAsset[sym]) g.perAsset[sym] = { n: 0, w: 0, net: 0 };
        g.perAsset[sym].n++;
        if (pnl > 0) g.perAsset[sym].w++;
        g.perAsset[sym].net += pnl;
        processed++;
      }
    }
    console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s — ${processed} trades`);
  }

  console.log(`\n══ Stage 2 — 3-window CV ══\n`);
  console.log(`Window       TRAIN(${WINDOWS[0].start}→${WINDOWS[0].end})    TEST(${WINDOWS[1].start}→${WINDOWS[1].end})    W0(${WINDOWS[2].start}→${WINDOWS[2].end})\n`);
  console.log(`${"id".padEnd(10)} ${"strat".padEnd(50)} | TRAIN n/WR/net  | TEST n/WR/net | W0 n/WR/net  | verdict`);
  const verdicts: { id: string; passed: boolean; train: any; test: any; w0: any }[] = [];
  for (const s of STRATS) {
    const t = grid[s.id]["TRAIN"];
    const e = grid[s.id]["TEST"];
    const w = grid[s.id]["W0"];
    const fmt = (g: any) => `${String(g.trades).padStart(4)}/${(g.trades ? g.wins / g.trades * 100 : 0).toFixed(0).padStart(2)}%/$${g.net.toFixed(0).padStart(5)}`;
    const passed = t.net > 0 && e.net > 0 && w.net > -50;  // W0 small-sample slack
    verdicts.push({ id: s.id, passed, train: t, test: e, w0: w });
    console.log(`${s.id.padEnd(10)} ${s.name.padEnd(50).slice(0, 50)} | ${fmt(t)} | ${fmt(e)} | ${fmt(w)} | ${passed ? "✓ PASS" : "✗ fail"}`);
  }

  console.log(`\n══ Survivors (all windows net-positive, W0 slack ≤$50) ══\n`);
  for (const v of verdicts.filter(x => x.passed)) {
    const strat = STRATS.find(s => s.id === v.id)!;
    console.log(`\n  ✓ ${v.id}  ${strat.name}`);
    // Per-asset breakdown across all windows
    const aggAsset: Record<string, { n: number; w: number; net: number }> = {};
    for (const winId of ["TRAIN", "TEST", "W0"]) {
      const pa = grid[v.id][winId].perAsset;
      for (const sym of Object.keys(pa)) {
        if (!aggAsset[sym]) aggAsset[sym] = { n: 0, w: 0, net: 0 };
        aggAsset[sym].n += pa[sym].n;
        aggAsset[sym].w += pa[sym].w;
        aggAsset[sym].net += pa[sym].net;
      }
    }
    const sorted = Object.entries(aggAsset).sort((a, b) => b[1].net - a[1].net);
    for (const [sym, st] of sorted) {
      const wr = st.n ? st.w / st.n * 100 : 0;
      console.log(`    ${sym.padEnd(10)} n=${String(st.n).padStart(4)} WR=${wr.toFixed(0).padStart(2)}% net=$${st.net.toFixed(0).padStart(6)}`);
    }
  }
  if (verdicts.filter(x => x.passed).length === 0) console.log(`  (none passed)`);

  fs.writeFileSync(path.join(RESULTS_DIR, "stage2-cv.json"), JSON.stringify({ windows: WINDOWS, grid, verdicts }, null, 2));
  console.log(`\nSaved → ${path.join(RESULTS_DIR, "stage2-cv.json")}`);
}

main().catch(e => { console.error(e); process.exit(1); });

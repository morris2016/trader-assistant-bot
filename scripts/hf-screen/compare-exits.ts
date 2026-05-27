// Compare 4 variants of the mined HF stack over the full 37-month dataset:
//
//                     │ Trail-arm exit         │ Fixed TP/SL exit (2:1 RR)
//   ──────────────────┼────────────────────────┼──────────────────────────
//   UNFILTERED        │ all M1..M5, uniform $20│ all M1..M5, uniform $20
//   FILTERED + SIZED  │ strength-quintile gate │ strength-quintile gate
//                     │ + 0.75-1.5× stake mult │ + 0.75-1.5× stake mult
//
// Trail-arm exit: arm at +1×ATR favorable, exit at peak − 0.3×ATR retrace,
//                 hard SL at 1×ATR adverse, 4h timeout.
// Fixed-RR exit:  TP at +2×ATR, SL at −1×ATR, 4h timeout, no trail.
//
// Run: NODE_OPTIONS="--max-old-space-size=12288" npx tsx scripts/hf-screen/compare-exits.ts

import * as fs from "fs";
import {
  ASSETS, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
const START_WALLET = 100;
const BASE_STAKE = 20;
const TP_ATR = 2.0;
const SL_ATR_FIXED = 1.0;

const WINDOW_START = Math.floor(new Date("2023-05-01T00:00:00Z").getTime() / 1000);
const WINDOW_END   = Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000);
const TRAIN_FROM = Math.floor(new Date("2025-05-26T00:00:00Z").getTime() / 1000);
const TRAIN_TO   = Math.floor(new Date("2025-12-31T23:59:59Z").getTime() / 1000);

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;
function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";
const RULES = [
  { id: "M1", check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 4 && bucketOf(f.z100, Q.z100) === 0 ? "LONG" : null,
    strength: (f: any) => Math.max(0, -1.29 - f.z100) + Math.max(0, f.htf4hRet) * 10 },
  { id: "M2", check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z100, Q.z100) === 2 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, -0.0235 - f.htf4hRet) * 10 },
  { id: "M3", check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 1 && bucketOf(f.z100, Q.z100) === 3 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 0.46) + Math.max(0, -0.0059 - f.htf4hRet) * 10 },
  { id: "M4", check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 2 && bucketOf(f.z100, Q.z100) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 1.29) },
  { id: "M5", check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z50, Q.z50) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z50 - 1.28) + Math.max(0, -0.0235 - f.htf4hRet) * 10 },
];
const SCHEDULE: Record<string, Array<number | undefined>> = {
  M1: [undefined, undefined, 1.0, 1.25, 1.5],
  M2: [1.25, 1.25, 1.25, 1.25, undefined],
  M3: [undefined, undefined, 1.0, 1.25, 1.5],
  M4: [undefined, undefined, 1.0, 1.25, 1.5],
  M5: [1.0, 1.0, undefined, undefined, undefined],
};

type Signal = {
  asset: string; ruleId: string; side: Side;
  nextBarEpoch: number; entryPx: number; atr: number;
  strength: number;
  qstrFilter: number;             // strength quintile for filter (from TRAIN-only breakpoints)
  stakeMultFiltered: number | undefined;
  // Precomputed exit outcomes (per $1 of stake × lev=1 — caller scales):
  trailExitPx: number; trailArmed: boolean;
  fixedExitPx: number; fixedReason: "tp" | "sl" | "timeout";
};

function simTrail(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): { exitPx: number; armed: boolean } {
  const armD = TRAIL_ARM_ATR * atr, trailD = TRAIL_RETRACE_ATR * atr, slD = HARD_SL_ATR * atr;
  const slPrice = side === "LONG" ? entry - slD : entry + slD;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPrice) return { exitPx: slPrice, armed };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armD) armed = true;
      if (armed && b.low <= peak - trailD) return { exitPx: peak - trailD, armed: true };
    } else {
      if (b.high >= slPrice) return { exitPx: slPrice, armed };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armD) armed = true;
      if (armed && b.high >= peak + trailD) return { exitPx: peak + trailD, armed: true };
    }
  }
  return { exitPx: bars1m[maxIdx].close, armed };
}

function simFixedRR(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): { exitPx: number; reason: "tp" | "sl" | "timeout" } {
  const tpD = TP_ATR * atr, slD = SL_ATR_FIXED * atr;
  const tpPx = side === "LONG" ? entry + tpD : entry - tpD;
  const slPx = side === "LONG" ? entry - slD : entry + slD;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      // Same-bar collision: if both TP and SL touched in one bar, conservatively assume SL hit first.
      if (b.low <= slPx) return { exitPx: slPx, reason: "sl" };
      if (b.high >= tpPx) return { exitPx: tpPx, reason: "tp" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, reason: "sl" };
      if (b.low <= tpPx) return { exitPx: tpPx, reason: "tp" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, reason: "timeout" };
}

async function main() {
  console.log(`\n══ 4-variant exit comparison — 37 months (May 2023 → May 2026) ══`);
  console.log(`Wallet $${START_WALLET}, base stake $${BASE_STAKE}, per-asset max lev`);
  console.log(`Trail exit: arm 1×ATR, retrace 0.3×ATR, hard SL 1×ATR, 4h timeout`);
  console.log(`Fixed RR exit: TP +${TP_ATR}×ATR, SL −${SL_ATR_FIXED}×ATR, 4h timeout (no trail)\n`);

  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();
  // Step 1: load + generate all signals + precompute both exits per signal
  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const t0 = Date.now();
    const bars1m = load1m(sym, WINDOW_START - 30 * 86400, WINDOW_END);
    if (bars1m.length === 0) { console.log("no data"); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);
    const atrArr = new Float64Array(bars15m.length);
    const ema50_1hArr = new Float64Array(bars1h.length);
    for (let i = 0; i < bars15m.length; i++) atrArr[i] = atrFn(bars15m, 14, i);
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = emaFn(closes1h, 50, i);

    const signals: Signal[] = [];
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 50) continue;
      const zN = (n: number) => {
        let s = 0; for (let j = i - n + 1; j <= i; j++) s += closes15m[j];
        const m = s / n;
        let v = 0; for (let j = i - n + 1; j <= i; j++) v += (closes15m[j] - m) ** 2;
        const sd = Math.sqrt(v / n);
        return sd === 0 ? 0 : (closes15m[i] - m) / sd;
      };
      const f = {
        z50: zN(50), z100: zN(100),
        htf1hTrend: isFinite(ema50_1hArr[i1h]) ? (closes1h[i1h] > ema50_1hArr[i1h] ? 1 : 0) : 0.5,
        htf4hRet: (closes1h[i1h] - closes1h[Math.max(0, i1h - 16)]) / closes1h[Math.max(0, i1h - 16)],
      };
      for (const rule of RULES) {
        const side = rule.check(f);
        if (!side) continue;
        const next = bars15m[i + 1];
        const startIdx = minMap.get(next.epoch);
        if (startIdx === undefined) continue;
        const entry = next.open;
        const trail = simTrail(bars1m, startIdx, entry, atrArr[i], side);
        const fixed = simFixedRR(bars1m, startIdx, entry, atrArr[i], side);
        signals.push({
          asset: sym, ruleId: rule.id, side,
          nextBarEpoch: next.epoch, entryPx: entry, atr: atrArr[i],
          strength: rule.strength(f),
          qstrFilter: -1, stakeMultFiltered: undefined,
          trailExitPx: trail.exitPx, trailArmed: trail.armed,
          fixedExitPx: fixed.exitPx, fixedReason: fixed.reason,
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
    console.log(`${signals.length} signals in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // Step 2: TRAIN-only strength quintile breakpoints, attach qstr + stakeMult
  const breaks: Record<string, number[]> = {};
  for (const rule of RULES) {
    const ss: number[] = [];
    for (const d of assetData.values()) for (const s of d.signals) if (s.ruleId === rule.id && s.nextBarEpoch >= TRAIN_FROM && s.nextBarEpoch <= TRAIN_TO) ss.push(s.strength);
    ss.sort((a, b) => a - b);
    if (ss.length === 0) continue;
    breaks[rule.id] = [ss[Math.floor(ss.length * 0.2)], ss[Math.floor(ss.length * 0.4)], ss[Math.floor(ss.length * 0.6)], ss[Math.floor(ss.length * 0.8)]];
  }
  for (const d of assetData.values()) {
    for (const s of d.signals) {
      const b = breaks[s.ruleId]; if (!b) continue;
      let q = 0; for (const t of b) if (s.strength >= t) q++;
      s.qstrFilter = q;
      s.stakeMultFiltered = SCHEDULE[s.ruleId][q];
    }
  }

  // Step 3: walk wallet sim per variant (compounding, 37 months continuous)
  type Variant = { id: string; useFilter: boolean; exit: "trail" | "fixed" };
  const variants: Variant[] = [
    { id: "Unfiltered + Trail-arm",   useFilter: false, exit: "trail" },
    { id: "Filtered + Trail-arm",     useFilter: true,  exit: "trail" },
    { id: "Unfiltered + Fixed 2:1 RR",useFilter: false, exit: "fixed" },
    { id: "Filtered + Fixed 2:1 RR",  useFilter: true,  exit: "fixed" },
  ];

  type Stat = { wallet: number; locked: number; trades: number; wins: number; net: number; maxEquity: number; minSincePeak: number; maxDD: number; openCount: number };

  function runVariant(v: Variant): Stat & { byRule: Record<string, { n: number; w: number; net: number }>; monthsPos: number; monthsNeg: number; monthsTotal: number; bestMonth: number; worstMonth: number } {
    let wallet = START_WALLET, locked = 0, trades = 0, wins = 0, net = 0;
    let peak = START_WALLET, minSincePeak = START_WALLET, maxDD = 0, maxEq = START_WALLET;
    type Op = { ruleId: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; trailExitPx: number; trailArmed: boolean; fixedExitPx: number };
    const open: Op[] = [];
    const byRule: Record<string, { n: number; w: number; net: number }> = {};
    const monthPnl: Record<string, number> = {};
    // build epoch timeline + signal-by-epoch index
    const sigsAll: { sig: Signal; openEpoch: number }[] = [];
    for (const d of assetData.values()) for (const s of d.signals) {
      if (s.nextBarEpoch < WINDOW_START || s.nextBarEpoch >= WINDOW_END) continue;
      if (v.useFilter && s.stakeMultFiltered === undefined) continue;
      sigsAll.push({ sig: s, openEpoch: s.nextBarEpoch });
    }
    sigsAll.sort((a, b) => a.openEpoch - b.openEpoch);

    // For each signal: open immediately (entry already at nextBarEpoch open price).
    // Close at the precomputed exit price (either trail or fixed depending on variant).
    // We don't need a minute-by-minute loop since each trade's exit is already
    // known — but we DO need to respect wallet/margin/dup-key gating at the
    // moment of signal firing.
    //
    // The dup-key check needs the open list's state AT the time of the new
    // signal. We process signals in chronological order; between processing
    // signal N and signal N+1, we close any positions whose exit epoch is ≤
    // signal N+1's openEpoch.
    //
    // For dup-key + concurrent-margin, we need an exit-epoch estimate. Since
    // the precomputed exit doesn't give us the exit epoch, we approximate by
    // assuming each trade holds for the AVERAGE hold time. To stay honest
    // and conservative, we use a simpler model: the trade locks $stake from
    // openEpoch until min(openEpoch + HARD_TIMEOUT, exitFound). We re-walk
    // 1m bars to find exact exit-epoch per trade.
    //
    // Performance: this re-uses the bars1m + minMap already in memory.

    // Compute exit epoch per trade by re-walking. This is the cost; it's done
    // once per trade, fast since maxIdx - startIdx ≤ 240 bars.
    function findExitEpoch(sig: Signal): number {
      const data = assetData.get(sig.asset)!;
      const startIdx = data.minMap.get(sig.nextBarEpoch);
      if (startIdx === undefined) return sig.nextBarEpoch + HARD_TIMEOUT_MIN * 60;
      const bars1m = data.bars1m;
      const atr = sig.atr;
      if (v.exit === "trail") {
        const armD = TRAIL_ARM_ATR * atr, trailD = TRAIL_RETRACE_ATR * atr, slD = HARD_SL_ATR * atr;
        const slPx = sig.side === "LONG" ? sig.entryPx - slD : sig.entryPx + slD;
        let peakLocal = sig.entryPx, armed = false;
        const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
        for (let i = startIdx + 1; i <= maxIdx; i++) {
          const b = bars1m[i];
          if (sig.side === "LONG") {
            if (b.low <= slPx) return b.epoch;
            if (b.high > peakLocal) peakLocal = b.high;
            if (!armed && peakLocal >= sig.entryPx + armD) armed = true;
            if (armed && b.low <= peakLocal - trailD) return b.epoch;
          } else {
            if (b.high >= slPx) return b.epoch;
            if (b.low < peakLocal) peakLocal = b.low;
            if (!armed && peakLocal <= sig.entryPx - armD) armed = true;
            if (armed && b.high >= peakLocal + trailD) return b.epoch;
          }
        }
        return bars1m[maxIdx].epoch;
      } else {
        const tpD = TP_ATR * atr, slD = SL_ATR_FIXED * atr;
        const tpPx = sig.side === "LONG" ? sig.entryPx + tpD : sig.entryPx - tpD;
        const slPx = sig.side === "LONG" ? sig.entryPx - slD : sig.entryPx + slD;
        const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
        for (let i = startIdx + 1; i <= maxIdx; i++) {
          const b = bars1m[i];
          if (sig.side === "LONG") {
            if (b.low <= slPx) return b.epoch;
            if (b.high >= tpPx) return b.epoch;
          } else {
            if (b.high >= slPx) return b.epoch;
            if (b.low <= tpPx) return b.epoch;
          }
        }
        return bars1m[maxIdx].epoch;
      }
    }

    // Walk signals chronologically. Maintain open positions. Close any open
    // whose exit-epoch ≤ next signal's open-epoch. Then evaluate the new
    // signal (dup-key + wallet check) and open if allowed.
    type OpExt = Op & { exitEpoch: number };
    const openExt: OpExt[] = [];

    function settleClose(p: OpExt) {
      const exitPx = v.exit === "trail" ? p.trailExitPx : p.fixedExitPx;
      const gross = p.side === "LONG" ? (exitPx - p.entry) / p.entry : (p.entry - exitPx) / p.entry;
      const pnl = p.stake * p.lev * (gross - COST_RT);
      wallet += p.stake + pnl; locked -= p.stake;
      trades++; if (pnl > 0) wins++; net += pnl;
      const r = p.ruleId; if (!byRule[r]) byRule[r] = { n: 0, w: 0, net: 0 };
      byRule[r].n++; if (pnl > 0) byRule[r].w++; byRule[r].net += pnl;
      const month = new Date(p.openEpoch * 1000).toISOString().slice(0, 7);
      monthPnl[month] = (monthPnl[month] ?? 0) + pnl;
      const eq = wallet + locked;
      if (eq > peak) { peak = eq; minSincePeak = eq; }
      if (eq < minSincePeak) minSincePeak = eq;
      const dd = (peak - minSincePeak) / peak;
      if (dd > maxDD) maxDD = dd;
      if (eq > maxEq) maxEq = eq;
    }

    for (const { sig, openEpoch } of sigsAll) {
      // Close any open positions whose exit is ≤ this signal's open epoch
      for (let i = openExt.length - 1; i >= 0; i--) {
        if (openExt[i].exitEpoch <= openEpoch) {
          settleClose(openExt[i]);
          openExt.splice(i, 1);
        }
      }
      // Try open new
      const mult = v.useFilter ? (sig.stakeMultFiltered ?? 1) : 1;
      const stake = BASE_STAKE * mult;
      if (wallet < stake) continue;
      if (openExt.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      const exitEpoch = findExitEpoch(sig);
      openExt.push({
        ruleId: sig.ruleId, asset: sig.asset, side: sig.side,
        entry: sig.entryPx, atr: sig.atr, lev, openEpoch,
        stake, trailExitPx: sig.trailExitPx, trailArmed: sig.trailArmed, fixedExitPx: sig.fixedExitPx,
        exitEpoch,
      });
      wallet -= stake; locked += stake;
    }
    // Close any remaining open at their exit epoch
    for (const p of openExt) settleClose(p);

    // Monthly distribution
    const months = Object.keys(monthPnl).sort();
    let monthsPos = 0, monthsNeg = 0, bestMonth = -Infinity, worstMonth = Infinity;
    for (const m of months) {
      const v = monthPnl[m];
      if (v > 0) monthsPos++; else if (v < 0) monthsNeg++;
      if (v > bestMonth) bestMonth = v;
      if (v < worstMonth) worstMonth = v;
    }

    return { wallet, locked, trades, wins, net, maxEquity: maxEq, minSincePeak, maxDD, openCount: openExt.length, byRule, monthsTotal: months.length, monthsPos, monthsNeg, bestMonth, worstMonth };
  }

  // Run all 4 variants
  const results = new Map<string, ReturnType<typeof runVariant>>();
  for (const v of variants) {
    process.stdout.write(`\nRunning: ${v.id}... `);
    const t0 = Date.now();
    const r = runVariant(v);
    results.set(v.id, r);
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s — wallet $${r.wallet.toFixed(2)}, trades ${r.trades}, WR ${(r.wins / r.trades * 100).toFixed(1)}%, maxDD ${(r.maxDD * 100).toFixed(1)}%`);
  }

  // Final comparison table
  console.log(`\n\n══ COMPARISON ══\n`);
  console.log(`${"Variant".padEnd(30)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"Net $".padStart(10)} ${"End $".padStart(10)} ${"Peak $".padStart(10)} ${"MaxDD".padStart(7)} ${"Months+".padStart(8)}/${"−".padStart(2)}`);
  for (const v of variants) {
    const r = results.get(v.id)!;
    const wr = r.trades ? r.wins / r.trades * 100 : 0;
    console.log(`${v.id.padEnd(30)} ${String(r.trades).padStart(7)} ${wr.toFixed(1).padStart(6)} ${r.net.toFixed(2).padStart(10)} ${r.wallet.toFixed(2).padStart(10)} ${r.maxEquity.toFixed(2).padStart(10)} ${(r.maxDD * 100).toFixed(1).padStart(6)}% ${String(r.monthsPos).padStart(7)}/${String(r.monthsNeg).padStart(2)}`);
  }
  console.log(`\nPer-rule breakdown:`);
  console.log(`${"Variant".padEnd(30)} ${"M1".padStart(11)} ${"M2".padStart(11)} ${"M3".padStart(11)} ${"M4".padStart(11)} ${"M5".padStart(11)}`);
  for (const v of variants) {
    const r = results.get(v.id)!;
    const fmt = (rid: string) => {
      const s = r.byRule[rid];
      return s ? `${s.n}/${(s.w/s.n*100).toFixed(0)}%/$${s.net.toFixed(0)}` : "-";
    };
    console.log(`${v.id.padEnd(30)} ${fmt("M1").padStart(11)} ${fmt("M2").padStart(11)} ${fmt("M3").padStart(11)} ${fmt("M4").padStart(11)} ${fmt("M5").padStart(11)}`);
  }

  fs.writeFileSync(`${RESULTS_DIR}/compare-exits.json`, JSON.stringify(Object.fromEntries(results), null, 2));
  console.log(`\nSaved → ${RESULTS_DIR}/compare-exits.json`);
}

main().catch(e => { console.error(e); process.exit(1); });

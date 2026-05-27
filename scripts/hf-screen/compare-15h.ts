// Compare 4 variants over the last 15 hours.
// Loads only the recent window + 30d warmup for indicators.
// Uses hardcoded TRAIN-derived strength breakpoints (no in-script recompute).
//
// Run: npx tsx scripts/hf-screen/compare-15h.ts

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

// Window ending now. Default 15h, override via HOURS env (e.g. HOURS=24).
const HOURS_BACK = +(process.env.HOURS ?? "15");
const NOW = Math.floor(Date.now() / 1000);
const WIN_START = NOW - HOURS_BACK * 3600;
const WIN_END = NOW + 60;

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;
function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

// TRAIN-derived strength quintile breakpoints (hardcoded — see dump-strength-breaks.ts)
const STRENGTH_BREAKS: Record<string, number[]> = {
  M1: [0.098081, 0.206674, 0.369093, 0.648186],
  M2: [0.023435, 0.050112, 0.088686, 0.147909],
  M3: [0.113817, 0.205593, 0.319585, 0.480758],
  M4: [0.088573, 0.210573, 0.364843, 0.640640],
  M5: [0.209156, 0.360243, 0.544899, 0.888320],
};
const SCHEDULE: Record<string, Array<number | undefined>> = {
  M1: [undefined, undefined, 1.0, 1.25, 1.5],
  M2: [1.25, 1.25, 1.25, 1.25, undefined],
  M3: [undefined, undefined, 1.0, 1.25, 1.5],
  M4: [undefined, undefined, 1.0, 1.25, 1.5],
  M5: [1.0, 1.0, undefined, undefined, undefined],
};

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

type Signal = {
  asset: string; ruleId: string; side: Side;
  nextBarEpoch: number; entryPx: number; atr: number;
  strength: number; qstr: number; stakeMultFiltered: number | undefined;
};

type Trade = {
  asset: string; ruleId: string; side: Side; entryPx: number; exitPx: number;
  openEpoch: number; closeEpoch: number; pnl: number; stake: number; lev: number;
  reason: string;
};

function simTrail(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): { exitPx: number; armed: boolean; closeEpoch: number; reason: string } {
  const armD = TRAIL_ARM_ATR * atr, trailD = TRAIL_RETRACE_ATR * atr, slD = HARD_SL_ATR * atr;
  const slPx = side === "LONG" ? entry - slD : entry + slD;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPx) return { exitPx: slPx, armed, closeEpoch: b.epoch, reason: "SL" };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armD) armed = true;
      if (armed && b.low <= peak - trailD) return { exitPx: peak - trailD, armed: true, closeEpoch: b.epoch, reason: "trail" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, armed, closeEpoch: b.epoch, reason: "SL" };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armD) armed = true;
      if (armed && b.high >= peak + trailD) return { exitPx: peak + trailD, armed: true, closeEpoch: b.epoch, reason: "trail" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, armed, closeEpoch: bars1m[maxIdx].epoch, reason: "timeout" };
}

// Hybrid: trail-arm + TP cap + hard SL. Within a 1m bar, the priority is
// (1) SL → adverse, exits first; (2) TP → realistic limit-order priority
// since a TP at exchange fires the moment price crosses it on the way up;
// (3) trail-armed retrace → only fires if TP wasn't hit this bar.
function simHybrid(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side, retraceMult = TRAIL_RETRACE_ATR): { exitPx: number; closeEpoch: number; reason: string } {
  const armD = TRAIL_ARM_ATR * atr, trailD = retraceMult * atr, slD = HARD_SL_ATR * atr;
  const tpD = TP_ATR * atr;
  const slPx = side === "LONG" ? entry - slD : entry + slD;
  const tpPx = side === "LONG" ? entry + tpD : entry - tpD;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.high >= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armD) armed = true;
      if (armed && b.low <= peak - trailD) return { exitPx: peak - trailD, closeEpoch: b.epoch, reason: "trail" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.low <= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armD) armed = true;
      if (armed && b.high >= peak + trailD) return { exitPx: peak + trailD, closeEpoch: b.epoch, reason: "trail" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason: "timeout" };
}

function simFixedRR(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): { exitPx: number; closeEpoch: number; reason: string } {
  const tpD = TP_ATR * atr, slD = SL_ATR_FIXED * atr;
  const tpPx = side === "LONG" ? entry + tpD : entry - tpD;
  const slPx = side === "LONG" ? entry - slD : entry + slD;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.high >= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.low <= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason: "timeout" };
}

async function main() {
  const startStr = new Date(WIN_START * 1000).toISOString().slice(0, 16).replace("T", " ");
  const endStr = new Date(WIN_END * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`\n══ Last-${HOURS_BACK}h comparison (${startStr} → ${endStr} UTC) ══`);
  console.log(`$${START_WALLET} wallet, $${BASE_STAKE} base stake, per-asset max lev\n`);

  // Step 1: load all assets (with 30d warmup) + generate signals in window
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();
  for (const sym of ASSETS) {
    const bars1m = load1m(sym, WIN_START - 30 * 86400, WIN_END);
    if (bars1m.length === 0) continue;
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
      if (b.epoch < WIN_START || b.epoch >= WIN_END) continue;
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
        const strength = rule.strength(f);
        const qstr = bucketOf(strength, STRENGTH_BREAKS[rule.id]);
        signals.push({
          asset: sym, ruleId: rule.id, side,
          nextBarEpoch: next.epoch, entryPx: next.open, atr: atrArr[i],
          strength, qstr, stakeMultFiltered: SCHEDULE[rule.id][qstr],
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
  }

  // Total signals
  let totalSigs = 0;
  for (const d of assetData.values()) totalSigs += d.signals.length;
  console.log(`Total M1..M5 signals fired in window: ${totalSigs}\n`);
  if (totalSigs === 0) {
    console.log(`(No signals fired in the last 15 hours — flat regime.)`);
    return;
  }

  // Step 2: run each of 4 variants
  type Variant = { id: string; filter: boolean; exit: "trail" | "fixed" | "hybrid"; retraceMult?: number };
  const variants: Variant[] = [
    { id: "Unfiltered + Trail-arm",         filter: false, exit: "trail" },
    { id: "Filtered + Trail-arm",           filter: true,  exit: "trail" },
    { id: "Unfiltered + Fixed 2:1",         filter: false, exit: "fixed" },
    { id: "Filtered + Fixed 2:1",           filter: true,  exit: "fixed" },
    { id: "Unfiltered + Hybrid(retr 0.3)",  filter: false, exit: "hybrid", retraceMult: 0.3 },
    { id: "Filtered + Hybrid(retr 0.3)",    filter: true,  exit: "hybrid", retraceMult: 0.3 },
    { id: "Unfiltered + Hybrid(retr 0.7)",  filter: false, exit: "hybrid", retraceMult: 0.7 },
    { id: "Filtered + Hybrid(retr 0.7)",    filter: true,  exit: "hybrid", retraceMult: 0.7 },
    { id: "Unfiltered + Hybrid(retr 1.0)",  filter: false, exit: "hybrid", retraceMult: 1.0 },
    { id: "Filtered + Hybrid(retr 1.0)",    filter: true,  exit: "hybrid", retraceMult: 1.0 },
  ];

  function runVariant(v: Variant): { trades: Trade[]; wallet: number } {
    let wallet = START_WALLET, locked = 0;
    type Op = { asset: string; ruleId: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; closeEpoch: number; stake: number; exitPx: number; reason: string };
    const open: Op[] = [];
    const closedTrades: Trade[] = [];
    // Sort signals by entry epoch
    const sigsAll: Signal[] = [];
    for (const d of assetData.values()) for (const s of d.signals) {
      if (v.filter && s.stakeMultFiltered === undefined) continue;
      sigsAll.push(s);
    }
    sigsAll.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);

    for (const sig of sigsAll) {
      // Close any positions whose closeEpoch ≤ this entry
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].closeEpoch <= sig.nextBarEpoch) {
          const p = open[i];
          const gross = p.side === "LONG" ? (p.exitPx - p.entry) / p.entry : (p.entry - p.exitPx) / p.entry;
          const pnl = p.stake * p.lev * (gross - COST_RT);
          wallet += p.stake + pnl; locked -= p.stake;
          closedTrades.push({
            asset: p.asset, ruleId: p.ruleId, side: p.side, entryPx: p.entry, exitPx: p.exitPx,
            openEpoch: p.openEpoch, closeEpoch: p.closeEpoch, pnl, stake: p.stake, lev: p.lev,
            reason: p.reason,
          });
          open.splice(i, 1);
        }
      }
      // Open new
      const mult = v.filter ? (sig.stakeMultFiltered ?? 1) : 1;
      const stake = BASE_STAKE * mult;
      if (wallet < stake) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      const data = assetData.get(sig.asset)!;
      const startIdx = data.minMap.get(sig.nextBarEpoch)!;
      const exit = v.exit === "trail" ? simTrail(data.bars1m, startIdx, sig.entryPx, sig.atr, sig.side)
        : v.exit === "hybrid" ? simHybrid(data.bars1m, startIdx, sig.entryPx, sig.atr, sig.side, v.retraceMult ?? 0.3)
        : simFixedRR(data.bars1m, startIdx, sig.entryPx, sig.atr, sig.side);
      open.push({
        asset: sig.asset, ruleId: sig.ruleId, side: sig.side,
        entry: sig.entryPx, atr: sig.atr, lev,
        openEpoch: sig.nextBarEpoch, closeEpoch: exit.closeEpoch,
        stake, exitPx: exit.exitPx, reason: exit.reason,
      });
      wallet -= stake; locked += stake;
    }
    // Close remaining
    for (const p of open) {
      const gross = p.side === "LONG" ? (p.exitPx - p.entry) / p.entry : (p.entry - p.exitPx) / p.entry;
      const pnl = p.stake * p.lev * (gross - COST_RT);
      wallet += p.stake + pnl; locked -= p.stake;
      closedTrades.push({
        asset: p.asset, ruleId: p.ruleId, side: p.side, entryPx: p.entry, exitPx: p.exitPx,
        openEpoch: p.openEpoch, closeEpoch: p.closeEpoch, pnl, stake: p.stake, lev: p.lev, reason: p.reason,
      });
    }
    return { trades: closedTrades, wallet };
  }

  const results = new Map<string, { trades: Trade[]; wallet: number }>();
  for (const v of variants) results.set(v.id, runVariant(v));

  // Headline comparison
  console.log(`══ HEADLINE ══`);
  console.log(`${"Variant".padEnd(28)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"Net $".padStart(8)} ${"End $".padStart(8)}`);
  for (const v of variants) {
    const r = results.get(v.id)!;
    const wins = r.trades.filter(t => t.pnl > 0).length;
    const wr = r.trades.length ? wins / r.trades.length * 100 : 0;
    console.log(`${v.id.padEnd(28)} ${String(r.trades.length).padStart(7)} ${wr.toFixed(0).padStart(6)} ${(r.wallet - START_WALLET).toFixed(2).padStart(8)} ${r.wallet.toFixed(2).padStart(8)}`);
  }

  // Per-rule per-variant
  console.log(`\n══ Per-rule per-variant ══`);
  for (const v of variants) {
    const r = results.get(v.id)!;
    const byRule: Record<string, { n: number; w: number; net: number }> = {};
    for (const t of r.trades) {
      if (!byRule[t.ruleId]) byRule[t.ruleId] = { n: 0, w: 0, net: 0 };
      byRule[t.ruleId].n++; if (t.pnl > 0) byRule[t.ruleId].w++; byRule[t.ruleId].net += t.pnl;
    }
    const cells = ["M1", "M2", "M3", "M4", "M5"].map(m => {
      const s = byRule[m];
      return s ? `${m}:${s.n}/${(s.w / s.n * 100).toFixed(0)}%/$${s.net.toFixed(0)}` : `${m}:-`;
    }).join("  ");
    console.log(`  ${v.id.padEnd(28)} ${cells}`);
  }

  // Trade-by-trade table for the WINNING variant
  let best = variants[0]; let bestNet = -Infinity;
  for (const v of variants) {
    const r = results.get(v.id)!;
    if (r.wallet - START_WALLET > bestNet) { bestNet = r.wallet - START_WALLET; best = v; }
  }
  console.log(`\n══ All trades — ${best.id} (best variant) ══`);
  const bestR = results.get(best.id)!;
  bestR.trades.sort((a, b) => a.openEpoch - b.openEpoch);
  for (const t of bestR.trades) {
    const tag = t.pnl > 0 ? "✓" : "✗";
    const ot = new Date(t.openEpoch * 1000).toISOString().slice(11, 16);
    const ct = new Date(t.closeEpoch * 1000).toISOString().slice(11, 16);
    console.log(`  ${ot}→${ct} ${t.asset.padEnd(10)} ${t.ruleId} ${t.side.padEnd(5)} $${t.stake}×${t.lev}× pnl=${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2).padStart(6)} ${tag} ${t.reason}`);
  }

  // Also dump each variant's trade list for thoroughness
  for (const v of variants) {
    if (v.id === best.id) continue;
    const r = results.get(v.id)!;
    console.log(`\n── ${v.id} (${r.trades.length} trades) ──`);
    r.trades.sort((a, b) => a.openEpoch - b.openEpoch);
    for (const t of r.trades) {
      const tag = t.pnl > 0 ? "✓" : "✗";
      const ot = new Date(t.openEpoch * 1000).toISOString().slice(11, 16);
      const ct = new Date(t.closeEpoch * 1000).toISOString().slice(11, 16);
      console.log(`  ${ot}→${ct} ${t.asset.padEnd(10)} ${t.ruleId} ${t.side.padEnd(5)} $${t.stake}×${t.lev}× pnl=${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2).padStart(6)} ${tag} ${t.reason}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });

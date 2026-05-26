// Signal-strength analysis. For each of the 5 mined rules, compute how far
// past the threshold the trigger factors are, bucket signals by strength
// quintile, and measure realized WR / P&L per bucket. Tells us whether
// "stronger" signals actually win more (and by how much) — i.e. whether
// strength-based filtering or sizing would improve edge.
//
// Run: npx tsx scripts/hf-screen/signal-strength.ts

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
const STAKE = 20;

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;

function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";

// Per-rule strength function — returns how "deep into the trigger" the signal is.
// Higher = stronger.
const RULES = [
  {
    id: "M1",
    name: "Buy deep dip in 1h uptrend",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 4 && bucketOf(f.z100, Q.z100) === 0 ? "LONG" : null,
    // Strength: depth of z100 below threshold (-1.29). More negative z100 = stronger dip.
    // Also boosted by stronger uptrend (higher htf4hRet).
    strength: (f: any) => Math.max(0, -1.29 - f.z100) + Math.max(0, f.htf4hRet) * 10,
  },
  {
    id: "M2",
    name: "Short reverts in downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z100, Q.z100) === 2 ? "SHORT" : null,
    // Strength: depth of htf4hRet below threshold. More negative = stronger downtrend.
    strength: (f: any) => Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
  {
    id: "M3",
    name: "Fade rally in weak downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 1 && bucketOf(f.z100, Q.z100) === 3 ? "SHORT" : null,
    // Strength: combination — how far z100 is above 0 within q3, weighted by downtrend depth.
    strength: (f: any) => Math.max(0, f.z100 - 0.46) + Math.max(0, -0.0059 - f.htf4hRet) * 10,
  },
  {
    id: "M4",
    name: "Fade rally when 1h trend down",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 2 && bucketOf(f.z100, Q.z100) === 4 ? "SHORT" : null,
    // Strength: z100 magnitude past +1.29. Higher = more extreme rally.
    strength: (f: any) => Math.max(0, f.z100 - 1.29),
  },
  {
    id: "M5",
    name: "Fade extended bounce in downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z50, Q.z50) === 4 ? "SHORT" : null,
    // Strength: z50 magnitude past +1.28, plus downtrend depth.
    strength: (f: any) => Math.max(0, f.z50 - 1.28) + Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
];

function doSim(bars1m: Bar[], startIdx: number, entry: number, atrVal: number, side: Side): { exit: number; armed: boolean } {
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

type Signal = {
  ruleId: string; asset: string; side: Side;
  entry: number; atr: number; lev: number;
  pnl: number; strength: number;
  factors: any;
};

async function main() {
  const fromEpoch = Math.floor(new Date("2023-05-01T00:00:00Z").getTime() / 1000);
  const toEpoch = Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000);

  console.log(`\n══ Signal-strength analysis — full 37-month dataset ══\n`);

  const allSignals: Signal[] = [];

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const t0 = Date.now();
    const bars1m = load1m(sym, fromEpoch - 30 * 86400, toEpoch);
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
    const lev = PER_ASSET_MAX_LEV[sym] ?? 75;

    let count = 0;
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < fromEpoch) continue;
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
        const exit = doSim(bars1m, startIdx, next.open, atrArr[i], side);
        const gross = side === "LONG" ? (exit.exit - next.open) / next.open : (next.open - exit.exit) / next.open;
        const pnl = STAKE * lev * (gross - COST_RT);
        allSignals.push({
          ruleId: rule.id, asset: sym, side,
          entry: next.open, atr: atrArr[i], lev,
          pnl, strength: rule.strength(f),
          factors: { ...f },
        });
        count++;
      }
    }
    console.log(`${count} signals in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  console.log(`\nTotal signals across 37 mo: ${allSignals.length}\n`);

  // ── Per-rule, per-strength-quintile pivot ──────────────────────────────
  for (const rule of RULES) {
    const sigs = allSignals.filter(s => s.ruleId === rule.id);
    if (sigs.length === 0) { console.log(`\n${rule.id} ${rule.name}: 0 signals`); continue; }
    sigs.sort((a, b) => a.strength - b.strength);
    const total = sigs.length;
    const wins = sigs.filter(s => s.pnl > 0).length;
    const totalNet = sigs.reduce((s, t) => s + t.pnl, 0);
    console.log(`\n${rule.id}  ${rule.name}`);
    console.log(`  Overall: ${total} signals, WR ${(wins / total * 100).toFixed(1)}%, net $${totalNet.toFixed(0)}, avg $${(totalNet / total).toFixed(3)}/trade`);
    // Quintile buckets
    console.log(`  ${"quintile".padEnd(10)} ${"strength range".padEnd(22)} ${"n".padStart(6)} ${"WR%".padStart(6)} ${"net$".padStart(10)} ${"avg$".padStart(8)}`);
    for (let q = 0; q < 5; q++) {
      const start = Math.floor(total * q / 5);
      const end = Math.floor(total * (q + 1) / 5);
      const bucket = sigs.slice(start, end);
      if (bucket.length === 0) continue;
      const bWins = bucket.filter(s => s.pnl > 0).length;
      const bNet = bucket.reduce((s, t) => s + t.pnl, 0);
      const sMin = bucket[0].strength;
      const sMax = bucket[bucket.length - 1].strength;
      console.log(`  q${q}        [${sMin.toFixed(3)}..${sMax.toFixed(3)}]`.padEnd(34) + `  ${String(bucket.length).padStart(6)} ${(bWins / bucket.length * 100).toFixed(1).padStart(6)} ${bNet.toFixed(0).padStart(10)} ${(bNet / bucket.length).toFixed(3).padStart(8)}`);
    }
  }

  // ── Cross-rule strength ranking ─────────────────────────────────────────
  // Normalize strength within each rule (so they're comparable), then rank all
  // signals together to see the overall top-quintile WR.
  console.log(`\n\n══ POOLED STRENGTH (z-normalized within each rule) ══`);
  const byRule: Record<string, Signal[]> = {};
  for (const s of allSignals) {
    (byRule[s.ruleId] = byRule[s.ruleId] || []).push(s);
  }
  // z-normalize per rule
  for (const rid of Object.keys(byRule)) {
    const ss = byRule[rid].map(s => s.strength);
    const m = ss.reduce((a, b) => a + b, 0) / ss.length;
    const sd = Math.sqrt(ss.reduce((a, b) => a + (b - m) ** 2, 0) / ss.length);
    for (const s of byRule[rid]) (s as any).zStrength = sd > 0 ? (s.strength - m) / sd : 0;
  }
  const ranked = allSignals.slice().sort((a, b) => (b as any).zStrength - (a as any).zStrength);
  console.log(`${"strength bucket".padEnd(18)} ${"n".padStart(6)} ${"WR%".padStart(6)} ${"net$".padStart(10)} ${"avg$".padStart(8)}`);
  for (let q = 4; q >= 0; q--) {
    const start = Math.floor(ranked.length * (4 - q) / 5);
    const end = Math.floor(ranked.length * (5 - q) / 5);
    const bucket = ranked.slice(start, end);
    const w = bucket.filter(s => s.pnl > 0).length;
    const n = bucket.reduce((s, t) => s + t.pnl, 0);
    const label = q === 4 ? "Top 20% (strongest)" : q === 0 ? "Bot 20% (weakest) " : `q${q}              `;
    console.log(`${label.padEnd(18)} ${String(bucket.length).padStart(6)} ${(w / bucket.length * 100).toFixed(1).padStart(6)} ${n.toFixed(0).padStart(10)} ${(n / bucket.length).toFixed(3).padStart(8)}`);
  }

  fs.writeFileSync(`${RESULTS_DIR}/signal-strength.json`, JSON.stringify({ totalSignals: allSignals.length }, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });

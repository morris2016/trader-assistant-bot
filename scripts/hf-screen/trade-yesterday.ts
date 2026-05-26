// Apply the 5 CV-survivor mined rules to yesterday's data (2026-05-25)
// across all 15 assets, using the TRAIN-locked quintile breakpoints.
// Report what would have been traded vs the live BB stack that lost money.
//
// Run: npx tsx scripts/hf-screen/trade-yesterday.ts

import * as fs from "fs";
import {
  ASSETS, STAKE, LEV, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

// Default = yesterday only. Override via DAYS env (e.g. DAYS=7 = last 7 days).
const DAYS_BACK = +(process.env.DAYS ?? "1");
const TRADE_DAY_END   = Math.floor(new Date("2026-05-26T00:00:00Z").getTime() / 1000);
const TRADE_DAY_START = TRADE_DAY_END - DAYS_BACK * 86400;

// Load TRAIN-locked breakpoints from CV output
const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;

function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";
type Rule = { id: string; name: string; check: (f: any) => Side | null };

const RULES: Rule[] = [
  {
    id: "M1",
    name: "Buy deep dip in 1h uptrend (htf1hTrend=q4, z100=q0)",
    check: (f) => {
      if (bucketOf(f.htf1hTrend, Q.htf1hTrend) !== 4) return null;
      if (bucketOf(f.z100, Q.z100) !== 0) return null;
      return "LONG";
    },
  },
  {
    id: "M2",
    name: "Short reverts in downtrend (htf4hRet=q0, z100=q2)",
    check: (f) => {
      if (bucketOf(f.htf4hRet, Q.htf4hRet) !== 0) return null;
      if (bucketOf(f.z100, Q.z100) !== 2) return null;
      return "SHORT";
    },
  },
  {
    id: "M3",
    name: "Fade rally in weak downtrend (htf4hRet=q1, z100=q3)",
    check: (f) => {
      if (bucketOf(f.htf4hRet, Q.htf4hRet) !== 1) return null;
      if (bucketOf(f.z100, Q.z100) !== 3) return null;
      return "SHORT";
    },
  },
  {
    id: "M4",
    name: "Fade rally when 1h trend down (htf1hTrend=q2, z100=q4)",
    check: (f) => {
      if (bucketOf(f.htf1hTrend, Q.htf1hTrend) !== 2) return null;
      if (bucketOf(f.z100, Q.z100) !== 4) return null;
      return "SHORT";
    },
  },
  {
    id: "M5",
    name: "Fade extended bounce in downtrend (htf4hRet=q0, z50=q4)",
    check: (f) => {
      if (bucketOf(f.htf4hRet, Q.htf4hRet) !== 0) return null;
      if (bucketOf(f.z50, Q.z50) !== 4) return null;
      return "SHORT";
    },
  },
];

function doSim(bars1m: Bar[], startIdx: number, entry: number, atrVal: number, side: Side): { exit: number; armed: boolean; reason: string; exitEpoch: number } {
  const armDist = TRAIL_ARM_ATR * atrVal;
  const trailDist = TRAIL_RETRACE_ATR * atrVal;
  const slDist = HARD_SL_ATR * atrVal;
  const slPrice = side === "LONG" ? entry - slDist : entry + slDist;
  let peak = entry, armed = false;
  const maxIdx = Math.min(bars1m.length - 1, startIdx + HARD_TIMEOUT_MIN);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPrice) return { exit: slPrice, armed, reason: "SL", exitEpoch: b.epoch };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + armDist) armed = true;
      if (armed && b.low <= peak - trailDist) return { exit: peak - trailDist, armed: true, reason: "trail", exitEpoch: b.epoch };
    } else {
      if (b.high >= slPrice) return { exit: slPrice, armed, reason: "SL", exitEpoch: b.epoch };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - armDist) armed = true;
      if (armed && b.high >= peak + trailDist) return { exit: peak + trailDist, armed: true, reason: "trail", exitEpoch: b.epoch };
    }
  }
  return { exit: bars1m[maxIdx].close, armed, reason: "timeout", exitEpoch: bars1m[maxIdx].epoch };
}

async function main() {
  console.log(`\n══ Trading window: last ${DAYS_BACK} day(s) ending 2026-05-26 UTC ══\n`);
  type TradeRow = { ruleId: string; asset: string; ts: string; side: Side; entry: number; exit: number; pnl: number; reason: string };
  const trades: TradeRow[] = [];

  for (const sym of ASSETS) {
    // Need history extending back ~30 days for warmup
    const bars1m = load1m(sym, TRADE_DAY_START - 30 * 86400, TRADE_DAY_END + 86400);
    if (bars1m.length === 0) { console.log(`  ${sym} no data`); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);

    const atrArr = new Float64Array(bars15m.length);
    const ema50_1hArr = new Float64Array(bars1h.length);
    for (let i = 0; i < bars15m.length; i++) atrArr[i] = atrFn(bars15m, 14, i);
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = emaFn(closes1h, 50, i);

    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < TRADE_DAY_START || b.epoch >= TRADE_DAY_END) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 50) continue;

      // Compute the factors needed
      const zN = (n: number) => {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += closes15m[j];
        const m = s / n;
        let v = 0;
        for (let j = i - n + 1; j <= i; j++) v += (closes15m[j] - m) ** 2;
        const sd = Math.sqrt(v / n);
        return sd === 0 ? 0 : (closes15m[i] - m) / sd;
      };
      const z50 = zN(50), z100 = zN(100);
      const htf1hTrend = isFinite(ema50_1hArr[i1h]) ? (closes1h[i1h] > ema50_1hArr[i1h] ? 1 : 0) : 0.5;
      const i1hPrev16 = Math.max(0, i1h - 16);
      const htf4hRet = (closes1h[i1h] - closes1h[i1hPrev16]) / closes1h[i1hPrev16];

      const f = { z50, z100, htf1hTrend, htf4hRet };

      for (const rule of RULES) {
        const side = rule.check(f);
        if (!side) continue;
        const next = bars15m[i + 1];
        const startIdx = minMap.get(next.epoch);
        if (startIdx === undefined) continue;
        const entry = next.open;
        const exit = doSim(bars1m, startIdx, entry, atrArr[i], side);
        const grossPct = side === "LONG" ? (exit.exit - entry) / entry : (entry - exit.exit) / entry;
        const pnl = STAKE * LEV * (grossPct - COST_RT);
        const ts = new Date(next.epoch * 1000).toISOString().slice(11, 16);
        trades.push({ ruleId: rule.id, asset: sym, ts, side, entry, exit: exit.exit, pnl, reason: exit.reason });
      }
    }
  }

  console.log(`Total signals fired on 2026-05-25: ${trades.length}`);
  if (trades.length === 0) { console.log(`\nNone of the 5 rules triggered yesterday.`); return; }

  // Per-rule summary
  console.log(`\nPer-rule:`);
  console.log(`${"rule".padEnd(4)} ${"trades".padStart(7)} ${"wins".padStart(5)} ${"WR%".padStart(6)} ${"net$".padStart(8)}  description`);
  for (const r of RULES) {
    const ts = trades.filter(t => t.ruleId === r.id);
    const wins = ts.filter(t => t.pnl > 0).length;
    const net = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`${r.id.padEnd(4)} ${String(ts.length).padStart(7)} ${String(wins).padStart(5)} ${(ts.length ? wins / ts.length * 100 : 0).toFixed(0).padStart(6)} ${net.toFixed(2).padStart(8)}  ${r.name}`);
  }

  // Per-asset summary
  console.log(`\nPer-asset:`);
  const byAsset: Record<string, { n: number; w: number; net: number }> = {};
  for (const t of trades) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { n: 0, w: 0, net: 0 };
    byAsset[t.asset].n++;
    if (t.pnl > 0) byAsset[t.asset].w++;
    byAsset[t.asset].net += t.pnl;
  }
  const sortedAssets = Object.entries(byAsset).sort((a, b) => b[1].net - a[1].net);
  for (const [a, s] of sortedAssets) {
    console.log(`  ${a.padEnd(10)} n=${String(s.n).padStart(3)} WR=${(s.w / s.n * 100).toFixed(0).padStart(3)}% net=$${s.net.toFixed(2).padStart(7)}`);
  }

  // Trade-by-trade chronological
  trades.sort((a, b) => a.ts.localeCompare(b.ts));
  console.log(`\nAll trades (chronological):`);
  for (const t of trades) {
    const tag = t.pnl > 0 ? "✓" : "✗";
    console.log(`  ${t.ts}  ${t.asset.padEnd(10)} ${t.side.padEnd(5)} ${t.ruleId}  entry=${t.entry.toFixed(5).padStart(12)}  exit=${t.exit.toFixed(5).padStart(12)}  pnl=${t.pnl > 0 ? "+" : ""}${t.pnl.toFixed(2).padStart(7)} ${tag} ${t.reason}`);
  }

  const total = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  console.log(`\n═══ TOTAL ═══`);
  console.log(`  Trades: ${trades.length}  Wins: ${wins}  WR: ${(wins / trades.length * 100).toFixed(1)}%`);
  console.log(`  Net P&L: ${total > 0 ? "+" : ""}$${total.toFixed(2)}`);
  console.log(`  Live bot's yesterday (BB stack, paper): −$247.54 over 73 trades, 28.8% WR`);
  console.log(`  Δ vs live: ${(total - (-247.54)) > 0 ? "+" : ""}$${(total - (-247.54)).toFixed(2)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

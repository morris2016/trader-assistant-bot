// One-shot: compute and print TRAIN-derived strength quintile breakpoints
// per rule, ready to paste into binance.ts as engine constants.

import * as fs from "fs";
import {
  ASSETS, load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, RESULTS_DIR, type Bar,
} from "./lib";

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

async function main() {
  const byRule: Record<string, number[]> = {};
  for (const r of RULES) byRule[r.id] = [];
  for (const sym of ASSETS) {
    const bars1m = load1m(sym, TRAIN_FROM - 30 * 86400, TRAIN_TO + 86400);
    if (bars1m.length === 0) continue;
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
      if (b.epoch < TRAIN_FROM || b.epoch > TRAIN_TO) continue;
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
        if (rule.check(f) === null) continue;
        byRule[rule.id].push(rule.strength(f));
      }
    }
  }
  console.log(`// TRAIN-derived strength quintile breakpoints per rule.`);
  console.log(`// Derived from signals fired 2025-05-26 → 2025-12-31.`);
  console.log(`const STRENGTH_BREAKS: Record<string, number[]> = {`);
  for (const r of RULES) {
    const ss = byRule[r.id].slice().sort((a, b) => a - b);
    if (ss.length === 0) { console.log(`  ${r.id}: [],`); continue; }
    const b = [ss[Math.floor(ss.length * 0.2)], ss[Math.floor(ss.length * 0.4)], ss[Math.floor(ss.length * 0.6)], ss[Math.floor(ss.length * 0.8)]];
    console.log(`  ${r.id}: [${b.map(x => x.toFixed(6)).join(", ")}],  // n=${ss.length}`);
  }
  console.log(`};`);
}
main().catch(e => { console.error(e); process.exit(1); });

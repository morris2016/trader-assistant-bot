// SL-tightness sweep on Fixed 2:1 RR exit (TP locked at +2×ATR).
// Tests SL at 0.3, 0.5, 0.7, 1.0 ×ATR, both filtered and unfiltered.
// Last N hours. Reports also tracks "still-open" trades (sim ran out of data).
//
// Run: HOURS=48 npx tsx scripts/hf-screen/compare-sl-sweep.ts

import * as fs from "fs";
import {
  ASSETS, COST_RT, HARD_TIMEOUT_MIN,
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
const SL_LEVELS = [0.3, 0.5, 0.7, 1.0];  // ×ATR

const HOURS_BACK = +(process.env.HOURS ?? "48");
const NOW = Math.floor(Date.now() / 1000);
const WIN_START = NOW - HOURS_BACK * 3600;
const WIN_END = NOW + 60;
const TRAIN_FROM = Math.floor(new Date("2025-05-26T00:00:00Z").getTime() / 1000);
const TRAIN_TO   = Math.floor(new Date("2025-12-31T23:59:59Z").getTime() / 1000);

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;
function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}
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
  strength: number; stakeMultFiltered: number | undefined;
};

function simFixedRR(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side, slMult: number): { exitPx: number; closeEpoch: number; reason: "TP" | "SL" | "timeout" | "open" } {
  const tpD = TP_ATR * atr, slD = slMult * atr;
  const tpPx = side === "LONG" ? entry + tpD : entry - tpD;
  const slPx = side === "LONG" ? entry - slD : entry + slD;
  const trueTimeoutIdx = startIdx + HARD_TIMEOUT_MIN;
  const maxIdx = Math.min(bars1m.length - 1, trueTimeoutIdx);
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
  const reason = maxIdx < trueTimeoutIdx ? "open" : "timeout";
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason };
}

async function main() {
  const startStr = new Date(WIN_START * 1000).toISOString().slice(0, 16).replace("T", " ");
  const endStr = new Date(WIN_END * 1000).toISOString().slice(0, 16).replace("T", " ");
  console.log(`\n══ SL-tightness sweep on Fixed-RR (TP=+2×ATR locked) ══`);
  console.log(`Window: ${startStr} → ${endStr} UTC (${HOURS_BACK}h)`);
  console.log(`$${START_WALLET} wallet, $${BASE_STAKE} base stake, per-asset max lev\n`);

  // Load + generate signals
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
          strength, stakeMultFiltered: SCHEDULE[rule.id][qstr],
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
  }

  let totalSigs = 0;
  for (const d of assetData.values()) totalSigs += d.signals.length;
  console.log(`Raw M1..M5 signals in window: ${totalSigs}\n`);
  if (totalSigs === 0) return;

  type Trade = { asset: string; ruleId: string; side: Side; entryPx: number; exitPx: number; openEpoch: number; closeEpoch: number; pnl: number; stake: number; lev: number; reason: "TP" | "SL" | "timeout" | "open" };
  function runVariant(filter: boolean, slMult: number): { trades: Trade[]; wallet: number } {
    let wallet = START_WALLET, locked = 0;
    type Op = { asset: string; ruleId: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; closeEpoch: number; stake: number; exitPx: number; reason: "TP" | "SL" | "timeout" | "open" };
    const closed: Trade[] = [];
    const sigs: Signal[] = [];
    for (const d of assetData.values()) for (const s of d.signals) {
      if (filter && s.stakeMultFiltered === undefined) continue;
      sigs.push(s);
    }
    sigs.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);
    const open: Op[] = [];
    for (const sig of sigs) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].closeEpoch <= sig.nextBarEpoch) {
          const p = open[i];
          const gross = p.side === "LONG" ? (p.exitPx - p.entry) / p.entry : (p.entry - p.exitPx) / p.entry;
          const pnl = p.stake * p.lev * (gross - COST_RT);
          wallet += p.stake + pnl; locked -= p.stake;
          closed.push({ asset: p.asset, ruleId: p.ruleId, side: p.side, entryPx: p.entry, exitPx: p.exitPx, openEpoch: p.openEpoch, closeEpoch: p.closeEpoch, pnl, stake: p.stake, lev: p.lev, reason: p.reason });
          open.splice(i, 1);
        }
      }
      const mult = filter ? (sig.stakeMultFiltered ?? 1) : 1;
      const stake = BASE_STAKE * mult;
      if (wallet < stake) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      const data = assetData.get(sig.asset)!;
      const startIdx = data.minMap.get(sig.nextBarEpoch)!;
      const exit = simFixedRR(data.bars1m, startIdx, sig.entryPx, sig.atr, sig.side, slMult);
      open.push({ asset: sig.asset, ruleId: sig.ruleId, side: sig.side, entry: sig.entryPx, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch, closeEpoch: exit.closeEpoch, stake, exitPx: exit.exitPx, reason: exit.reason });
      wallet -= stake; locked += stake;
    }
    for (const p of open) {
      const gross = p.side === "LONG" ? (p.exitPx - p.entry) / p.entry : (p.entry - p.exitPx) / p.entry;
      const pnl = p.stake * p.lev * (gross - COST_RT);
      wallet += p.stake + pnl; locked -= p.stake;
      closed.push({ asset: p.asset, ruleId: p.ruleId, side: p.side, entryPx: p.entry, exitPx: p.exitPx, openEpoch: p.openEpoch, closeEpoch: p.closeEpoch, pnl, stake: p.stake, lev: p.lev, reason: p.reason });
    }
    return { trades: closed, wallet };
  }

  // Run all 8 variants (4 SL × 2 filter)
  console.log(`${"Variant".padEnd(32)} ${"Trades".padStart(7)} ${"WR%".padStart(6)} ${"TP".padStart(4)} ${"SL".padStart(4)} ${"to/op".padStart(5)} ${"Net $".padStart(8)} ${"NetRealized $".padStart(14)}`);
  for (const slMult of SL_LEVELS) {
    for (const filter of [false, true]) {
      const r = runVariant(filter, slMult);
      const wins = r.trades.filter(t => t.pnl > 0).length;
      const wr = r.trades.length ? wins / r.trades.length * 100 : 0;
      const reasons = { TP: 0, SL: 0, timeout: 0, open: 0 };
      for (const t of r.trades) reasons[t.reason]++;
      const realized = r.trades.filter(t => t.reason !== "open").reduce((s, t) => s + t.pnl, 0);
      const id = `${filter ? "Filtered" : "Unfiltered"} + Fixed TP2 SL${slMult}`;
      console.log(`${id.padEnd(32)} ${String(r.trades.length).padStart(7)} ${wr.toFixed(0).padStart(6)} ${String(reasons.TP).padStart(4)} ${String(reasons.SL).padStart(4)} ${(String(reasons.timeout)+"/"+String(reasons.open)).padStart(5)} ${(r.wallet - START_WALLET).toFixed(2).padStart(8)} ${realized.toFixed(2).padStart(14)}`);
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });

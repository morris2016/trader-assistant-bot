// Monthly distribution with STRENGTH FILTERING + DYNAMIC SIZING.
//
// Strength thresholds derived from TRAIN-only signals (2025-05-26 → 2025-12-31),
// applied unchanged to the full 37 months for clean OOS.
//
// Per-rule schedule (selective trading + Kelly-ish sizing):
//   M1, M3, M4 (stronger = better):  q0/q1 → skip,  q2 → $20,  q3 → $25,  q4 → $30
//   M2 (extreme = worse):            q0..q3 → $25,  q4 → skip
//   M5 (extreme = worse):            q0/q1 → $20,   q2..q4 → skip
//
// Reports BOTH:
//   (a) Independent monthly runs (wallet resets to $100)
//   (b) Compounded continuous run from $100 start
//
// Run: npx tsx scripts/hf-screen/monthly-filtered-sized.ts

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

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;
const TRAIN_FROM = Math.floor(new Date("2025-05-26T00:00:00Z").getTime() / 1000);
const TRAIN_TO   = Math.floor(new Date("2025-12-31T23:59:59Z").getTime() / 1000);

function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";

const RULES = [
  {
    id: "M1",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 4 && bucketOf(f.z100, Q.z100) === 0 ? "LONG" : null,
    strength: (f: any) => Math.max(0, -1.29 - f.z100) + Math.max(0, f.htf4hRet) * 10,
  },
  {
    id: "M2",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z100, Q.z100) === 2 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
  {
    id: "M3",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 1 && bucketOf(f.z100, Q.z100) === 3 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 0.46) + Math.max(0, -0.0059 - f.htf4hRet) * 10,
  },
  {
    id: "M4",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 2 && bucketOf(f.z100, Q.z100) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 1.29),
  },
  {
    id: "M5",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z50, Q.z50) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z50 - 1.28) + Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
];

// Schedule: ruleId -> stake by strength quintile (0..4), undefined = skip
const SCHEDULE: Record<string, Array<number | undefined>> = {
  M1: [undefined, undefined, 20, 25, 30],
  M2: [25, 25, 25, 25, undefined],
  M3: [undefined, undefined, 20, 25, 30],
  M4: [undefined, undefined, 20, 25, 30],
  M5: [20, 20, undefined, undefined, undefined],
};

type Signal = {
  asset: string; ruleId: string; side: Side;
  nextBarEpoch: number; nextOpenPrice: number; atr: number;
  strength: number;  // raw
  qstr: number;      // strength quintile (computed later from TRAIN)
  stake: number | undefined;  // resolved later via SCHEDULE
};

function generateMonths(): { id: string; start: number; end: number }[] {
  const out: { id: string; start: number; end: number }[] = [];
  for (let y = 2023; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2023 && m < 5) continue;
      if (y === 2026 && m > 5) continue;
      const sStr = `${y}-${String(m).padStart(2, "0")}-01T00:00:00Z`;
      const nY = m === 12 ? y + 1 : y, nM = m === 12 ? 1 : m + 1;
      const eStr = `${nY}-${String(nM).padStart(2, "0")}-01T00:00:00Z`;
      out.push({ id: `${y}-${String(m).padStart(2, "0")}`, start: Math.floor(new Date(sStr).getTime() / 1000), end: Math.floor(new Date(eStr).getTime() / 1000) });
    }
  }
  return out;
}

async function main() {
  const months = generateMonths();
  const fromEpoch = months[0].start - 30 * 86400;
  const toEpoch = months[months.length - 1].end + 86400;

  console.log(`\n══ Filtered + dynamically-sized monthly distribution ══`);
  console.log(`Strength quintile thresholds: TRAIN-only (2025-05-26 → 2025-12-31)`);
  console.log(`Per-rule sizing schedule:`);
  for (const r of RULES) console.log(`  ${r.id}: ${SCHEDULE[r.id].map((s, q) => `q${q}=${s ?? "skip"}`).join(", ")}`);
  console.log();

  // ── 1. Load + generate all signals across full data ────────────────────
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const t0 = Date.now();
    const bars1m = load1m(sym, fromEpoch, toEpoch);
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
        signals.push({
          asset: sym, ruleId: rule.id, side,
          nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i],
          strength: rule.strength(f),
          qstr: -1, stake: undefined,
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
    console.log(`${signals.length} signals in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // ── 2. Compute strength quintile breakpoints PER RULE from TRAIN window ─
  const strengthBreaks: Record<string, number[]> = {};
  for (const rule of RULES) {
    const trainStrengths: number[] = [];
    for (const data of assetData.values()) {
      for (const s of data.signals) {
        if (s.ruleId !== rule.id) continue;
        if (s.nextBarEpoch < TRAIN_FROM || s.nextBarEpoch > TRAIN_TO) continue;
        trainStrengths.push(s.strength);
      }
    }
    trainStrengths.sort((a, b) => a - b);
    if (trainStrengths.length === 0) continue;
    strengthBreaks[rule.id] = [
      trainStrengths[Math.floor(trainStrengths.length * 0.2)],
      trainStrengths[Math.floor(trainStrengths.length * 0.4)],
      trainStrengths[Math.floor(trainStrengths.length * 0.6)],
      trainStrengths[Math.floor(trainStrengths.length * 0.8)],
    ];
  }
  console.log(`\nTRAIN-derived strength quintile breakpoints per rule:`);
  for (const r of RULES) console.log(`  ${r.id}: ${(strengthBreaks[r.id] ?? []).map(x => x.toFixed(4)).join(", ")}`);

  // ── 3. Assign quintile + stake to every signal ─────────────────────────
  let filteredOut = 0, kept = 0;
  for (const data of assetData.values()) {
    for (const s of data.signals) {
      const breaks = strengthBreaks[s.ruleId];
      if (!breaks) { filteredOut++; continue; }
      let q = 0; for (const t of breaks) if (s.strength >= t) q++;
      s.qstr = q;
      const stake = SCHEDULE[s.ruleId][q];
      if (stake === undefined) { filteredOut++; continue; }
      s.stake = stake;
      kept++;
    }
  }
  console.log(`\nSignals: ${kept} kept, ${filteredOut} filtered (${(filteredOut / (kept + filteredOut) * 100).toFixed(1)}% dropped)`);

  // ── 4. Walk per-month (independent runs, wallet resets to $100) ────────
  type MonthResult = { id: string; trades: number; wins: number; netDollars: number; endWallet: number };
  function simWindow(startEp: number, endEp: number, initialWallet: number): MonthResult & { equityCurve: { ep: number; eq: number }[]; trades_arr: { ep: number; pnl: number }[] } {
    let wallet = initialWallet, locked = 0, trades = 0, wins = 0, net = 0;
    type OpenPos = { ruleId: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; peakFav: number; armed: boolean };
    const open: OpenPos[] = [];
    const allSigs: Signal[] = [];
    for (const data of assetData.values()) for (const s of data.signals) if (s.stake !== undefined && s.nextBarEpoch >= startEp && s.nextBarEpoch < endEp) allSigs.push(s);
    const epochSet = new Set<number>();
    for (const data of assetData.values()) for (const b of data.bars1m) if (b.epoch >= startEp && b.epoch < endEp + HARD_TIMEOUT_MIN * 60) epochSet.add(b.epoch);
    const sortedE = Array.from(epochSet).sort((a, b) => a - b);
    const sigByEpoch = new Map<number, Signal[]>();
    for (const s of allSigs) {
      if (!sigByEpoch.has(s.nextBarEpoch)) sigByEpoch.set(s.nextBarEpoch, []);
      sigByEpoch.get(s.nextBarEpoch)!.push(s);
    }
    const equityCurve: { ep: number; eq: number }[] = [];
    const trades_arr: { ep: number; pnl: number }[] = [];
    let lastDayEp = 0;
    for (const e of sortedE) {
      // Close positions
      for (let i = open.length - 1; i >= 0; i--) {
        const pos = open[i];
        const data = assetData.get(pos.asset)!;
        const idx = data.minMap.get(e); if (idx === undefined) continue;
        const bar = data.bars1m[idx];
        const armDist = TRAIL_ARM_ATR * pos.atr, trailDist = TRAIL_RETRACE_ATR * pos.atr, slDist = HARD_SL_ATR * pos.atr;
        const slPrice = pos.side === "LONG" ? pos.entry - slDist : pos.entry + slDist;
        let closed = false, exitPx = 0;
        if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) { exitPx = bar.close; closed = true; }
        else if (pos.side === "LONG") {
          if (bar.low <= slPrice) { exitPx = slPrice; closed = true; }
          else {
            if (bar.high > pos.peakFav) pos.peakFav = bar.high;
            if (!pos.armed && pos.peakFav >= pos.entry + armDist) pos.armed = true;
            if (pos.armed && bar.low <= pos.peakFav - trailDist) { exitPx = pos.peakFav - trailDist; closed = true; }
          }
        } else {
          if (bar.high >= slPrice) { exitPx = slPrice; closed = true; }
          else {
            if (bar.low < pos.peakFav) pos.peakFav = bar.low;
            if (!pos.armed && pos.peakFav <= pos.entry - armDist) pos.armed = true;
            if (pos.armed && bar.high >= pos.peakFav + trailDist) { exitPx = pos.peakFav + trailDist; closed = true; }
          }
        }
        if (closed) {
          const gross = pos.side === "LONG" ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry;
          const pnl = pos.stake * pos.lev * (gross - COST_RT);
          wallet += pos.stake + pnl; locked -= pos.stake;
          trades++; if (pnl > 0) wins++; net += pnl;
          trades_arr.push({ ep: e, pnl });
          open.splice(i, 1);
        }
      }
      // Open positions
      const sigs = sigByEpoch.get(e);
      if (sigs) for (const sig of sigs) {
        if (wallet < sig.stake!) continue;
        if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
        const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
        open.push({ ruleId: sig.ruleId, asset: sig.asset, side: sig.side, entry: sig.nextOpenPrice, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch, stake: sig.stake!, peakFav: sig.nextOpenPrice, armed: false });
        wallet -= sig.stake!; locked += sig.stake!;
      }
      if (e - lastDayEp >= 86400) {
        equityCurve.push({ ep: e, eq: wallet + locked });
        lastDayEp = e;
      }
    }
    // Close remaining at last bar
    for (const pos of open) {
      const data = assetData.get(pos.asset)!;
      const last = data.bars1m[data.bars1m.length - 1];
      const gross = pos.side === "LONG" ? (last.close - pos.entry) / pos.entry : (pos.entry - last.close) / pos.entry;
      const pnl = pos.stake * pos.lev * (gross - COST_RT);
      wallet += pos.stake + pnl; locked -= pos.stake;
      trades++; if (pnl > 0) wins++; net += pnl;
    }
    return { id: "", trades, wins, netDollars: net, endWallet: wallet, equityCurve, trades_arr };
  }

  // ── Independent monthly runs ───────────────────────────────────────────
  console.log(`\n══ Independent monthly runs ($100 reset each month) ══`);
  console.log(`${"month".padEnd(8)}  ${"trades".padStart(6)}  ${"WR%".padStart(5)}  ${"net$".padStart(8)}  ${"end$".padStart(8)}  ${"ret%".padStart(7)}`);
  let totalNet = 0, totalTrades = 0, totalWins = 0, posMonths = 0, negMonths = 0;
  let bestMonth = -Infinity, worstMonth = Infinity;
  const monthlyResults: MonthResult[] = [];
  for (const m of months) {
    const r = simWindow(m.start, m.end, START_WALLET);
    r.id = m.id;
    monthlyResults.push(r);
    const wr = r.trades ? r.wins / r.trades * 100 : 0;
    const ret = (r.endWallet / START_WALLET - 1) * 100;
    const tag = r.netDollars > 0 ? "+" : "";
    console.log(`${m.id.padEnd(8)}  ${String(r.trades).padStart(6)}  ${wr.toFixed(0).padStart(5)}  ${tag}${r.netDollars.toFixed(2).padStart(7)}  ${r.endWallet.toFixed(2).padStart(8)}  ${(ret >= 0 ? "+" : "") + ret.toFixed(1).padStart(6)}%`);
    totalNet += r.netDollars; totalTrades += r.trades; totalWins += r.wins;
    if (r.netDollars > 0) posMonths++; else if (r.netDollars < 0) negMonths++;
    if (r.netDollars > bestMonth) bestMonth = r.netDollars;
    if (r.netDollars < worstMonth) worstMonth = r.netDollars;
  }
  console.log(`\n${"─".repeat(50)}`);
  console.log(`Months:  ${months.length}  (${posMonths} +, ${negMonths} −)`);
  console.log(`Hit rate: ${(posMonths / months.length * 100).toFixed(1)}%`);
  console.log(`Total trades: ${totalTrades}  WR: ${(totalWins / totalTrades * 100).toFixed(1)}%`);
  console.log(`Sum net P&L: $${totalNet.toFixed(2)}  best: +$${bestMonth.toFixed(2)}  worst: ${worstMonth >= 0 ? "+" : ""}$${worstMonth.toFixed(2)}`);

  // ── Compounding continuous run ─────────────────────────────────────────
  console.log(`\n\n══ Compounding continuous run (single $100 start through 37 mo) ══`);
  const cont = simWindow(months[0].start, months[months.length - 1].end, START_WALLET);
  console.log(`Start wallet: $${START_WALLET}`);
  console.log(`End wallet:   $${cont.endWallet.toFixed(2)}`);
  console.log(`Trades:       ${cont.trades}  Wins: ${cont.wins}  WR: ${(cont.wins / cont.trades * 100).toFixed(1)}%`);
  console.log(`Total return: ${((cont.endWallet / START_WALLET - 1) * 100).toFixed(1)}% over ${months.length} months`);
  console.log(`\nEquity at month boundaries:`);
  let prev = START_WALLET;
  let peakEq = START_WALLET, troughFromPeak = START_WALLET, maxDD = 0;
  for (const e of cont.equityCurve) {
    const day = new Date(e.ep * 1000).toISOString().slice(0, 10);
    if (e.eq > peakEq) { peakEq = e.eq; troughFromPeak = e.eq; }
    if (e.eq < troughFromPeak) troughFromPeak = e.eq;
    const dd = (peakEq - troughFromPeak) / peakEq;
    if (dd > maxDD) maxDD = dd;
    if (day.endsWith("-01") || day.endsWith("-02")) {
      console.log(`  ${day}  $${e.eq.toFixed(2).padStart(10)}  ${e.eq > prev ? "+" : ""}${(e.eq - prev).toFixed(2).padStart(8)}  peak $${peakEq.toFixed(0)}  DDfromPeak ${(dd * 100).toFixed(1)}%`);
      prev = e.eq;
    }
  }
  console.log(`\nMax peak-to-trough drawdown across the 37 months: ${(maxDD * 100).toFixed(1)}%`);
  console.log(`Peak equity reached: $${peakEq.toFixed(2)}`);

  fs.writeFileSync(`${RESULTS_DIR}/monthly-filtered-sized.json`, JSON.stringify({ monthlyResults, continuous: { endWallet: cont.endWallet, trades: cont.trades, wins: cont.wins, maxDD } }, null, 2));
  console.log(`\nSaved → ${RESULTS_DIR}/monthly-filtered-sized.json`);
}

main().catch(e => { console.error(e); process.exit(1); });

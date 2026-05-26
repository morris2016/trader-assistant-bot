// Monthly P&L distribution for the 5 CV-survivor mined rules across the
// FULL available cache (May 2023 → May 2026 where available).
//
// For each month independently:
//   - Reset wallet to $100
//   - $20 stake, per-asset max leverage
//   - Walk minute-by-minute, fire signals, manage exits
//   - Record end-of-month equity + P&L
//
// Run: npx tsx scripts/hf-screen/monthly-distribution.ts

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
const STAKE = 20;

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;

function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";
type Rule = { id: string; check: (f: any) => Side | null };
const RULES: Rule[] = [
  { id: "M1", check: (f) => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 4 && bucketOf(f.z100, Q.z100) === 0 ? "LONG"  : null },
  { id: "M2", check: (f) => bucketOf(f.htf4hRet,    Q.htf4hRet)    === 0 && bucketOf(f.z100, Q.z100) === 2 ? "SHORT" : null },
  { id: "M3", check: (f) => bucketOf(f.htf4hRet,    Q.htf4hRet)    === 1 && bucketOf(f.z100, Q.z100) === 3 ? "SHORT" : null },
  { id: "M4", check: (f) => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 2 && bucketOf(f.z100, Q.z100) === 4 ? "SHORT" : null },
  { id: "M5", check: (f) => bucketOf(f.htf4hRet,    Q.htf4hRet)    === 0 && bucketOf(f.z50,  Q.z50)  === 4 ? "SHORT" : null },
];

type Signal = { epoch: number; asset: string; ruleId: string; side: Side; nextBarEpoch: number; nextOpenPrice: number; atr: number };

function generateMonths(): { id: string; start: number; end: number }[] {
  // Iterate months from 2023-05 → 2026-05 inclusive
  const out: { id: string; start: number; end: number }[] = [];
  for (let y = 2023; y <= 2026; y++) {
    for (let m = 1; m <= 12; m++) {
      if (y === 2023 && m < 5) continue;
      if (y === 2026 && m > 5) continue;
      const startStr = `${y}-${String(m).padStart(2, "0")}-01T00:00:00Z`;
      const nextY = m === 12 ? y + 1 : y;
      const nextM = m === 12 ? 1 : m + 1;
      const endStr = `${nextY}-${String(nextM).padStart(2, "0")}-01T00:00:00Z`;
      out.push({
        id: `${y}-${String(m).padStart(2, "0")}`,
        start: Math.floor(new Date(startStr).getTime() / 1000),
        end: Math.floor(new Date(endStr).getTime() / 1000),
      });
    }
  }
  return out;
}

async function main() {
  const months = generateMonths();
  console.log(`\n══ Monthly distribution — ${months.length} months from ${months[0].id} to ${months[months.length-1].id} ══\n`);

  // ── Load all asset data ONCE ───────────────────────────────────────────
  console.log(`Loading all asset histories (this is the slow part)...`);
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();

  const earliestNeeded = months[0].start - 30 * 86400;
  const latestNeeded = months[months.length - 1].end;

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const t0 = Date.now();
    const bars1m = load1m(sym, earliestNeeded, latestNeeded);
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
        signals.push({ epoch: b.epoch, asset: sym, ruleId: rule.id, side, nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i] });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
    console.log(`${signals.length} signals in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  // ── Per-month sim ──────────────────────────────────────────────────────
  type MonthResult = {
    id: string; trades: number; wins: number; netDollars: number; endWallet: number;
    maxEquity: number; minEquity: number; maxDD: number;
  };
  const results: MonthResult[] = [];

  for (const m of months) {
    // Collect signals in this month from all assets, sort by entry epoch
    const monthSignals: Signal[] = [];
    for (const [sym, data] of assetData) {
      for (const s of data.signals) {
        if (s.nextBarEpoch >= m.start && s.nextBarEpoch < m.end) monthSignals.push(s);
      }
    }
    monthSignals.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);

    // Wallet sim — only need 1m bars within the month + 4h grace period
    let wallet = START_WALLET; let locked = 0;
    let maxEquity = START_WALLET; let minEquity = START_WALLET;
    type OpenPos = { ruleId: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; peakFav: number; armed: boolean };
    const open: OpenPos[] = [];
    let trades = 0; let wins = 0; let net = 0;

    // Build all epochs in the month
    const monthEpochs = new Set<number>();
    for (const data of assetData.values()) {
      for (const b of data.bars1m) {
        if (b.epoch >= m.start && b.epoch < m.end + HARD_TIMEOUT_MIN * 60) monthEpochs.add(b.epoch);
      }
    }
    const sortedEpochs = Array.from(monthEpochs).sort((a, b) => a - b);
    const sigByEpoch = new Map<number, Signal[]>();
    for (const s of monthSignals) {
      if (!sigByEpoch.has(s.nextBarEpoch)) sigByEpoch.set(s.nextBarEpoch, []);
      sigByEpoch.get(s.nextBarEpoch)!.push(s);
    }

    for (const e of sortedEpochs) {
      // exits
      for (let i = open.length - 1; i >= 0; i--) {
        const pos = open[i];
        const data = assetData.get(pos.asset)!;
        const idx = data.minMap.get(e);
        if (idx === undefined) continue;
        const bar = data.bars1m[idx];
        if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) {
          const exit = bar.close;
          const gross = pos.side === "LONG" ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
          const pnl = pos.stake * pos.lev * (gross - COST_RT);
          wallet += pos.stake + pnl; locked -= pos.stake;
          trades++; if (pnl > 0) wins++; net += pnl;
          open.splice(i, 1); continue;
        }
        const armDist = TRAIL_ARM_ATR * pos.atr;
        const trailDist = TRAIL_RETRACE_ATR * pos.atr;
        const slDist = HARD_SL_ATR * pos.atr;
        const slPrice = pos.side === "LONG" ? pos.entry - slDist : pos.entry + slDist;
        if (pos.side === "LONG") {
          if (bar.low <= slPrice) {
            const pnl = pos.stake * pos.lev * ((slPrice - pos.entry) / pos.entry - COST_RT);
            wallet += pos.stake + pnl; locked -= pos.stake;
            trades++; if (pnl > 0) wins++; net += pnl;
            open.splice(i, 1); continue;
          }
          if (bar.high > pos.peakFav) pos.peakFav = bar.high;
          if (!pos.armed && pos.peakFav >= pos.entry + armDist) pos.armed = true;
          if (pos.armed && bar.low <= pos.peakFav - trailDist) {
            const exit = pos.peakFav - trailDist;
            const pnl = pos.stake * pos.lev * ((exit - pos.entry) / pos.entry - COST_RT);
            wallet += pos.stake + pnl; locked -= pos.stake;
            trades++; if (pnl > 0) wins++; net += pnl;
            open.splice(i, 1); continue;
          }
        } else {
          if (bar.high >= slPrice) {
            const pnl = pos.stake * pos.lev * ((pos.entry - slPrice) / pos.entry - COST_RT);
            wallet += pos.stake + pnl; locked -= pos.stake;
            trades++; if (pnl > 0) wins++; net += pnl;
            open.splice(i, 1); continue;
          }
          if (bar.low < pos.peakFav) pos.peakFav = bar.low;
          if (!pos.armed && pos.peakFav <= pos.entry - armDist) pos.armed = true;
          if (pos.armed && bar.high >= pos.peakFav + trailDist) {
            const exit = pos.peakFav + trailDist;
            const pnl = pos.stake * pos.lev * ((pos.entry - exit) / pos.entry - COST_RT);
            wallet += pos.stake + pnl; locked -= pos.stake;
            trades++; if (pnl > 0) wins++; net += pnl;
            open.splice(i, 1); continue;
          }
        }
      }
      // opens
      const sigs = sigByEpoch.get(e);
      if (sigs) {
        for (const sig of sigs) {
          if (wallet < STAKE) continue;
          if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
          const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
          open.push({
            ruleId: sig.ruleId, asset: sig.asset, side: sig.side,
            entry: sig.nextOpenPrice, atr: sig.atr, lev,
            openEpoch: sig.nextBarEpoch, stake: STAKE,
            peakFav: sig.nextOpenPrice, armed: false,
          });
          wallet -= STAKE; locked += STAKE;
        }
      }
      // Track equity
      const equity = wallet + locked;
      if (equity > maxEquity) maxEquity = equity;
      if (equity < minEquity) minEquity = equity;
    }
    // Close any remaining at end of month at last available price
    for (const pos of open) {
      const data = assetData.get(pos.asset)!;
      const last = data.bars1m[data.bars1m.length - 1];
      const exit = last.close;
      const gross = pos.side === "LONG" ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
      const pnl = pos.stake * pos.lev * (gross - COST_RT);
      wallet += pos.stake + pnl; locked -= pos.stake;
      trades++; if (pnl > 0) wins++; net += pnl;
    }
    const maxDD = (maxEquity - minEquity) / maxEquity;
    results.push({ id: m.id, trades, wins, netDollars: net, endWallet: wallet, maxEquity, minEquity, maxDD });
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`\n══ MONTHLY DISTRIBUTION ══\n`);
  console.log(`${"month".padEnd(8)}  ${"trades".padStart(6)}  ${"WR%".padStart(5)}  ${"net$".padStart(8)}  ${"end$".padStart(8)}  ${"return%".padStart(8)}  ${"maxDD%".padStart(6)}`);
  let totalNet = 0; let totalTrades = 0; let totalWins = 0; let posMonths = 0; let negMonths = 0; let bestMonth = -Infinity; let worstMonth = Infinity;
  for (const r of results) {
    const wr = r.trades ? r.wins / r.trades * 100 : 0;
    const ret = (r.endWallet / START_WALLET - 1) * 100;
    const tag = r.netDollars > 0 ? "+" : "";
    console.log(`${r.id.padEnd(8)}  ${String(r.trades).padStart(6)}  ${wr.toFixed(0).padStart(5)}  ${tag}${r.netDollars.toFixed(2).padStart(7)}  ${r.endWallet.toFixed(2).padStart(8)}  ${(ret >= 0 ? "+" : "") + ret.toFixed(1).padStart(7)}%  ${(r.maxDD * 100).toFixed(1).padStart(5)}%`);
    totalNet += r.netDollars; totalTrades += r.trades; totalWins += r.wins;
    if (r.netDollars > 0) posMonths++; else if (r.netDollars < 0) negMonths++;
    if (r.netDollars > bestMonth) bestMonth = r.netDollars;
    if (r.netDollars < worstMonth) worstMonth = r.netDollars;
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Months:           ${results.length}  (${posMonths} positive, ${negMonths} negative)`);
  console.log(`Hit rate:         ${(posMonths / results.length * 100).toFixed(1)}%`);
  console.log(`Total trades:     ${totalTrades}`);
  console.log(`Aggregate WR:     ${(totalWins / totalTrades * 100).toFixed(1)}%`);
  console.log(`Sum of net P&L:   $${totalNet.toFixed(2)}`);
  console.log(`Best month:       +$${bestMonth.toFixed(2)}`);
  console.log(`Worst month:      ${worstMonth >= 0 ? "+" : ""}$${worstMonth.toFixed(2)}`);
  console.log(`Avg/month (independent runs): $${(totalNet / results.length).toFixed(2)}`);
  const yrs = results.length / 12;
  console.log(`Annualized average: $${(totalNet / yrs).toFixed(2)} on $100 (independent runs)`);

  // Save
  fs.writeFileSync(`${RESULTS_DIR}/monthly-distribution.json`, JSON.stringify(results, null, 2));
  console.log(`\nSaved → ${RESULTS_DIR}/monthly-distribution.json`);
}

main().catch(e => { console.error(e); process.exit(1); });

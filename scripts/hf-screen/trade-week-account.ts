// Replay the past week (May 19 → May 25 UTC) with the 5 CV-survivor rules,
// simulating a $100 account, $20 stake per trade, and PER-ASSET MAX LEVERAGE
// (BTC/ETH=125×, alts=75×, LDO/AAVE/UNI/POL=50×). Track wallet, concurrent
// positions, margin gating, and per-day equity curve.
//
// Run: npx tsx scripts/hf-screen/trade-week-account.ts

import * as fs from "fs";
import {
  ASSETS, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

// Per-asset max leverage (matches main/engine/risk-rules.ts PER_ASSET_MAX_LEV)
const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};

const START_WALLET = 100;
const STAKE = 20;
// Defaults are last week ending today. Override via env:
//   START=2023-05-01 END=2023-06-01 npx tsx ...
const WEEK_END = Math.floor(new Date(process.env.END ?? "2026-05-26T00:00:00Z").getTime() / 1000);
const WEEK_START = process.env.START
  ? Math.floor(new Date(process.env.START).getTime() / 1000)
  : (WEEK_END - 7 * 86400);

// Load TRAIN-locked breakpoints from CV output
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

type OpenPos = { id: number; ruleId: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; bars1mPtr: Bar[]; startIdx: number };
type ClosedTrade = { ruleId: string; asset: string; side: Side; entry: number; exit: number; lev: number; pnl: number; openEpoch: number; closeEpoch: number; reason: string };

let nextId = 1;
function exitCheck(pos: OpenPos, bar: Bar): { triggered: boolean; exit: number; reason: string } | null {
  const armDist = TRAIL_ARM_ATR * pos.atr;
  const trailDist = TRAIL_RETRACE_ATR * pos.atr;
  const slDist = HARD_SL_ATR * pos.atr;
  const slPrice = pos.side === "LONG" ? pos.entry - slDist : pos.entry + slDist;
  // We don't track peak here; recompute on demand by re-walking from open.
  // For accuracy in week sim, just check SL and trail-arm by recomputing peak per minute.
  return null; // (handled inline in main loop)
}

type TimedSignal = { epoch: number; asset: string; ruleId: string; side: Side; nextBarEpoch: number; nextOpenPrice: number; atr: number };

async function main() {
  const startStr = new Date(WEEK_START * 1000).toISOString().slice(0, 10);
  const endStr = new Date(WEEK_END * 1000).toISOString().slice(0, 10);
  console.log(`\n══ Week account sim: ${startStr} → ${endStr} ══`);
  console.log(`Wallet $${START_WALLET}  |  Stake $${STAKE}  |  Per-asset max lev (BTC/ETH 125×, alts 75×, LDO/AAVE/UNI/POL 50×)`);
  console.log(`Exit: trail-arm ${TRAIL_ARM_ATR}/${TRAIL_RETRACE_ATR}×ATR + hard SL ${HARD_SL_ATR}×ATR + ${HARD_TIMEOUT_MIN}m timeout\n`);

  // ── 1. Generate all signals across the week, per asset ──────────────────
  const allSignals: TimedSignal[] = [];
  const minMaps = new Map<string, Map<number, number>>();
  const bars1mByAsset = new Map<string, Bar[]>();

  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const bars1m = load1m(sym, WEEK_START - 30 * 86400, WEEK_END + 86400);
    if (bars1m.length === 0) { console.log("no data"); continue; }
    bars1mByAsset.set(sym, bars1m);
    minMaps.set(sym, buildMinuteIdx(bars1m));
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);
    const atrArr = new Float64Array(bars15m.length);
    const ema50_1hArr = new Float64Array(bars1h.length);
    for (let i = 0; i < bars15m.length; i++) atrArr[i] = atrFn(bars15m, 14, i);
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = emaFn(closes1h, 50, i);

    let fired = 0;
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < WEEK_START || b.epoch >= WEEK_END) continue;
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
        allSignals.push({ epoch: b.epoch, asset: sym, ruleId: rule.id, side, nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i] });
        fired++;
      }
    }
    console.log(`${fired} signals`);
  }
  // Sort signals by next-bar (entry) epoch — that's when the trade actually opens
  allSignals.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);
  console.log(`\nTotal signals fired across the week: ${allSignals.length}`);

  // ── 2. Walk minute-by-minute, manage wallet + open positions ───────────
  let wallet = START_WALLET;
  let walletLocked = 0;  // margin held by open positions
  const open: OpenPos[] = [];
  const closed: ClosedTrade[] = [];
  const skipped: { reason: string; sig: TimedSignal }[] = [];
  // Daily equity snapshot
  const dailyEquity: { day: string; closeWallet: number; openMargin: number; trades: number; closes: number }[] = [];
  let lastDay = "";

  // Build a unified minute timeline: union of all 1m epochs across all assets
  const epochSet = new Set<number>();
  for (const sym of bars1mByAsset.keys()) {
    const arr = bars1mByAsset.get(sym)!;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].epoch >= WEEK_START - 60 && arr[i].epoch < WEEK_END + 86400) epochSet.add(arr[i].epoch);
    }
  }
  const allEpochs = Array.from(epochSet).sort((a, b) => a - b);
  const sigIdx = new Map<number, TimedSignal[]>();
  for (const s of allSignals) {
    if (!sigIdx.has(s.nextBarEpoch)) sigIdx.set(s.nextBarEpoch, []);
    sigIdx.get(s.nextBarEpoch)!.push(s);
  }

  // For exit checking, track peak fav per open position
  type OpenExt = OpenPos & { peakFav: number; armed: boolean };
  const openExt: OpenExt[] = [];

  for (const e of allEpochs) {
    if (e < WEEK_START) continue;
    if (e >= WEEK_END + 86400) break;
    const day = new Date(e * 1000).toISOString().slice(0, 10);
    if (lastDay && day !== lastDay) {
      dailyEquity.push({
        day: lastDay, closeWallet: wallet + walletLocked, openMargin: walletLocked,
        trades: openExt.length, closes: closed.length,
      });
    }
    lastDay = day;

    // Process closes first (this minute's high/low can trigger exits)
    for (let i = openExt.length - 1; i >= 0; i--) {
      const pos = openExt[i];
      const arr = bars1mByAsset.get(pos.asset)!;
      const idx = minMaps.get(pos.asset)!.get(e);
      if (idx === undefined) continue;
      const bar = arr[idx];
      // Timeout?
      if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) {
        // close at current bar close
        const exit = bar.close;
        const gross = pos.side === "LONG" ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
        const pnl = pos.stake * pos.lev * (gross - COST_RT);
        wallet += pos.stake + pnl; walletLocked -= pos.stake;
        closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: e, reason: "timeout" });
        openExt.splice(i, 1);
        continue;
      }
      const armDist = TRAIL_ARM_ATR * pos.atr;
      const trailDist = TRAIL_RETRACE_ATR * pos.atr;
      const slDist = HARD_SL_ATR * pos.atr;
      const slPrice = pos.side === "LONG" ? pos.entry - slDist : pos.entry + slDist;
      let exited = false;
      if (pos.side === "LONG") {
        if (bar.low <= slPrice) {
          const exit = slPrice;
          const gross = (exit - pos.entry) / pos.entry;
          const pnl = pos.stake * pos.lev * (gross - COST_RT);
          wallet += pos.stake + pnl; walletLocked -= pos.stake;
          closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: e, reason: "SL" });
          openExt.splice(i, 1); exited = true;
        } else {
          if (bar.high > pos.peakFav) pos.peakFav = bar.high;
          if (!pos.armed && pos.peakFav >= pos.entry + armDist) pos.armed = true;
          if (pos.armed && bar.low <= pos.peakFav - trailDist) {
            const exit = pos.peakFav - trailDist;
            const gross = (exit - pos.entry) / pos.entry;
            const pnl = pos.stake * pos.lev * (gross - COST_RT);
            wallet += pos.stake + pnl; walletLocked -= pos.stake;
            closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: e, reason: "trail" });
            openExt.splice(i, 1); exited = true;
          }
        }
      } else {
        if (bar.high >= slPrice) {
          const exit = slPrice;
          const gross = (pos.entry - exit) / pos.entry;
          const pnl = pos.stake * pos.lev * (gross - COST_RT);
          wallet += pos.stake + pnl; walletLocked -= pos.stake;
          closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: e, reason: "SL" });
          openExt.splice(i, 1); exited = true;
        } else {
          if (bar.low < pos.peakFav) pos.peakFav = bar.low;
          if (!pos.armed && pos.peakFav <= pos.entry - armDist) pos.armed = true;
          if (pos.armed && bar.high >= pos.peakFav + trailDist) {
            const exit = pos.peakFav + trailDist;
            const gross = (pos.entry - exit) / pos.entry;
            const pnl = pos.stake * pos.lev * (gross - COST_RT);
            wallet += pos.stake + pnl; walletLocked -= pos.stake;
            closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: e, reason: "trail" });
            openExt.splice(i, 1); exited = true;
          }
        }
      }
    }

    // Open new signals queued for this minute
    const sigs = sigIdx.get(e);
    if (sigs) {
      for (const sig of sigs) {
        if (wallet < STAKE) { skipped.push({ reason: "wallet<stake", sig }); continue; }
        // Skip if same asset already open with same side (mirrors live allowMultiplePerKey=false)
        if (openExt.some(p => p.asset === sig.asset && p.side === sig.side)) {
          skipped.push({ reason: "key already open", sig });
          continue;
        }
        const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
        const idx = minMaps.get(sig.asset)!.get(sig.nextBarEpoch);
        if (idx === undefined) { skipped.push({ reason: "no entry bar", sig }); continue; }
        const startIdx = idx;
        const pos: OpenExt = {
          id: nextId++, ruleId: sig.ruleId, asset: sig.asset, side: sig.side,
          entry: sig.nextOpenPrice, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch,
          stake: STAKE, bars1mPtr: bars1mByAsset.get(sig.asset)!, startIdx,
          peakFav: sig.nextOpenPrice, armed: false,
        };
        openExt.push(pos);
        wallet -= STAKE; walletLocked += STAKE;
      }
    }
  }
  // Force-close any remaining open positions at end-of-week
  for (const pos of openExt) {
    const arr = bars1mByAsset.get(pos.asset)!;
    const last = arr[arr.length - 1];
    const exit = last.close;
    const gross = pos.side === "LONG" ? (exit - pos.entry) / pos.entry : (pos.entry - exit) / pos.entry;
    const pnl = pos.stake * pos.lev * (gross - COST_RT);
    wallet += pos.stake + pnl; walletLocked -= pos.stake;
    closed.push({ ruleId: pos.ruleId, asset: pos.asset, side: pos.side, entry: pos.entry, exit, lev: pos.lev, pnl, openEpoch: pos.openEpoch, closeEpoch: last.epoch, reason: "endofweek" });
  }
  if (lastDay) dailyEquity.push({ day: lastDay, closeWallet: wallet + walletLocked, openMargin: walletLocked, trades: 0, closes: closed.length });

  // ── 3. Report ──────────────────────────────────────────────────────────
  console.log(`\nStarting wallet: $${START_WALLET.toFixed(2)}`);
  console.log(`Ending wallet:   $${wallet.toFixed(2)}   (delta: ${wallet >= START_WALLET ? "+" : ""}$${(wallet - START_WALLET).toFixed(2)})`);
  console.log(`Total trades:    ${closed.length}`);
  console.log(`Wins / Losses:   ${closed.filter(t => t.pnl > 0).length} / ${closed.filter(t => t.pnl <= 0).length}`);
  console.log(`Win rate:        ${(closed.filter(t => t.pnl > 0).length / Math.max(1, closed.length) * 100).toFixed(1)}%`);
  console.log(`Net P&L:         ${closed.reduce((s, t) => s + t.pnl, 0) > 0 ? "+" : ""}$${closed.reduce((s, t) => s + t.pnl, 0).toFixed(2)}`);
  console.log(`Skipped:         ${skipped.length}  (${skipped.filter(s => s.reason === "key already open").length} dup-key, ${skipped.filter(s => s.reason === "wallet<stake").length} no-margin)`);

  console.log(`\nDaily equity curve:`);
  console.log(`  ${"day".padEnd(10)}  ${"equity$".padStart(8)}  ${"margin$".padStart(8)}  ${"closed".padStart(6)}`);
  let lastWallet = START_WALLET;
  let prevCloses = 0;
  for (const d of dailyEquity) {
    const dailyClosed = d.closes - prevCloses;
    const dailyPnl = d.closeWallet - lastWallet;
    console.log(`  ${d.day}  ${d.closeWallet.toFixed(2).padStart(8)}  ${d.openMargin.toFixed(2).padStart(8)}  ${String(dailyClosed).padStart(6)}  ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`);
    lastWallet = d.closeWallet;
    prevCloses = d.closes;
  }

  console.log(`\nPer-rule:`);
  for (const r of RULES) {
    const ts = closed.filter(t => t.ruleId === r.id);
    if (ts.length === 0) { console.log(`  ${r.id}  0 trades`); continue; }
    const wins = ts.filter(t => t.pnl > 0).length;
    const net = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${r.id}  n=${String(ts.length).padStart(3)}  WR=${(wins / ts.length * 100).toFixed(0).padStart(3)}%  net=$${net.toFixed(2).padStart(7)}`);
  }

  console.log(`\nPer-asset:`);
  const byAsset: Record<string, { n: number; w: number; net: number; lev: number }> = {};
  for (const t of closed) {
    if (!byAsset[t.asset]) byAsset[t.asset] = { n: 0, w: 0, net: 0, lev: t.lev };
    byAsset[t.asset].n++;
    if (t.pnl > 0) byAsset[t.asset].w++;
    byAsset[t.asset].net += t.pnl;
  }
  const sorted = Object.entries(byAsset).sort((a, b) => b[1].net - a[1].net);
  for (const [a, s] of sorted) {
    console.log(`  ${a.padEnd(10)} ${String(s.lev).padStart(3)}×  n=${String(s.n).padStart(3)}  WR=${(s.w / s.n * 100).toFixed(0).padStart(3)}%  net=$${s.net.toFixed(2).padStart(7)}`);
  }

  console.log(`\n══ Final account: $${wallet.toFixed(2)} (${wallet >= START_WALLET ? "+" : ""}${((wallet / START_WALLET - 1) * 100).toFixed(1)}% return on $${START_WALLET}) ══`);
}

main().catch(e => { console.error(e); process.exit(1); });

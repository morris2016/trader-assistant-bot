// Replay TODAY (2026-05-26) with the live HF stack (BB_UP_SHORT + BB_LOW_LONG).
// Same exit model + sizing as trade-today-filtered.ts so the comparison is
// apples-to-apples. Reports two variants: naked BB and BB + quality filter
// (hour ∈ [12,22] + bbWidth pct + vol pct).
//
// Run: npx tsx scripts/hf-screen/trade-today-hf.ts

import {
  ASSETS, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, bb as bbFn, sma as smaFn,
  alignTo1h, buildMinuteIdx,
  type Bar,
} from "./lib";

const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
const TODAY_START = Math.floor(new Date("2026-05-26T00:00:00Z").getTime() / 1000);
const TODAY_END = Math.floor(new Date("2026-05-27T00:00:00Z").getTime() / 1000);
const START_WALLET = 100;
const STAKE = 20;

type Side = "LONG" | "SHORT";

function pctileRank(sorted: number[], v: number): number {
  if (!sorted.length) return 0.5;
  let lo = 0, hi = sorted.length - 1, idx = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m] <= v) { idx = m + 1; lo = m + 1; } else hi = m - 1;
  }
  return idx / sorted.length;
}

type Signal = {
  asset: string; pattern: "BB_LOW_LONG" | "BB_UP_SHORT"; side: Side;
  nextBarEpoch: number; nextOpenPrice: number; atr: number;
  hourUtc: number; bbWidthPct: number; volPct: number;
};

async function runVariant(label: string, useQualityFilter: boolean) {
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();

  for (const sym of ASSETS) {
    const bars1m = load1m(sym, TODAY_START - 30 * 86400, TODAY_END);
    if (bars1m.length === 0) continue;
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const closes15m = bars15m.map(b => b.close);
    const vols15m = bars15m.map(b => b.volume);
    const atrArr = new Float64Array(bars15m.length);
    const bbWidthArr = new Float64Array(bars15m.length);
    const bbObjArr: ({ mid: number; upper: number; lower: number } | null)[] = [];
    for (let i = 0; i < bars15m.length; i++) {
      atrArr[i] = atrFn(bars15m, 14, i);
      const b = bbFn(closes15m, 20, 2.0, i);
      bbObjArr.push(b);
      bbWidthArr[i] = b ? (b.upper - b.lower) / b.mid : NaN;
    }

    const signals: Signal[] = [];
    for (let i = 60; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (b.epoch < TODAY_START || b.epoch >= TODAY_END) continue;
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const bb = bbObjArr[i]; if (!bb) continue;

      // Detect BB pierce
      let pattern: "BB_LOW_LONG" | "BB_UP_SHORT" | null = null;
      let side: Side | null = null;
      if (b.high >= bb.upper && b.close < bb.upper) { pattern = "BB_UP_SHORT"; side = "SHORT"; }
      else if (b.low <= bb.lower && b.close > bb.lower) { pattern = "BB_LOW_LONG"; side = "LONG"; }
      if (!pattern || !side) continue;

      // Quality filter context
      const bbSlice: number[] = []; const volSlice: number[] = [];
      for (let j = i - 59; j <= i; j++) {
        if (isFinite(bbWidthArr[j])) bbSlice.push(bbWidthArr[j]);
        volSlice.push(vols15m[j]);
      }
      bbSlice.sort((a, b) => a - b); volSlice.sort((a, b) => a - b);
      const bbWidthPct = pctileRank(bbSlice, bbWidthArr[i]);
      const volPct = pctileRank(volSlice, vols15m[i]);
      const hourUtc = new Date(b.epoch * 1000).getUTCHours();

      if (useQualityFilter) {
        if (hourUtc < 12 || hourUtc > 22) continue;
        if (bbWidthPct < 0.50) continue;
        if (volPct < 0.50) continue;
      }

      const next = bars15m[i + 1];
      signals.push({
        asset: sym, pattern, side,
        nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i],
        hourUtc, bbWidthPct, volPct,
      });
    }
    assetData.set(sym, { bars1m, minMap, signals });
  }

  // Walk minute-by-minute
  let wallet = START_WALLET, locked = 0;
  type OpenPos = { pattern: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; peakFav: number; armed: boolean };
  const open: OpenPos[] = [];
  type Trade = { pattern: string; asset: string; side: Side; entry: number; exit: number; pnl: number; openTs: string; closeTs: string; reason: string; stake: number; lev: number };
  const trades: Trade[] = [];
  const epochSet = new Set<number>();
  for (const d of assetData.values()) for (const b of d.bars1m) if (b.epoch >= TODAY_START && b.epoch < TODAY_END + HARD_TIMEOUT_MIN * 60) epochSet.add(b.epoch);
  const sortedE = Array.from(epochSet).sort((a, b) => a - b);
  const sigByEp = new Map<number, Signal[]>();
  let total = 0;
  for (const d of assetData.values()) for (const s of d.signals) {
    if (!sigByEp.has(s.nextBarEpoch)) sigByEp.set(s.nextBarEpoch, []);
    sigByEp.get(s.nextBarEpoch)!.push(s);
    total++;
  }

  for (const e of sortedE) {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const data = assetData.get(pos.asset)!;
      const idx = data.minMap.get(e); if (idx === undefined) continue;
      const bar = data.bars1m[idx];
      const armD = TRAIL_ARM_ATR * pos.atr, trD = TRAIL_RETRACE_ATR * pos.atr, slD = HARD_SL_ATR * pos.atr;
      const slPx = pos.side === "LONG" ? pos.entry - slD : pos.entry + slD;
      let closed = false, exitPx = 0, reason = "";
      if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) { exitPx = bar.close; closed = true; reason = "timeout"; }
      else if (pos.side === "LONG") {
        if (bar.low <= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.high > pos.peakFav) pos.peakFav = bar.high;
          if (!pos.armed && pos.peakFav >= pos.entry + armD) pos.armed = true;
          if (pos.armed && bar.low <= pos.peakFav - trD) { exitPx = pos.peakFav - trD; closed = true; reason = "trail"; }
        }
      } else {
        if (bar.high >= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.low < pos.peakFav) pos.peakFav = bar.low;
          if (!pos.armed && pos.peakFav <= pos.entry - armD) pos.armed = true;
          if (pos.armed && bar.high >= pos.peakFav + trD) { exitPx = pos.peakFav + trD; closed = true; reason = "trail"; }
        }
      }
      if (closed) {
        const gross = pos.side === "LONG" ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry;
        const pnl = pos.stake * pos.lev * (gross - COST_RT);
        wallet += pos.stake + pnl; locked -= pos.stake;
        trades.push({
          pattern: pos.pattern, asset: pos.asset, side: pos.side, entry: pos.entry, exit: exitPx, pnl,
          openTs: new Date(pos.openEpoch * 1000).toISOString().slice(11, 16),
          closeTs: new Date(e * 1000).toISOString().slice(11, 16),
          reason, stake: pos.stake, lev: pos.lev,
        });
        open.splice(i, 1);
      }
    }
    const sigs = sigByEp.get(e);
    if (sigs) for (const sig of sigs) {
      if (wallet < STAKE) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      open.push({
        pattern: sig.pattern, asset: sig.asset, side: sig.side,
        entry: sig.nextOpenPrice, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch,
        stake: STAKE, peakFav: sig.nextOpenPrice, armed: false,
      });
      wallet -= STAKE; locked += STAKE;
    }
  }

  console.log(`\n══ ${label} ══`);
  console.log(`Total signals fired:  ${total}`);
  console.log(`Closed trades:        ${trades.length}`);
  const wins = trades.filter(t => t.pnl > 0).length;
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  console.log(`Wins / Losses:        ${wins} / ${trades.length - wins}`);
  console.log(`Win rate:             ${trades.length ? (wins / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`Net P&L:              ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`Wallet end:           $${(wallet + locked).toFixed(2)}  (open: ${open.length})`);
  console.log(`\nAll trades chronological:`);
  for (const t of trades) {
    const tag = t.pnl > 0 ? "✓" : "✗";
    console.log(`  ${t.openTs}→${t.closeTs}  ${t.asset.padEnd(10)} ${t.pattern.padEnd(13)} ${t.side.padEnd(5)} $${t.stake}×${t.lev}× pnl=${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2).padStart(6)} ${tag} ${t.reason}`);
  }
  return { trades: trades.length, wins, totalPnl, endWallet: wallet + locked };
}

async function main() {
  console.log(`\n╔═════════════════════════════════════════════════════════════════╗`);
  console.log(`║ HF (BB stack) replay — 2026-05-26 UTC                            ║`);
  console.log(`║ $100 wallet, $20 stake, per-asset max lev, trail-arm + 1×ATR SL  ║`);
  console.log(`╚═════════════════════════════════════════════════════════════════╝`);

  const naked = await runVariant("Variant A: naked BB (no quality filter)", false);
  const filtered = await runVariant("Variant B: BB + quality filter (hr 12-22, bbWidth≥50%, vol≥50%)", true);

  console.log(`\n╔═════════════════════════════════════════════════════════════════╗`);
  console.log(`║ COMPARISON TABLE (today)                                         ║`);
  console.log(`╠═════════════════════════════════════════════════════════════════╣`);
  console.log(`║ Mined+filtered+sized:    5 trades   80.0% WR   +$16.69          ║`);
  console.log(`║ HF naked BB:             ${String(naked.trades).padEnd(3)} trades   ${naked.trades ? (naked.wins / naked.trades * 100).toFixed(1).padStart(4) : "  0.0"}% WR   ${naked.totalPnl >= 0 ? "+" : ""}$${naked.totalPnl.toFixed(2).padEnd(8)}             ║`);
  console.log(`║ HF BB + quality filter:  ${String(filtered.trades).padEnd(3)} trades   ${filtered.trades ? (filtered.wins / filtered.trades * 100).toFixed(1).padStart(4) : "  0.0"}% WR   ${filtered.totalPnl >= 0 ? "+" : ""}$${filtered.totalPnl.toFixed(2).padEnd(8)}             ║`);
  console.log(`╚═════════════════════════════════════════════════════════════════╝`);
}

main().catch(e => { console.error(e); process.exit(1); });

// REAL Binance Futures simulation with realistic costs:
//   1. Taker fees: 0.04% per side (0.08% round-trip), no VIP discount
//   2. Per-asset slippage (BTC/ETH tight, low-caps wider) — applied at entry AND exit
//   3. Funding rate: 0.01% per 8h cycle if position spans 00/08/16 UTC mark
//   4. Min notional check: skip if stake × lev < $5 (Binance default min)
//   5. Isolated margin: loss capped at -stake (already implicit via SL)
//   6. Entry latency: signal at bar close → order at +1s, fill at next-bar-open + half-spread
//
// Reports today (May 26) and last 7 days under realistic conditions vs the
// idealized sim used previously.
//
// Run: npx tsx scripts/hf-screen/real-binance-sim.ts
// Override: DAY=2026-05-26 DAYS=7 npx tsx ...

import * as fs from "fs";
import {
  ASSETS,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

// ── Real Binance Futures cost model ────────────────────────────────────
const FEE_TAKER = 0.0004;                  // 0.04% per side
const FEE_RT    = FEE_TAKER * 2;           // 0.08% round-trip

// Per-asset slippage in bps PER SIDE (conservative estimates based on typical book depth)
const SLIPPAGE_BPS_PER_SIDE: Record<string, number> = {
  BTCUSDT: 0.3, ETHUSDT: 0.4,
  SOLUSDT: 1.0, BNBUSDT: 0.7, XRPUSDT: 1.2,
  DOGEUSDT: 1.5, AVAXUSDT: 1.5, ADAUSDT: 1.2, LINKUSDT: 1.5,
  DOTUSDT: 1.5, BCHUSDT: 1.0,
  LDOUSDT: 2.5, UNIUSDT: 2.0, AAVEUSDT: 2.0, POLUSDT: 2.5,
};
const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
const FUNDING_RATE_PER_8H = 0.0001;         // 0.01% per 8h cycle (avg)
const MIN_NOTIONAL = 5;                     // Binance Futures default min

const DAY_STR = process.env.DAY ?? "2026-05-26";
const DAYS = +(process.env.DAYS ?? "1");
const TODAY_END = Math.floor(new Date(`${DAY_STR}T00:00:00Z`).getTime() / 1000) + 86400;
const TODAY_START = TODAY_END - DAYS * 86400;
const TRAIN_FROM = Math.floor(new Date("2025-05-26T00:00:00Z").getTime() / 1000);
const TRAIN_TO   = Math.floor(new Date("2025-12-31T23:59:59Z").getTime() / 1000);
const START_WALLET = 100;

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
  M1: [undefined, undefined, 20, 25, 30],
  M2: [25, 25, 25, 25, undefined],
  M3: [undefined, undefined, 20, 25, 30],
  M4: [undefined, undefined, 20, 25, 30],
  M5: [20, 20, undefined, undefined, undefined],
};

type Signal = {
  asset: string; ruleId: string; side: Side;
  nextBarEpoch: number; nextOpenPrice: number; atr: number;
  strength: number; qstr: number; stake: number | undefined;
};

// Funding cycles: 00, 08, 16 UTC
function fundingCycleBoundariesBetween(openEp: number, closeEp: number): number[] {
  const boundaries: number[] = [];
  let cycle = Math.floor(openEp / (8 * 3600)) * (8 * 3600);
  while (cycle <= closeEp) {
    if (cycle >= openEp && cycle <= closeEp) boundaries.push(cycle);
    cycle += 8 * 3600;
  }
  return boundaries;
}

async function main() {
  console.log(`\n══ REAL Binance sim — ${DAY_STR} window (${DAYS}d) ══`);
  console.log(`Cost model:`);
  console.log(`  Taker fee: 0.04% × 2 sides = 0.08% RT`);
  console.log(`  Per-asset slippage: ${Object.entries(SLIPPAGE_BPS_PER_SIDE).slice(0, 5).map(([k, v]) => `${k}=${v}bp`).join(", ")} ... (per side)`);
  console.log(`  Funding: 0.01% per 8h cycle if position spans 00/08/16 UTC`);
  console.log(`  Min notional: $${MIN_NOTIONAL}`);
  console.log(`  Wallet: $${START_WALLET}, per-asset max leverage\n`);

  // ── Load + generate signals ─────────────────────────────────────────────
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();
  for (const sym of ASSETS) {
    const bars1m = load1m(sym, TRAIN_FROM - 30 * 86400, TODAY_END);
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
        signals.push({
          asset: sym, ruleId: rule.id, side,
          nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i],
          strength: rule.strength(f), qstr: -1, stake: undefined,
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
  }

  // ── TRAIN-derived strength quintile breakpoints ─────────────────────────
  const breaks: Record<string, number[]> = {};
  for (const r of RULES) {
    const ss: number[] = [];
    for (const d of assetData.values()) for (const s of d.signals) if (s.ruleId === r.id && s.nextBarEpoch >= TRAIN_FROM && s.nextBarEpoch <= TRAIN_TO) ss.push(s.strength);
    ss.sort((a, b) => a - b);
    if (ss.length === 0) continue;
    breaks[r.id] = [ss[Math.floor(ss.length * 0.2)], ss[Math.floor(ss.length * 0.4)], ss[Math.floor(ss.length * 0.6)], ss[Math.floor(ss.length * 0.8)]];
  }

  // ── Filter + assign stake ──────────────────────────────────────────────
  const windowSigs: Signal[] = [];
  for (const d of assetData.values()) {
    for (const s of d.signals) {
      if (s.nextBarEpoch < TODAY_START || s.nextBarEpoch >= TODAY_END) continue;
      const b = breaks[s.ruleId]; if (!b) continue;
      let q = 0; for (const t of b) if (s.strength >= t) q++;
      s.qstr = q;
      const st = SCHEDULE[s.ruleId][q];
      if (st !== undefined) {
        // Min notional check: stake × lev must be ≥ $5
        const lev = PER_ASSET_MAX_LEV[s.asset] ?? 75;
        if (st * lev < MIN_NOTIONAL) continue;
        s.stake = st;
        windowSigs.push(s);
      }
    }
  }
  windowSigs.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);
  console.log(`Signals after filter: ${windowSigs.length}\n`);

  // ── Wallet sim with realistic per-trade cost ───────────────────────────
  let wallet = START_WALLET, locked = 0;
  type OpenPos = { ruleId: string; asset: string; side: Side; entry: number; entryFillPx: number; atr: number; lev: number; openEpoch: number; stake: number; peakFav: number; armed: boolean; slipEnter: number };
  const open: OpenPos[] = [];
  type Trade = {
    ruleId: string; asset: string; side: Side; qstr: number; stake: number; lev: number;
    entry: number; entryFillPx: number; exit: number; exitFillPx: number;
    grossPct: number; grossPnl: number;
    feeCost: number; slipCost: number; fundingCost: number; netPnl: number;
    openTs: string; closeTs: string; reason: string;
  };
  const trades: Trade[] = [];

  const epochSet = new Set<number>();
  for (const d of assetData.values()) for (const b of d.bars1m) if (b.epoch >= TODAY_START && b.epoch < TODAY_END + HARD_TIMEOUT_MIN * 60) epochSet.add(b.epoch);
  const sortedE = Array.from(epochSet).sort((a, b) => a - b);
  const sigByEp = new Map<number, Signal[]>();
  for (const s of windowSigs) {
    if (!sigByEp.has(s.nextBarEpoch)) sigByEp.set(s.nextBarEpoch, []);
    sigByEp.get(s.nextBarEpoch)!.push(s);
  }

  for (const e of sortedE) {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const data = assetData.get(pos.asset)!;
      const idx = data.minMap.get(e); if (idx === undefined) continue;
      const bar = data.bars1m[idx];
      const armD = TRAIL_ARM_ATR * pos.atr, trD = TRAIL_RETRACE_ATR * pos.atr, slD = HARD_SL_ATR * pos.atr;
      const slPx = pos.side === "LONG" ? pos.entryFillPx - slD : pos.entryFillPx + slD;
      let closed = false, exitPx = 0, reason = "";
      if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) { exitPx = bar.close; closed = true; reason = "timeout"; }
      else if (pos.side === "LONG") {
        if (bar.low <= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.high > pos.peakFav) pos.peakFav = bar.high;
          if (!pos.armed && pos.peakFav >= pos.entryFillPx + armD) pos.armed = true;
          if (pos.armed && bar.low <= pos.peakFav - trD) { exitPx = pos.peakFav - trD; closed = true; reason = "trail"; }
        }
      } else {
        if (bar.high >= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.low < pos.peakFav) pos.peakFav = bar.low;
          if (!pos.armed && pos.peakFav <= pos.entryFillPx - armD) pos.armed = true;
          if (pos.armed && bar.high >= pos.peakFav + trD) { exitPx = pos.peakFav + trD; closed = true; reason = "trail"; }
        }
      }
      if (closed) {
        const slipBps = SLIPPAGE_BPS_PER_SIDE[pos.asset] ?? 1.5;
        const slipDecExit = slipBps / 10000;
        // Adverse exit fill: LONG sells, gets slip below; SHORT buys, gets slip above
        const exitFillPx = pos.side === "LONG" ? exitPx * (1 - slipDecExit) : exitPx * (1 + slipDecExit);
        const grossPct = pos.side === "LONG" ? (exitFillPx - pos.entryFillPx) / pos.entryFillPx : (pos.entryFillPx - exitFillPx) / pos.entryFillPx;
        const notional = pos.stake * pos.lev;
        const grossPnl = notional * grossPct;
        const feeCost = notional * FEE_RT;
        const slipCost = notional * (pos.slipEnter / 10000 + slipDecExit);  // slip already in fill, this is informational
        // Funding cost: 0.01% × notional per cycle boundary crossed
        const cycles = fundingCycleBoundariesBetween(pos.openEpoch, e);
        // For SHORT, funding is typically received if rate is positive (we treat as positive expected ≈ 0)
        // Conservative: charge fee for LONG, neutral for SHORT (since shorts often receive funding)
        const fundingCost = pos.side === "LONG" ? cycles.length * notional * FUNDING_RATE_PER_8H : 0;
        // Net pnl: gross is already AFTER fill-slip, just subtract fees + funding
        const netPnl = grossPnl - feeCost - fundingCost;
        // Apply liquidation cap: loss can't exceed -stake (isolated margin)
        const cappedPnl = Math.max(netPnl, -pos.stake);
        wallet += pos.stake + cappedPnl; locked -= pos.stake;
        trades.push({
          ruleId: pos.ruleId, asset: pos.asset, side: pos.side, qstr: 0, stake: pos.stake, lev: pos.lev,
          entry: pos.entry, entryFillPx: pos.entryFillPx, exit: exitPx, exitFillPx,
          grossPct, grossPnl, feeCost, slipCost, fundingCost, netPnl: cappedPnl,
          openTs: new Date(pos.openEpoch * 1000).toISOString().slice(11, 16),
          closeTs: new Date(e * 1000).toISOString().slice(11, 16),
          reason,
        });
        open.splice(i, 1);
      }
    }
    const sigs = sigByEp.get(e);
    if (sigs) for (const sig of sigs) {
      if (wallet < sig.stake!) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      // Entry fill: market order, adverse slip
      const slipBps = SLIPPAGE_BPS_PER_SIDE[sig.asset] ?? 1.5;
      const slipDec = slipBps / 10000;
      const entryFillPx = sig.side === "LONG" ? sig.nextOpenPrice * (1 + slipDec) : sig.nextOpenPrice * (1 - slipDec);
      open.push({
        ruleId: sig.ruleId, asset: sig.asset, side: sig.side,
        entry: sig.nextOpenPrice, entryFillPx, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch,
        stake: sig.stake!, peakFav: entryFillPx, armed: false, slipEnter: slipBps,
      });
      wallet -= sig.stake!; locked += sig.stake!;
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────
  console.log(`\nWallet start: $${START_WALLET.toFixed(2)}`);
  console.log(`Wallet now:   $${(wallet + locked).toFixed(2)}  (cash $${wallet.toFixed(2)}, open margin $${locked.toFixed(2)})`);
  const totalNet = trades.reduce((s, t) => s + t.netPnl, 0);
  const totalGross = trades.reduce((s, t) => s + t.grossPnl, 0);
  const totalFee = trades.reduce((s, t) => s + t.feeCost, 0);
  const totalFunding = trades.reduce((s, t) => s + t.fundingCost, 0);
  const wins = trades.filter(t => t.netPnl > 0).length;
  console.log(`Closed trades: ${trades.length}  Wins: ${wins}  WR: ${(wins / Math.max(1, trades.length) * 100).toFixed(1)}%`);
  console.log(`\nCost breakdown:`);
  console.log(`  Gross P&L (after fill-slip):   ${totalGross >= 0 ? "+" : ""}$${totalGross.toFixed(2)}`);
  console.log(`  Fees:                          $${totalFee.toFixed(2)}`);
  console.log(`  Funding:                       $${totalFunding.toFixed(2)}`);
  console.log(`  ─────────────────────────────────`);
  console.log(`  NET P&L:                       ${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(2)}`);
  console.log(`  Avg cost drag per trade:       $${((totalFee + totalFunding) / Math.max(1, trades.length)).toFixed(3)}`);

  console.log(`\nAll trades (chronological):`);
  console.log(`  ${"time".padEnd(13)} ${"asset".padEnd(10)} ${"side".padEnd(5)} ${"rule".padEnd(2)} ${"stake×lev".padEnd(11)} ${"gross$".padStart(7)} ${"fee$".padStart(6)} ${"net$".padStart(7)}  result`);
  for (const t of trades) {
    const tag = t.netPnl > 0 ? "✓" : "✗";
    console.log(`  ${t.openTs}→${t.closeTs} ${t.asset.padEnd(10)} ${t.side.padEnd(5)} ${t.ruleId} $${t.stake}×${t.lev}×    ${t.grossPnl.toFixed(2).padStart(7)} ${t.feeCost.toFixed(2).padStart(6)} ${t.netPnl.toFixed(2).padStart(7)} ${tag} ${t.reason}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });

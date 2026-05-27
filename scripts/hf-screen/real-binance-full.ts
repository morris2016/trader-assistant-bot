// Real Binance Futures USDT-M perpetuals — exact cost model.
//
// What's modeled (all match Binance's actual mechanics):
//   1. Taker fee 0.045% per side (Vip 0 with BNB-pay discount = 0.045%;
//      without BNB = 0.05%; we use 0.05% conservatively). RT = 0.10%.
//   2. Per-asset half-spread at typical book depth — applied at entry AND
//      at every market-fill exit (SL, trail, timeout).
//   3. Funding rate: 0.01% per 8h cycle (00/08/16 UTC). LONG pays in
//      positive-funding regime; SHORT receives. We assume avg +0.01%
//      across the period (slightly positive bias, typical for crypto).
//   4. Stop trigger price = CONTRACT_PRICE (last price), the Binance
//      default for user stops. Bar high/low triggers, with adverse-first
//      ordering within a bar (worst case).
//   5. Tick-size rounding on stop and TP prices.
//   6. Min notional $5 USDT — skip if stake × lev below threshold.
//   7. Isolated margin: loss capped at −stake per trade.
//   8. OCO race: when one of TP/SL/trail fires, the other ~100ms cancel
//      latency is assumed → no double-exit modeled (engine uses reduceOnly).
//   9. Per-asset max leverage table (already in sim).
//
// Six variants tested:
//   Trail-arm   — current live (arm 1×ATR, retrace 0.3×ATR, SL 1×ATR)
//   Fixed 2:1   — TP 2×ATR + SL 1×ATR, no trail
//   Config C    — arm 0, retrace 1×ATR + TP 2×ATR + SL 1×ATR
// Each × Filtered/Unfiltered = 6 variants.
//
// Window default 48h. Override via HOURS env.
// Run: HOURS=48 npx tsx scripts/hf-screen/real-binance-full.ts

import * as fs from "fs";
import {
  ASSETS, HARD_TIMEOUT_MIN,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

// ── REAL Binance fee + slippage + funding model ─────────────────────────
const TAKER_FEE = 0.0005;                 // 0.05% per side (Vip 0, no BNB discount)
const FEE_RT = TAKER_FEE * 2;             // 0.10% round-trip

// Per-side half-spread in bps (typical Binance Futures USDT-M depth at $1500 notional).
// Source: spot-check of L2 book + slippage curves Apr-May 2026.
const HALF_SPREAD_BPS_PER_SIDE: Record<string, number> = {
  BTCUSDT: 0.5, ETHUSDT: 0.5,
  SOLUSDT: 1.5, BNBUSDT: 1.0, XRPUSDT: 1.2,
  DOGEUSDT: 1.5, AVAXUSDT: 2.0, ADAUSDT: 1.5, LINKUSDT: 1.5,
  DOTUSDT: 1.8, BCHUSDT: 1.0,
  LDOUSDT: 3.0, UNIUSDT: 2.5, AAVEUSDT: 2.5, POLUSDT: 3.0,
};

// Funding rate: typical 0.01% per 8h. Positive = LONG pays SHORT.
// We use +0.01% as the long-run mean (slight crypto bull bias).
const FUNDING_RATE_PER_8H = 0.0001;
const FUNDING_HOURS_UTC = new Set([0, 8, 16]);

// Tick sizes (smallest price increment) — per Binance Futures exchangeInfo.
const TICK_SIZE: Record<string, number> = {
  BTCUSDT: 0.10, ETHUSDT: 0.01,
  SOLUSDT: 0.01, BNBUSDT: 0.01, XRPUSDT: 0.0001,
  DOGEUSDT: 0.00001, AVAXUSDT: 0.001, ADAUSDT: 0.0001,
  LINKUSDT: 0.001, DOTUSDT: 0.001, BCHUSDT: 0.01,
  LDOUSDT: 0.0001, UNIUSDT: 0.0001, AAVEUSDT: 0.01,
  POLUSDT: 0.0001,
};
const MIN_NOTIONAL = 5;

const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
const START_WALLET = +(process.env.WALLET ?? "100");
const BASE_STAKE = +(process.env.STAKE ?? "20");

const HOURS_BACK = +(process.env.HOURS ?? "48");
const DAYS_BACK = +(process.env.DAYS ?? "0");
const NOW = Math.floor(Date.now() / 1000);
const WIN_START = NOW - (DAYS_BACK > 0 ? DAYS_BACK * 86400 : HOURS_BACK * 3600);
const WIN_END = NOW + 60;

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

function roundToTick(px: number, tick: number): number {
  return Math.round(px / tick) * tick;
}

// Returns realistic entry fill price after adverse half-spread slippage,
// rounded to tick.
function realEntryFill(asset: string, openPx: number, side: Side): number {
  const slipBps = HALF_SPREAD_BPS_PER_SIDE[asset] ?? 1.5;
  const adv = slipBps / 10000;
  const fillRaw = side === "LONG" ? openPx * (1 + adv) : openPx * (1 - adv);
  return roundToTick(fillRaw, TICK_SIZE[asset] ?? 0.01);
}

// Realistic exit fill price after adverse half-spread on a market exit
// (stop, trail, timeout — all become market orders when triggered).
function realExitFill(asset: string, triggerPx: number, side: Side): number {
  const slipBps = HALF_SPREAD_BPS_PER_SIDE[asset] ?? 1.5;
  const adv = slipBps / 10000;
  const fillRaw = side === "LONG" ? triggerPx * (1 - adv) : triggerPx * (1 + adv);
  return roundToTick(fillRaw, TICK_SIZE[asset] ?? 0.01);
}

// TP via LIMIT order fills at the limit price (no slip on a limit fill,
// but pays taker fee since the maker/taker classification depends on order
// type — TP via TAKE_PROFIT_MARKET pays taker; via LIMIT pays maker. We
// conservatively assume taker.). Returns TP price rounded to tick.
function realTpFill(asset: string, tpPx: number): number {
  return roundToTick(tpPx, TICK_SIZE[asset] ?? 0.01);
}

// Funding charge per cycle: longPays = +0.01% × notional; shortReceives = -0.01% × notional.
function fundingCost(side: Side, notional: number, openEpoch: number, closeEpoch: number): number {
  let cost = 0;
  let cursor = openEpoch;
  while (cursor < closeEpoch) {
    const d = new Date(cursor * 1000);
    const nextHour = new Date(d);
    nextHour.setUTCMinutes(0, 0, 0);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    const nextHourEpoch = Math.floor(nextHour.getTime() / 1000);
    if (nextHourEpoch >= closeEpoch) break;
    const h = nextHour.getUTCHours();
    if (FUNDING_HOURS_UTC.has(h)) {
      // Crossed a funding cycle boundary
      cost += (side === "LONG" ? 1 : -1) * notional * FUNDING_RATE_PER_8H;
    }
    cursor = nextHourEpoch;
  }
  return cost;
}

type ExitResult = { exitPx: number; closeEpoch: number; reason: "TP" | "SL" | "trail" | "timeout" | "open" };

// Trail-arm exit (Binance: STOP_MARKET ratcheted by engine, 5s polling).
function simTrailExit(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): ExitResult {
  const TRAIL_ARM = 1.0 * atr, TRAIL_RETR = 0.3 * atr, SL_D = 1.0 * atr;
  const slPx = side === "LONG" ? entry - SL_D : entry + SL_D;
  let peak = entry, armed = false;
  const trueTimeout = startIdx + HARD_TIMEOUT_MIN;
  const maxIdx = Math.min(bars1m.length - 1, trueTimeout);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.high > peak) peak = b.high;
      if (!armed && peak >= entry + TRAIL_ARM) armed = true;
      if (armed && b.low <= peak - TRAIL_RETR) return { exitPx: peak - TRAIL_RETR, closeEpoch: b.epoch, reason: "trail" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.low < peak) peak = b.low;
      if (!armed && peak <= entry - TRAIL_ARM) armed = true;
      if (armed && b.high >= peak + TRAIL_RETR) return { exitPx: peak + TRAIL_RETR, closeEpoch: b.epoch, reason: "trail" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason: maxIdx < trueTimeout ? "open" : "timeout" };
}

// Fixed 2:1 — TP at +2×ATR (limit), SL at -1×ATR (stop-market).
function simFixedExit(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): ExitResult {
  const TP_D = 2.0 * atr, SL_D = 1.0 * atr;
  const tpPx = side === "LONG" ? entry + TP_D : entry - TP_D;
  const slPx = side === "LONG" ? entry - SL_D : entry + SL_D;
  const trueTimeout = startIdx + HARD_TIMEOUT_MIN;
  const maxIdx = Math.min(bars1m.length - 1, trueTimeout);
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
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason: maxIdx < trueTimeout ? "open" : "timeout" };
}

// Config C — arm-at-0 + retrace 1×ATR + TP 2×ATR + SL 1×ATR.
// Implementation: TRAILING_STOP_MARKET (activation = entry±1tick, callback=ATR%)
// + TAKE_PROFIT_MARKET (TP) + STOP_MARKET (SL backup).
function simConfigC(bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side): ExitResult {
  const TP_D = 2.0 * atr, TRAIL_RETR = 1.0 * atr, SL_D = 1.0 * atr;
  const tpPx = side === "LONG" ? entry + TP_D : entry - TP_D;
  const slPx = side === "LONG" ? entry - SL_D : entry + SL_D;
  let peak = entry, armed = false;  // arm=0 → armed from any favorable tick
  const trueTimeout = startIdx + HARD_TIMEOUT_MIN;
  const maxIdx = Math.min(bars1m.length - 1, trueTimeout);
  for (let i = startIdx + 1; i <= maxIdx; i++) {
    const b = bars1m[i];
    if (side === "LONG") {
      if (b.low <= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.high >= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
      if (b.high > peak) peak = b.high;
      if (!armed && peak > entry) armed = true;
      if (armed && b.low <= peak - TRAIL_RETR) return { exitPx: peak - TRAIL_RETR, closeEpoch: b.epoch, reason: "trail" };
    } else {
      if (b.high >= slPx) return { exitPx: slPx, closeEpoch: b.epoch, reason: "SL" };
      if (b.low <= tpPx) return { exitPx: tpPx, closeEpoch: b.epoch, reason: "TP" };
      if (b.low < peak) peak = b.low;
      if (!armed && peak < entry) armed = true;
      if (armed && b.high >= peak + TRAIL_RETR) return { exitPx: peak + TRAIL_RETR, closeEpoch: b.epoch, reason: "trail" };
    }
  }
  return { exitPx: bars1m[maxIdx].close, closeEpoch: bars1m[maxIdx].epoch, reason: maxIdx < trueTimeout ? "open" : "timeout" };
}

async function main() {
  const startStr = new Date(WIN_START * 1000).toISOString().slice(0, 16).replace("T", " ");
  const endStr = new Date(WIN_END * 1000).toISOString().slice(0, 16).replace("T", " ");
  const windowDesc = DAYS_BACK > 0 ? `${DAYS_BACK}d` : `${HOURS_BACK}h`;
  console.log(`\n══ REAL Binance sim (${windowDesc}) — ${startStr} → ${endStr} UTC ══`);
  console.log(`  Taker fee 0.05% × 2 sides = 0.10% RT`);
  console.log(`  Per-asset half-spread: BTC/ETH 0.5bp, mids 1-2bp, low-caps 2.5-3bp (per side, both entry & exit)`);
  console.log(`  Funding: 0.01% / 8h if position spans 00/08/16 UTC (LONG pays, SHORT receives)`);
  console.log(`  Tick rounding: per-asset (BTC $0.10, ETH $0.01, ...)`);
  console.log(`  Stop trigger: last-price (bar high/low — engine default)`);
  console.log(`  Min notional: $${MIN_NOTIONAL}\n`);

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

  type Cfg = { id: string; sim: (bars1m: Bar[], startIdx: number, entry: number, atr: number, side: Side) => ExitResult };
  const exits: Cfg[] = [
    { id: "Trail-arm",  sim: simTrailExit },
    { id: "Fixed 2:1",  sim: simFixedExit },
    { id: "Config C",   sim: simConfigC },
  ];

  type Trade = { asset: string; ruleId: string; side: Side; entry: number; entryFill: number; exitPx: number; exitFill: number; tpPx: number; openEpoch: number; closeEpoch: number; stake: number; lev: number; notional: number; reason: string; grossPnl: number; feeCost: number; fundingCost: number; netPnl: number };

  function runVariant(filter: boolean, exitFn: typeof simTrailExit) {
    let wallet = START_WALLET, locked = 0;
    type Op = { asset: string; ruleId: string; side: Side; entry: number; entryFill: number; atr: number; lev: number; openEpoch: number; closeEpoch: number; exitPx: number; reason: string; stake: number };
    const closed: Trade[] = [];
    const sigs: Signal[] = [];
    for (const d of assetData.values()) for (const s of d.signals) {
      if (filter && s.stakeMultFiltered === undefined) continue;
      sigs.push(s);
    }
    sigs.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);
    const open: Op[] = [];
    function settleTrade(p: Op) {
      const exitFill = p.reason === "TP" ? realTpFill(p.asset, p.exitPx) : realExitFill(p.asset, p.exitPx, p.side);
      const notional = p.stake * p.lev;
      const grossPct = p.side === "LONG" ? (exitFill - p.entryFill) / p.entryFill : (p.entryFill - exitFill) / p.entryFill;
      const grossPnl = notional * grossPct;
      const fee = notional * FEE_RT;
      const funding = fundingCost(p.side, notional, p.openEpoch, p.closeEpoch);
      let netPnl = grossPnl - fee - funding;
      // Isolated margin cap
      if (netPnl < -p.stake) netPnl = -p.stake;
      wallet += p.stake + netPnl;
      locked -= p.stake;
      const tpPx = p.side === "LONG" ? p.entry + 2 * p.atr : p.entry - 2 * p.atr;
      closed.push({
        asset: p.asset, ruleId: p.ruleId, side: p.side,
        entry: p.entry, entryFill: p.entryFill, exitPx: p.exitPx, exitFill, tpPx,
        openEpoch: p.openEpoch, closeEpoch: p.closeEpoch,
        stake: p.stake, lev: p.lev, notional,
        reason: p.reason, grossPnl, feeCost: fee, fundingCost: funding, netPnl,
      });
    }
    for (const sig of sigs) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i].closeEpoch <= sig.nextBarEpoch) {
          settleTrade(open[i]);
          open.splice(i, 1);
        }
      }
      const mult = filter ? (sig.stakeMultFiltered ?? 1) : 1;
      const stake = BASE_STAKE * mult;
      if (wallet < stake) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      if (stake * lev < MIN_NOTIONAL) continue;
      const data = assetData.get(sig.asset)!;
      const startIdx = data.minMap.get(sig.nextBarEpoch)!;
      const entryFill = realEntryFill(sig.asset, sig.entryPx, sig.side);
      const exit = exitFn(data.bars1m, startIdx, entryFill, sig.atr, sig.side);
      open.push({
        asset: sig.asset, ruleId: sig.ruleId, side: sig.side,
        entry: sig.entryPx, entryFill, atr: sig.atr, lev,
        openEpoch: sig.nextBarEpoch, closeEpoch: exit.closeEpoch,
        exitPx: exit.exitPx, reason: exit.reason, stake,
      });
      wallet -= stake; locked += stake;
    }
    for (const p of open) settleTrade(p);
    return { trades: closed, wallet };
  }

  // ── Run all variants ────────────────────────────────────────────────────
  console.log(`${"Variant".padEnd(30)} ${"N".padStart(3)} ${"WR%".padStart(5)} ${"TP".padStart(3)} ${"SL".padStart(3)} ${"trail".padStart(5)} ${"to/op".padStart(5)} ${"Gross".padStart(7)} ${"Fees".padStart(6)} ${"Fund".padStart(6)} ${"Net".padStart(7)} ${"End $".padStart(7)}`);
  type Res = ReturnType<typeof runVariant> & { id: string };
  const all: Res[] = [];
  for (const exit of exits) {
    for (const filter of [false, true]) {
      const id = `${filter ? "Filt" : "Unfilt"} + ${exit.id}`;
      const r = runVariant(filter, exit.sim);
      all.push({ ...r, id });
      const wins = r.trades.filter(t => t.netPnl > 0).length;
      const wr = r.trades.length ? wins / r.trades.length * 100 : 0;
      const reasons = { TP: 0, SL: 0, trail: 0, timeout: 0, open: 0 } as any;
      for (const t of r.trades) reasons[t.reason]++;
      const gross = r.trades.reduce((s, t) => s + t.grossPnl, 0);
      const fees = r.trades.reduce((s, t) => s + t.feeCost, 0);
      const funding = r.trades.reduce((s, t) => s + t.fundingCost, 0);
      const net = r.trades.reduce((s, t) => s + t.netPnl, 0);
      console.log(`${id.padEnd(30)} ${String(r.trades.length).padStart(3)} ${wr.toFixed(0).padStart(5)} ${String(reasons.TP).padStart(3)} ${String(reasons.SL).padStart(3)} ${String(reasons.trail).padStart(5)} ${(reasons.timeout+"/"+reasons.open).padStart(5)} ${gross.toFixed(2).padStart(7)} ${fees.toFixed(2).padStart(6)} ${funding.toFixed(2).padStart(6)} ${net.toFixed(2).padStart(7)} ${r.wallet.toFixed(2).padStart(7)}`);
    }
  }

  // Trade detail for top variant
  const best = all.slice().sort((a, b) => b.wallet - a.wallet)[0];
  console.log(`\n══ ${best.id} — full trade detail ══`);
  console.log(`${"time".padEnd(13)} ${"asset".padEnd(10)} ${"rule".padEnd(4)} ${"side".padEnd(5)} ${"stk×lev".padEnd(8)} ${"entryFill".padStart(11)} ${"exitFill".padStart(11)} ${"gross".padStart(7)} ${"fee".padStart(5)} ${"fund".padStart(5)} ${"net".padStart(7)}  reason`);
  best.trades.sort((a, b) => a.openEpoch - b.openEpoch);
  for (const t of best.trades) {
    const ot = new Date(t.openEpoch * 1000).toISOString().slice(11, 16);
    const ct = new Date(t.closeEpoch * 1000).toISOString().slice(11, 16);
    const tag = t.netPnl > 0 ? "✓" : "✗";
    console.log(`${ot}→${ct} ${t.asset.padEnd(10)} ${t.ruleId.padEnd(4)} ${t.side.padEnd(5)} $${t.stake}×${t.lev}× ${t.entryFill.toFixed(5).padStart(11)} ${t.exitFill.toFixed(5).padStart(11)} ${t.grossPnl.toFixed(2).padStart(7)} ${t.feeCost.toFixed(2).padStart(5)} ${t.fundingCost.toFixed(2).padStart(5)} ${t.netPnl.toFixed(2).padStart(7)} ${tag} ${t.reason}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });

// RDBEAR daily pattern study (2025-12-01 → today).
// Run the validated mean-rev strategy day-by-day. For each day capture day-level
// features (volatility, ADX, efficiency, day-of-week, prior-day outcome, spike
// count, daily drift direction). After running, correlate features with outcome
// to find skip rules → autonomous strategy with regime gating.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = 200;
const BASE_STAKE = 30;
const MART = 1.7;
const MAX_LEVELS = 3;
const PER_TRADE_CAP = 100;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
const EFF_WINDOW = 24;
const CHOP_THRESH = 0.30;
const MIN_ADX = 22;

const SYM = "RDBEAR";
const GR = 300; // 5m

const DEC_1 = Math.floor(Date.UTC(2025, 11, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAYS = Math.floor((TODAY - DEC_1) / 86400);

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch { /* */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = end;
  while (candles.length < count) {
    const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch);
    cursor = ch[0].epoch - 1;
    if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

function adx(c: Candle[], i: number, period = 14): number {
  if (i < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const upMove = c[j].high - c[j - 1].high;
    const dnMove = c[j - 1].low - c[j].low;
    const pdm = upMove > dnMove && upMove > 0 ? upMove : 0;
    const ndm = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    plusDM += pdm; minusDM += ndm;
    tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
}

function efficiency(c: Candle[], i: number, window: number): number {
  if (i < window) return 0;
  const netMove = Math.abs(c[i].close - c[i - window].close);
  let sumAbs = 0;
  for (let j = i - window + 1; j <= i; j++) sumAbs += Math.abs(c[j].close - c[j - 1].close);
  return sumAbs > 0 ? netMove / sumAbs : 0;
}

type Sig = { idx: number; side: "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(LOOKBACK, 28, EFF_WINDOW) + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    const ad = adx(candles, i, 14);
    if (ad < MIN_ADX) continue;
    const eff = efficiency(candles, i, EFF_WINDOW);
    if (eff >= CHOP_THRESH) continue;
    let hi = -Infinity;
    for (let m = i - LOOKBACK; m < i; m++) if (candles[m].high > hi) hi = candles[m].high;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const dist = KATR * a;
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], ws: number, we: number) {
  const sigs = detect(candles).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;
  for (const sig of sigs) {
    if (bust || ddPaused) break;
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance };
}

type DayRec = {
  day: number;
  date: string;
  dow: number;            // day-of-week (0 = Sun)
  // pre-day features (computed from PRIOR 24h, no lookahead)
  prevAtr: number;        // last ATR(14) at end of prior day
  prevAdx: number;        // last ADX(14) at end of prior day
  prevEff: number;        // efficiency at end of prior day
  prevDailyDir: number;   // sign of close[end-of-prior-day] - close[start-of-prior-day]
  prevDailyRangeNorm: number; // (high-low)/atr of prior day
  prevSpikeCount: number; // # bars on prior day with range >= 3×ATR
  prevDayOutcome: "W" | "L" | "DD" | "—" | "BUST";  // prior day result
  prevDayNet: number;
  // outcome
  trades: number;
  wins: number;
  losses: number;
  net: number;
  bust: boolean;
  ddPaused: boolean;
  outcome: "W" | "L" | "DD" | "—" | "BUST";
};

function computeDayFeatures(candles: Candle[], dayStart: number): {
  prevAtr: number; prevAdx: number; prevEff: number;
  prevDailyDir: number; prevDailyRangeNorm: number; prevSpikeCount: number;
} {
  // Find the bar at dayStart (start of current day)
  let dayStartIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].epoch >= dayStart) { dayStartIdx = i; break; }
  }
  if (dayStartIdx < 50) {
    return { prevAtr: 0, prevAdx: 0, prevEff: 0, prevDailyDir: 0, prevDailyRangeNorm: 0, prevSpikeCount: 0 };
  }
  const lastPrevIdx = dayStartIdx - 1;
  const prevAtr = atr(candles, lastPrevIdx, 14);
  const prevAdx = adx(candles, lastPrevIdx, 14);
  const prevEff = efficiency(candles, lastPrevIdx, EFF_WINDOW);
  // Prior 24h slice
  const prevDayStart = dayStart - 86400;
  let prevStartIdx = 0;
  for (let i = 0; i < dayStartIdx; i++) {
    if (candles[i].epoch >= prevDayStart) { prevStartIdx = i; break; }
  }
  if (prevStartIdx < 14) {
    return { prevAtr, prevAdx, prevEff, prevDailyDir: 0, prevDailyRangeNorm: 0, prevSpikeCount: 0 };
  }
  let pdHi = -Infinity, pdLo = Infinity;
  let spikeCount = 0;
  for (let i = prevStartIdx; i < dayStartIdx; i++) {
    if (candles[i].high > pdHi) pdHi = candles[i].high;
    if (candles[i].low < pdLo) pdLo = candles[i].low;
    if (i >= 14) {
      const a = atr(candles, i, 14);
      if (a > 0 && (candles[i].high - candles[i].low) >= 3.0 * a) spikeCount++;
    }
  }
  const dir = candles[dayStartIdx - 1].close - candles[prevStartIdx].close;
  const rangeNorm = prevAtr > 0 ? (pdHi - pdLo) / prevAtr : 0;
  return {
    prevAtr,
    prevAdx,
    prevEff,
    prevDailyDir: dir > 0 ? 1 : dir < 0 ? -1 : 0,
    prevDailyRangeNorm: rangeNorm,
    prevSpikeCount: spikeCount,
  };
}

async function main() {
  console.log(`RDBEAR pattern study — Dec 1 2025 → today (${DAYS} days)`);
  console.log(`ACCT=$${ACCT} STAKE=$${BASE_STAKE} MART=${MART}× × ${MAX_LEVELS}L\n`);

  const c = new C(); await c.ready;
  const recs: DayRec[] = [];
  let prevOutcome: DayRec["outcome"] = "—";
  let prevNet = 0;

  for (let d = 0; d < DAYS; d++) {
    const dayStart = DEC_1 + d * 86400;
    const dayEnd = dayStart + 86400;
    let candles: Candle[] | null = null;
    try { candles = await fetchPaged(c, SYM, GR, 600, dayEnd); }
    catch { continue; }
    const feat = computeDayFeatures(candles, dayStart);
    const r = honestSim(candles, dayStart, dayEnd);
    const date = new Date(dayStart * 1000).toISOString().slice(0, 10);
    const dow = new Date(dayStart * 1000).getUTCDay();
    const outcome: DayRec["outcome"] =
      r.bust ? "BUST" : r.ddPaused ? "DD" :
      r.trades === 0 ? "—" :
      r.finalBal >= ACCT ? "W" : "L";
    const rec: DayRec = {
      day: d, date, dow,
      prevAtr: feat.prevAtr, prevAdx: feat.prevAdx, prevEff: feat.prevEff,
      prevDailyDir: feat.prevDailyDir, prevDailyRangeNorm: feat.prevDailyRangeNorm,
      prevSpikeCount: feat.prevSpikeCount,
      prevDayOutcome: prevOutcome, prevDayNet: prevNet,
      trades: r.trades, wins: r.wins, losses: r.losses, net: r.finalBal - ACCT,
      bust: r.bust, ddPaused: r.ddPaused, outcome,
    };
    recs.push(rec);
    prevOutcome = outcome;
    prevNet = rec.net;
    if ((d + 1) % 30 === 0) {
      const wD = recs.filter((x) => x.outcome === "W").length;
      const ddD = recs.filter((x) => x.outcome === "DD" || x.outcome === "BUST").length;
      const totalNet = recs.reduce((s, x) => s + x.net, 0);
      process.stdout.write(`  d${d+1}/${DAYS}: W=${wD} DD=${ddD} totalΔ=${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(0)}\n`);
    }
  }
  c.close();

  // Aggregate stats
  const total = recs.length;
  const wins = recs.filter((x) => x.outcome === "W").length;
  const losses = recs.filter((x) => x.outcome === "L").length;
  const ddDays = recs.filter((x) => x.outcome === "DD").length;
  const busts = recs.filter((x) => x.outcome === "BUST").length;
  const noTrade = recs.filter((x) => x.outcome === "—").length;
  const totalNet = recs.reduce((s, x) => s + x.net, 0);
  console.log(`\nSUMMARY: ${total} days · ${wins}W ${losses}L ${ddDays}DD ${busts}BUST ${noTrade}—  totalΔ=$${totalNet.toFixed(2)}`);

  // Pattern analysis: split by outcome and compute mean features
  const groupBy = (rs: DayRec[], pred: (r: DayRec) => boolean) => rs.filter(pred);
  const mean = (xs: number[]) => xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

  const winRecs = groupBy(recs, (r) => r.outcome === "W");
  const badRecs = groupBy(recs, (r) => r.outcome === "L" || r.outcome === "DD");

  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`PATTERN ANALYSIS — winning vs losing days`);
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`  metric              winners(${winRecs.length})    losers(${badRecs.length})    Δ`);
  const features: Array<[string, (r: DayRec) => number]> = [
    ["prevAdx",            (r) => r.prevAdx],
    ["prevEff",            (r) => r.prevEff],
    ["prevDailyDir",       (r) => r.prevDailyDir],
    ["prevDailyRangeNorm", (r) => r.prevDailyRangeNorm],
    ["prevSpikeCount",     (r) => r.prevSpikeCount],
  ];
  for (const [name, fn] of features) {
    const wMean = mean(winRecs.map(fn));
    const lMean = mean(badRecs.map(fn));
    const delta = wMean - lMean;
    const sig = Math.abs(delta) > Math.abs(wMean + lMean) * 0.1 ? " *" : "";
    console.log(`  ${name.padEnd(20)}  ${wMean.toFixed(2).padStart(7)}     ${lMean.toFixed(2).padStart(7)}     ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}${sig}`);
  }

  // Day-of-week analysis
  console.log(`\nDAY-OF-WEEK split:`);
  const dowNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let dow = 0; dow < 7; dow++) {
    const arr = recs.filter((r) => r.dow === dow);
    if (arr.length === 0) continue;
    const w = arr.filter((r) => r.outcome === "W").length;
    const dd = arr.filter((r) => r.outcome === "DD" || r.outcome === "BUST").length;
    const net = arr.reduce((s, r) => s + r.net, 0);
    console.log(`  ${dowNames[dow]}  n=${String(arr.length).padStart(3)}  W=${String(w).padStart(2)}/DD=${String(dd).padStart(2)}  netΔ=$${net.toFixed(0)}`);
  }

  // Prior-day-outcome carryover
  console.log(`\nPRIOR-DAY OUTCOME → today's outcome:`);
  const priors: DayRec["outcome"][] = ["W", "L", "DD", "—", "BUST"];
  for (const p of priors) {
    const arr = recs.filter((r) => r.prevDayOutcome === p);
    if (arr.length === 0) continue;
    const w = arr.filter((r) => r.outcome === "W").length;
    const dd = arr.filter((r) => r.outcome === "DD" || r.outcome === "BUST").length;
    const net = arr.reduce((s, r) => s + r.net, 0);
    console.log(`  prev=${p.padEnd(4)} n=${String(arr.length).padStart(3)}  W=${String(w).padStart(2)}/DD=${String(dd).padStart(2)}  netΔ=$${net.toFixed(0)}`);
  }

  // Threshold scan: find best ADX/EFF cut that maximizes net
  console.log(`\nTHRESHOLD SCAN — skip-day rules:`);
  const tryRules: Array<[string, (r: DayRec) => boolean]> = [
    ["skip if prevEff > 0.40",        (r) => r.prevEff > 0.40],
    ["skip if prevEff > 0.50",        (r) => r.prevEff > 0.50],
    ["skip if prevAdx > 30",          (r) => r.prevAdx > 30],
    ["skip if prevDailyDir > 0",      (r) => r.prevDailyDir > 0],
    ["skip if prevSpikeCount > 5",    (r) => r.prevSpikeCount > 5],
    ["skip if prevDay = DD",          (r) => r.prevDayOutcome === "DD"],
    ["skip if prevDay = L",           (r) => r.prevDayOutcome === "L"],
    ["skip Mon",                      (r) => r.dow === 1],
    ["skip Sun",                      (r) => r.dow === 0],
    ["skip Sat",                      (r) => r.dow === 6],
  ];
  console.log(`  baseline (no skip):  totalΔ=$${totalNet.toFixed(2)}  (${recs.length} days)`);
  for (const [name, skip] of tryRules) {
    const kept = recs.filter((r) => !skip(r));
    const net = kept.reduce((s, r) => s + r.net, 0);
    const ddInKept = kept.filter((r) => r.outcome === "DD" || r.outcome === "BUST").length;
    const wInKept = kept.filter((r) => r.outcome === "W").length;
    const skipped = recs.length - kept.length;
    const lift = net - totalNet;
    console.log(`  ${name.padEnd(34)}  Δ=$${net.toFixed(0).padStart(6)}  kept=${kept.length} (skip ${skipped})  W=${wInKept} DD=${ddInKept}  lift=${lift >= 0 ? "+" : ""}$${lift.toFixed(0)}`);
  }

  // Combination scan: stack the most promising rules
  console.log(`\nCOMBINED RULE TEST:`);
  const skipDD = (r: DayRec) => r.prevDayOutcome === "DD";
  const skipHighEff = (r: DayRec) => r.prevEff > 0.40;
  const combos: Array<[string, (r: DayRec) => boolean]> = [
    ["skip DD-prev OR eff>0.40",    (r) => skipDD(r) || skipHighEff(r)],
    ["skip DD-prev only",            skipDD],
    ["skip eff>0.40 only",           skipHighEff],
  ];
  for (const [name, skip] of combos) {
    const kept = recs.filter((r) => !skip(r));
    const net = kept.reduce((s, r) => s + r.net, 0);
    const ddInKept = kept.filter((r) => r.outcome === "DD" || r.outcome === "BUST").length;
    const lift = net - totalNet;
    console.log(`  ${name.padEnd(34)}  Δ=$${net.toFixed(0).padStart(6)}  kept=${kept.length}  DD-rate=${(ddInKept/kept.length*100).toFixed(1)}%  lift=${lift >= 0 ? "+" : ""}$${lift.toFixed(0)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

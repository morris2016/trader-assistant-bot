// Refine the 6 validated multiplier strategies with 1.5× martingale.
// Goal: minimize bust rate at $20 acct / $5 base / 100× mult.
//
// Martingale rule: stake_n = $5 × 1.5^level. On WIN reset level → 0. On LOSS
// level++ up to MAX_LADDER, after which take the hit and reset to 0
// (capped martingale).
//
// At $20 acct / $5 base, the cumulative-loss ladder is:
//   L0=5  L1=7.5  L2=11.25  L3=16.88  L4=25.31
//   cum:  5    12.5   23.75   40.63   65.94
// → only L0+L1 fits in $20. Depth 3+ guarantees bust on a 3-loss streak.
//
// Test depths 1..5 + an "affordable" mode (skip if next stake > balance × 0.6)
// to see real-world tradeoff curves.
//
// Usage: npx ts-node scripts/rd-multiplier-mart-refine.ts

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 60;
const ACCT_INIT = 150, BASE_STAKE = 10, MULT = 100, MART_RATIO = 2.0;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;
const MAX_BAL_FRAC_FOR_NEXT = 0.6; // affordable mode: skip if next stake > 60% balance

type Cand = { sym: string; type: "FADE_UP" | "FADE_DOWN" | "DRIFT_UP" | "DRIFT_DOWN"; label: string };
const CANDIDATES: Cand[] = [
  { sym: "BOOM300N",  type: "FADE_UP",    label: "BOOM300N_FADE_UP" },
  { sym: "JD75",      type: "FADE_UP",    label: "JD75_FADE_UP" },
  { sym: "JD75",      type: "FADE_DOWN",  label: "JD75_FADE_DOWN" },
  { sym: "CRASH300N", type: "FADE_DOWN",  label: "CRASH300N_FADE_DOWN" },
  { sym: "BOOM300N",  type: "DRIFT_DOWN", label: "BOOM300N_DRIFT_DOWN" },
  { sym: "JD50",      type: "FADE_DOWN",  label: "JD50_FADE_DOWN" },
];

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(WS_URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, totalBars: number): Promise<Candle[]> {
  const PAGE = 5000; let end: any = "latest"; const all: Candle[] = []; let remaining = totalBars;
  while (remaining > 0) {
    const ask = Math.min(PAGE, remaining);
    let r: any;
    try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: ask, end: String(end), style: "candles", granularity: gr }); }
    catch { break; }
    const raw = (r.candles ?? []) as any[];
    if (raw.length === 0) break;
    const page = raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
      .sort((a, b) => a.epoch - b.epoch);
    all.unshift(...page);
    if (page.length < ask) break;
    end = page[0].epoch - 1; remaining -= page.length;
  }
  const seen = new Set<number>();
  return all.filter((b) => { if (seen.has(b.epoch)) return false; seen.add(b.epoch); return true; }).sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

type Sig = { idx: number; epoch: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };
function detect(candles: Candle[], type: Cand["type"]): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    if (type === "FADE_UP" && upPierce) { const d = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d }); }
    if (type === "FADE_DOWN" && dnPierce) { const d = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d }); }
    if (type === "DRIFT_UP" && upPierce) { const d = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d }); }
    if (type === "DRIFT_DOWN" && dnPierce) { const d = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d }); }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Outcome = "TP" | "SL";
type Resolved = { sig: Sig; outcome: Outcome; exitIdx: number; finalE: number; exitPrice: number };

function resolveTrade(sig: Sig, candles: Candle[]): Resolved | null {
  if (sig.idx + 1 >= candles.length) return null;
  const finBar = candles[sig.idx + 1];
  const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
  const delta = finalE - sig.entry;
  const stop = sig.stop + delta;
  const target = sig.target + delta;
  for (let j = sig.idx + 1; j < candles.length; j++) {
    const b = candles[j];
    if (sig.side === "BUY") {
      if (b.low <= stop) return { sig, outcome: "SL", exitIdx: j, finalE, exitPrice: stop - stop * SL_SLIPPAGE_FRAC };
      if (b.high >= target) return { sig, outcome: "TP", exitIdx: j, finalE, exitPrice: target };
    } else {
      if (b.high >= stop) return { sig, outcome: "SL", exitIdx: j, finalE, exitPrice: stop + stop * SL_SLIPPAGE_FRAC };
      if (b.low <= target) return { sig, outcome: "TP", exitIdx: j, finalE, exitPrice: target };
    }
  }
  return null;
}

type Result = { trades: number; wins: number; losses: number; net: number; finalBal: number; peak: number; maxDD: number; bust: number; longestLoss: number; skipped: number };

function simulate(sigs: Sig[], candles: Candle[], fromEpoch: number, toEpoch: number, maxLadder: number, affordable: boolean): Result {
  let bal = ACCT_INIT, peak = ACCT_INIT, maxDD = 0;
  let trades = 0, wins = 0, losses = 0, net = 0, bust = 0, longestLoss = 0, curStreak = 0, skipped = 0;
  let level = 0;
  let busy = -1;

  for (const sig of sigs) {
    if (sig.epoch < fromEpoch || sig.epoch >= toEpoch) continue;
    if (sig.idx < busy) continue; // no-overlap

    const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, level));
    const commission = round2(stake * COMMISSION_FRAC);

    if (affordable && stake > bal * MAX_BAL_FRAC_FOR_NEXT) {
      // skip — not affordable, reset ladder
      level = 0;
      skipped++;
      continue;
    }

    if (bal < stake + commission) { bust++; bal = ACCT_INIT; peak = ACCT_INIT; level = 0; }

    const r = resolveTrade(sig, candles);
    if (!r) continue;

    const move = sig.side === "BUY" ? (r.exitPrice - r.finalE) / r.finalE : (r.finalE - r.exitPrice) / r.finalE;
    let pnl = stake * MULT * move - commission;
    if (pnl < -stake) pnl = -stake;
    pnl = round2(pnl);
    bal = round2(bal + pnl);
    trades++;
    if (r.outcome === "TP") {
      wins++;
      level = 0;
      curStreak = 0;
    } else {
      losses++;
      curStreak++;
      if (curStreak > longestLoss) longestLoss = curStreak;
      level = level + 1 > maxLadder ? 0 : level + 1;
    }
    net += pnl;
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    busy = r.exitIdx;
  }
  return { trades, wins, losses, net: round2(net), finalBal: bal, peak: round2(peak), maxDD: round2(maxDD), bust, longestLoss, skipped };
}

async function main() {
  const c = new C(); await c.ready;
  const need = DAYS * 24 * 12 + 250;

  const candles: Record<string, Candle[]> = {};
  for (const sym of Array.from(new Set(CANDIDATES.map((c) => c.sym)))) {
    process.stdout.write(`${sym} fetching... `);
    candles[sym] = await fetchPaged(c, sym, GR, need);
    const span = (candles[sym][candles[sym].length-1].epoch - candles[sym][0].epoch) / 86400;
    console.log(`${candles[sym].length}b / ${span.toFixed(1)}d`);
  }
  c.close();

  const ref = candles[CANDIDATES[0].sym];
  const earliest = ref[0].epoch, latest = ref[ref.length-1].epoch;
  const total = latest - earliest;
  const w0End = earliest + total / 3, trainEnd = earliest + 2 * total / 3;
  const windows = [
    { name: "W0",    from: earliest, to: w0End },
    { name: "TRAIN", from: w0End,    to: trainEnd },
    { name: "TEST",  from: trainEnd, to: latest },
  ];

  console.log(`\nWindows:`);
  for (const w of windows) console.log(`  ${w.name}: ${new Date(w.from*1000).toISOString().slice(0,10)} → ${new Date(w.to*1000).toISOString().slice(0,10)}`);

  console.log(`\nMartingale ladder ($5 base × 1.5^level):`);
  for (let L = 0; L <= 5; L++) console.log(`  L${L}: $${(BASE_STAKE * Math.pow(MART_RATIO, L)).toFixed(2)}  cum if all lose: $${Array.from({length:L+1},(_,i)=>BASE_STAKE*Math.pow(MART_RATIO,i)).reduce((a,b)=>a+b,0).toFixed(2)}`);
  console.log();

  for (const cand of CANDIDATES) {
    console.log(`${"".padEnd(115, "═")}`);
    console.log(`${cand.label}`);
    console.log(`${"".padEnd(115, "═")}`);
    console.log(`${"depth".padEnd(8)} mode         window  trades  wins  losses  longestL  skip   $net      finalBal  maxDD   bust`);
    const sigs = detect(candles[cand.sym], cand.type);

    for (let depth = 1; depth <= 4; depth++) {
      for (const aff of [false, true]) {
        const allW: Result[] = [];
        for (const w of windows) {
          const r = simulate(sigs, candles[cand.sym], w.from, w.to, depth, aff);
          allW.push(r);
          const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(1) : "—";
          console.log(`${`d=${depth}`.padEnd(8)} ${(aff ? "afford" : "always").padEnd(12)} ${w.name.padEnd(7)} ${String(r.trades).padStart(5)}  ${String(r.wins).padStart(4)}  ${String(r.losses).padStart(5)}    ${String(r.longestLoss).padStart(2)}      ${String(r.skipped).padStart(4)}   ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(8)}  $${r.finalBal.toFixed(2).padStart(7)}  $${r.maxDD.toFixed(2).padStart(6)}  ${String(r.bust).padStart(2)}`);
        }
        const sumNet = allW.reduce((a,b) => a + b.net, 0);
        const sumBust = allW.reduce((a,b) => a + b.bust, 0);
        const sumTr = allW.reduce((a,b) => a + b.trades, 0);
        const sumWin = allW.reduce((a,b) => a + b.wins, 0);
        const allPos = allW.every((r) => r.net > 0);
        console.log(`        ${"".padEnd(12)} TOTAL   ${String(sumTr).padStart(5)}  ${String(sumWin).padStart(4)}                         ${sumNet >= 0 ? "+" : ""}$${sumNet.toFixed(2).padStart(8)}                     ${String(sumBust).padStart(2)}  ${allPos && sumBust <= 1 ? "★" : ""}\n`);
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

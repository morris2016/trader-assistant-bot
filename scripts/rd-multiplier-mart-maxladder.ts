// $250 acct / $10 stake / 2.0× mart / 100× mult — find the maximum ladder
// depth per week per strategy that survives without bust, and the resulting
// net P&L. Mar + Apr 2026.
//
// Ladder cum-loss schedule ($10 base × 2.0^level):
//   L0 $10  cum $10
//   L1 $20  cum $30
//   L2 $40  cum $70
//   L3 $80  cum $150       ← d=3 fits comfortably within $250 acct
//   L4 $160 cum $310       ← d=4 BUSTS on 5-loss streak ($250 acct)
//   L5 $320 cum $630       ← d=5 BUSTS on 6-loss streak
//
// Test depths 1..5 per (week × strategy). Mark each as bust-free or busted.
// Per week, "max ladder" = deepest d with 0 busts on that week.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 130;
const ACCT_INIT = 250, BASE_STAKE = 10, MULT = 100, MART_RATIO = 2.0;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;
const TEST_DEPTHS = [1, 2, 3, 4, 5];

type Cand = { sym: string; type: "FADE_UP" | "FADE_DOWN" | "DRIFT_UP" | "DRIFT_DOWN"; label: string };
const CANDIDATES: Cand[] = [
  { sym: "BOOM300N",  type: "FADE_UP",    label: "BOOM300N_FADE_UP" },
  { sym: "JD75",      type: "FADE_UP",    label: "JD75_FADE_UP" },
  { sym: "JD75",      type: "FADE_DOWN",  label: "JD75_FADE_DOWN" },
  { sym: "CRASH300N", type: "FADE_DOWN",  label: "CRASH300N_FADE_DOWN" },
  { sym: "BOOM300N",  type: "DRIFT_DOWN", label: "BOOM300N_DRIFT_DOWN" },
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

function simWeekDepth(sigs: Sig[], candles: Candle[], fromEpoch: number, toEpoch: number, depth: number): { trades: number; wins: number; net: number; bust: number; longestL: number } {
  let bal = ACCT_INIT;
  let trades = 0, wins = 0, net = 0, bust = 0, longestL = 0, curStreak = 0;
  let level = 0; let busy = -1;

  for (const sig of sigs) {
    if (sig.epoch < fromEpoch || sig.epoch >= toEpoch) continue;
    if (sig.idx < busy) continue;
    const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, level));
    const commission = round2(stake * COMMISSION_FRAC);
    if (bal < stake + commission) { bust++; bal = ACCT_INIT; level = 0; }
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "TP" | "SL" | null = null; let exitPrice = 0; let exitIdx = -1;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (sig.side === "BUY") {
        if (b.low <= stop) { exit = "SL"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; exitIdx = j; break; }
        if (b.high >= target) { exit = "TP"; exitPrice = target; exitIdx = j; break; }
      } else {
        if (b.high >= stop) { exit = "SL"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; exitIdx = j; break; }
        if (b.low <= target) { exit = "TP"; exitPrice = target; exitIdx = j; break; }
      }
    }
    if (exit == null) continue;
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = stake * MULT * move - commission;
    if (pnl < -stake) pnl = -stake;
    pnl = round2(pnl);
    bal = round2(bal + pnl);
    trades++;
    if (exit === "TP") { wins++; level = 0; curStreak = 0; }
    else { curStreak++; if (curStreak > longestL) longestL = curStreak; level = level + 1 > depth ? 0 : level + 1; }
    net += pnl;
    busy = exitIdx;
  }
  return { trades, wins, net: round2(net), bust, longestL };
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

  const weeks = [
    { name: "Mar W1", from: Date.UTC(2026,2,1)/1000,   to: Date.UTC(2026,2,8)/1000 },
    { name: "Mar W2", from: Date.UTC(2026,2,8)/1000,   to: Date.UTC(2026,2,15)/1000 },
    { name: "Mar W3", from: Date.UTC(2026,2,15)/1000,  to: Date.UTC(2026,2,22)/1000 },
    { name: "Mar W4", from: Date.UTC(2026,2,22)/1000,  to: Date.UTC(2026,2,29)/1000 },
    { name: "Apr W1", from: Date.UTC(2026,3,1)/1000,   to: Date.UTC(2026,3,8)/1000 },
    { name: "Apr W2", from: Date.UTC(2026,3,8)/1000,   to: Date.UTC(2026,3,15)/1000 },
    { name: "Apr W3", from: Date.UTC(2026,3,15)/1000,  to: Date.UTC(2026,3,22)/1000 },
    { name: "Apr W4", from: Date.UTC(2026,3,22)/1000,  to: Date.UTC(2026,3,29)/1000 },
  ];

  console.log(`\n${"".padEnd(125, "═")}`);
  console.log(`MAX LADDER DEPTH per week · $${ACCT_INIT} acct · $${BASE_STAKE} stake · ${MART_RATIO}× mart · ${MULT}× mult`);
  console.log(`Cum-loss ladder: L0=$10 L1=$30 L2=$70 L3=$150 L4=$310✗ L5=$630✗ (vs $${ACCT_INIT} acct)`);
  console.log(`${"".padEnd(125, "═")}\n`);

  // Per-strategy: for each week, scan depths and report longestL + max safe depth
  for (const cand of CANDIDATES) {
    const sigs = detect(candles[cand.sym], cand.type);
    console.log(`${cand.label}`);
    console.log(`  ${"week".padEnd(8)} longest-L  ${TEST_DEPTHS.map((d) => `d=${d} (net|bust)`.padEnd(18)).join("")}  MAX_SAFE`);
    for (const w of weeks) {
      const row: { d: number; net: number; bust: number; longestL: number }[] = [];
      for (const d of TEST_DEPTHS) {
        const r = simWeekDepth(sigs, candles[cand.sym], w.from, w.to, d);
        row.push({ d, net: r.net, bust: r.bust, longestL: r.longestL });
      }
      const maxSafe = Math.max(0, ...row.filter((r) => r.bust === 0).map((r) => r.d));
      const longestL = row[0].longestL;
      const cells = row.map((r) => {
        const sign = r.net >= 0 ? "+" : "";
        const cell = `${sign}$${r.net.toFixed(0).padStart(5)}|${r.bust === 0 ? "·" : "❌"+r.bust}`;
        return cell.padEnd(18);
      }).join("");
      console.log(`  ${w.name.padEnd(8)} ${String(longestL).padStart(7)}    ${cells}  ${maxSafe > 0 ? `d=${maxSafe}` : "BUSTED ALL"}`);
    }
    console.log();
  }

  // Per-week book summary: for each week, sum net at each depth across all 5 strats
  console.log(`${"".padEnd(125, "═")}`);
  console.log(`COMBINED BOOK (5 strategies, each weighted equal) — net at each ladder depth:`);
  console.log(`${"".padEnd(125, "═")}`);
  console.log(`  ${"week".padEnd(8)} ${TEST_DEPTHS.map((d) => `d=${d} (net|busts)`.padEnd(20)).join("")}  best_safe_depth`);

  for (const w of weeks) {
    const depthAgg: Record<number, { net: number; bust: number }> = {};
    for (const d of TEST_DEPTHS) depthAgg[d] = { net: 0, bust: 0 };
    for (const cand of CANDIDATES) {
      const sigs = detect(candles[cand.sym], cand.type);
      for (const d of TEST_DEPTHS) {
        const r = simWeekDepth(sigs, candles[cand.sym], w.from, w.to, d);
        depthAgg[d].net += r.net;
        depthAgg[d].bust += r.bust;
      }
    }
    let bestSafe = 0;
    for (const d of TEST_DEPTHS) if (depthAgg[d].bust === 0) bestSafe = Math.max(bestSafe, d);
    const cells = TEST_DEPTHS.map((d) => {
      const a = depthAgg[d];
      const sign = a.net >= 0 ? "+" : "";
      return `${sign}$${a.net.toFixed(0).padStart(6)}|${a.bust === 0 ? "·" : "❌"+a.bust}`.padEnd(20);
    }).join("");
    console.log(`  ${w.name.padEnd(8)} ${cells}  ${bestSafe > 0 ? `d=${bestSafe} ★` : "all busted"}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

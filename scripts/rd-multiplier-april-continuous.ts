// Continuous April 2026 simulation — $250 starting balance, $10 stake, 2.0×
// mart depth=3, 100× mult. Two views:
//
//   (A) Per-strategy: each starts April 1 with $250 and runs through Apr 30
//       independently. Balance carries through the month — no weekly resets.
//
//   (B) Combined book: ONE $250 pool, all 5 strategies share it. Signals are
//       merged into a single timeline by epoch and processed in order. This
//       is closer to how a real Deriv account would work.
//
// Reports daily balance progression + drawdown stats.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 130;
const ACCT_INIT = 250, BASE_STAKE = 10, MULT = 100, MART_RATIO = 2.0, DEPTH = 3;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

const APR_START = Date.UTC(2026, 3, 1) / 1000;
const APR_END   = Date.UTC(2026, 4, 1) / 1000;

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

type Sig = { idx: number; epoch: number; sym: string; stratLabel: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], cand: Cand): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    const base = { idx: i, epoch: cur.epoch, sym: cand.sym, stratLabel: cand.label } as const;
    if (cand.type === "FADE_UP" && upPierce) { const d = FADE_KATR * a; out.push({ ...base, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d }); }
    if (cand.type === "FADE_DOWN" && dnPierce) { const d = FADE_KATR * a; out.push({ ...base, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d }); }
    if (cand.type === "DRIFT_UP" && upPierce) { const d = DRIFT_KATR * a; out.push({ ...base, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d }); }
    if (cand.type === "DRIFT_DOWN" && dnPierce) { const d = DRIFT_KATR * a; out.push({ ...base, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d }); }
  }
  return out;
}
function round2(x: number) { return Math.round(x * 100) / 100; }

type Resolved = { sig: Sig; outcome: "TP" | "SL"; exitIdx: number; finalE: number; exitPrice: number };
function resolve(sig: Sig, candles: Candle[]): Resolved | null {
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

  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`CONTINUOUS APRIL 2026 · $${ACCT_INIT} acct · $${BASE_STAKE} stake · ${MART_RATIO}× mart d=${DEPTH} · ${MULT}× mult`);
  console.log(`${"".padEnd(110, "═")}\n`);

  // ============ (A) Per-strategy continuous run ============
  console.log(`(A) PER-STRATEGY: each starts April 1 with $${ACCT_INIT}, balance carries through the month\n`);
  for (const cand of CANDIDATES) {
    const sigsAll = detect(candles[cand.sym], cand).filter((s) => s.epoch >= APR_START && s.epoch < APR_END);
    let bal = ACCT_INIT, peak = ACCT_INIT, maxDD = 0;
    let trades = 0, wins = 0, losses = 0, level = 0, bust = 0, longestL = 0, curStreak = 0;
    let busy = -1;
    const dailyBal: Record<string, number> = {};

    for (const sig of sigsAll) {
      if (sig.idx < busy) continue;
      const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, level));
      const commission = round2(stake * COMMISSION_FRAC);
      if (bal < stake + commission) {
        bust++;
        // realistic: stop trading. But to measure full edge we top up.
        bal = ACCT_INIT; peak = ACCT_INIT; level = 0;
      }
      const r = resolve(sig, candles[cand.sym]);
      if (!r) continue;
      const move = sig.side === "BUY" ? (r.exitPrice - r.finalE) / r.finalE : (r.finalE - r.exitPrice) / r.finalE;
      let pnl = stake * MULT * move - commission;
      if (pnl < -stake) pnl = -stake;
      pnl = round2(pnl);
      bal = round2(bal + pnl);
      trades++;
      if (r.outcome === "TP") { wins++; level = 0; curStreak = 0; }
      else { losses++; curStreak++; if (curStreak > longestL) longestL = curStreak; level = level + 1 > DEPTH ? 0 : level + 1; }
      if (bal > peak) peak = bal;
      const dd = peak - bal;
      if (dd > maxDD) maxDD = dd;
      busy = r.exitIdx;
      const dayKey = new Date(sig.epoch * 1000).toISOString().slice(5, 10);
      dailyBal[dayKey] = bal;
    }
    const wr = trades > 0 ? wins / trades * 100 : 0;
    console.log(`  ${cand.label}`);
    console.log(`    trades=${trades}  W=${wins}  L=${losses}  WR=${wr.toFixed(1)}%  longestLossStreak=${longestL}  bust=${bust}`);
    console.log(`    final balance: $${bal.toFixed(2)}  (Δ ${bal - ACCT_INIT >= 0 ? "+" : ""}$${(bal - ACCT_INIT).toFixed(2)} = ${((bal - ACCT_INIT)/ACCT_INIT*100).toFixed(0)}%)`);
    console.log(`    peak: $${peak.toFixed(2)}   maxDD: $${maxDD.toFixed(2)} (${(maxDD/peak*100).toFixed(1)}% of peak)`);
    console.log();
  }

  // ============ (B) Combined book: ONE $250 pool, all signals interleaved ============
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`(B) COMBINED BOOK: ONE $${ACCT_INIT} pool shared by all 5 strategies (signals interleaved by epoch)\n`);

  const allSigs: Sig[] = [];
  for (const cand of CANDIDATES) {
    const sigs = detect(candles[cand.sym], cand).filter((s) => s.epoch >= APR_START && s.epoch < APR_END);
    allSigs.push(...sigs);
  }
  allSigs.sort((a, b) => a.epoch - b.epoch || a.stratLabel.localeCompare(b.stratLabel));
  console.log(`Combined signal stream: ${allSigs.length} signals across April`);

  // Per-strategy state (each has own ladder + busy-until tracker; balance is shared)
  const stratState: Record<string, { level: number; busy: number; longestL: number; curStreak: number }> = {};
  for (const cand of CANDIDATES) stratState[cand.label] = { level: 0, busy: -1, longestL: 0, curStreak: 0 };

  let bal = ACCT_INIT, peak = ACCT_INIT, maxDD = 0, bust = 0, trades = 0, wins = 0, losses = 0;
  const dailyBal = new Map<string, number>();
  const stratStats: Record<string, { trades: number; wins: number; net: number }> = {};
  for (const cand of CANDIDATES) stratStats[cand.label] = { trades: 0, wins: 0, net: 0 };

  for (const sig of allSigs) {
    const ss = stratState[sig.stratLabel];
    if (sig.idx < ss.busy) continue; // strategy busy on its own prior trade
    const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, ss.level));
    const commission = round2(stake * COMMISSION_FRAC);
    if (bal < stake + commission) { bust++; bal = ACCT_INIT; peak = ACCT_INIT; for (const k of Object.keys(stratState)) stratState[k].level = 0; }
    const r = resolve(sig, candles[sig.sym]);
    if (!r) continue;
    const move = sig.side === "BUY" ? (r.exitPrice - r.finalE) / r.finalE : (r.finalE - r.exitPrice) / r.finalE;
    let pnl = stake * MULT * move - commission;
    if (pnl < -stake) pnl = -stake;
    pnl = round2(pnl);
    bal = round2(bal + pnl);
    trades++;
    if (r.outcome === "TP") { wins++; ss.level = 0; ss.curStreak = 0; }
    else { losses++; ss.curStreak++; if (ss.curStreak > ss.longestL) ss.longestL = ss.curStreak; ss.level = ss.level + 1 > DEPTH ? 0 : ss.level + 1; }
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    ss.busy = r.exitIdx;
    stratStats[sig.stratLabel].trades++;
    if (r.outcome === "TP") stratStats[sig.stratLabel].wins++;
    stratStats[sig.stratLabel].net += pnl;
    const dayKey = new Date(sig.epoch * 1000).toISOString().slice(5, 10);
    dailyBal.set(dayKey, bal);
  }

  const wr = trades > 0 ? wins / trades * 100 : 0;
  console.log(`\nFinal book stats:`);
  console.log(`  trades=${trades}  W=${wins}  L=${losses}  WR=${wr.toFixed(1)}%  bust=${bust}`);
  console.log(`  final balance: $${bal.toFixed(2)}  (Δ ${bal - ACCT_INIT >= 0 ? "+" : ""}$${(bal - ACCT_INIT).toFixed(2)} = ${((bal - ACCT_INIT)/ACCT_INIT*100).toFixed(0)}% on $${ACCT_INIT})`);
  console.log(`  peak: $${peak.toFixed(2)}   maxDD: $${maxDD.toFixed(2)} (${(maxDD/peak*100).toFixed(1)}% of peak)`);
  console.log();

  console.log(`Per-strategy contribution to combined book:`);
  for (const cand of CANDIDATES) {
    const s = stratStats[cand.label]; const ss = stratState[cand.label];
    const swr = s.trades > 0 ? (s.wins / s.trades * 100).toFixed(1) : "—";
    console.log(`  ${cand.label.padEnd(24)}  ${String(s.trades).padStart(4)}t  WR=${swr}%  longest=${ss.longestL}  net=${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2)}`);
  }

  console.log(`\nDaily balance progression (combined book):`);
  console.log(`  ${"date".padEnd(8)} balance     equity_change_from_prior`);
  let prev = ACCT_INIT;
  for (const [day, b] of Array.from(dailyBal.entries()).sort()) {
    const change = b - prev;
    const sign = change >= 0 ? "+" : "";
    console.log(`  ${day.padEnd(8)} $${b.toFixed(2).padStart(9)}   ${sign}$${change.toFixed(2)}`);
    prev = b;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

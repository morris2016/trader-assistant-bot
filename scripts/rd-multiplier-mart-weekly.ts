// Week-by-week breakdown for April 2026 + last available May days.
// $150 acct, $10 base, 2.0× mart, depth 2, on the 5 zero-bust d=2 strategies.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 130;
const ACCT_INIT = 150, BASE_STAKE = 10, MULT = 100, MART_RATIO = 2.0;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;
const DEPTH = 2;

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

type WeekRes = { trades: number; wins: number; net: number; bust: number; longestL: number; balStart: number; balEnd: number; maxDD: number };

function simWeek(sigs: Sig[], candles: Candle[], fromEpoch: number, toEpoch: number, balStart: number): WeekRes {
  let bal = balStart, peak = balStart, maxDD = 0;
  let trades = 0, wins = 0, net = 0, bust = 0, longestL = 0, curStreak = 0;
  let level = 0; let busy = -1;

  for (const sig of sigs) {
    if (sig.epoch < fromEpoch || sig.epoch >= toEpoch) continue;
    if (sig.idx < busy) continue;
    const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, level));
    const commission = round2(stake * COMMISSION_FRAC);
    if (bal < stake + commission) { bust++; bal = ACCT_INIT; peak = ACCT_INIT; level = 0; }
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
    else { curStreak++; if (curStreak > longestL) longestL = curStreak; level = level + 1 > DEPTH ? 0 : level + 1; }
    net += pnl;
    if (bal > peak) peak = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    busy = exitIdx;
  }
  return { trades, wins, net: round2(net), bust, longestL, balStart, balEnd: bal, maxDD: round2(maxDD) };
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

  // March 2026 weekly
  const weeks = [
    { name: "Mar W1", from: Date.UTC(2026,2,1)/1000,   to: Date.UTC(2026,2,8)/1000 },
    { name: "Mar W2", from: Date.UTC(2026,2,8)/1000,   to: Date.UTC(2026,2,15)/1000 },
    { name: "Mar W3", from: Date.UTC(2026,2,15)/1000,  to: Date.UTC(2026,2,22)/1000 },
    { name: "Mar W4", from: Date.UTC(2026,2,22)/1000,  to: Date.UTC(2026,2,29)/1000 },
    { name: "Mar W5", from: Date.UTC(2026,2,29)/1000,  to: Date.UTC(2026,3,1)/1000 },
  ];

  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`Week-by-week March 2026 (UTC) · $150 acct · $10 stake · 2.0× mart d=${DEPTH} · 100× mult`);
  console.log(`${"".padEnd(110, "═")}`);

  // Per-strategy weekly
  for (const cand of CANDIDATES) {
    const sigs = detect(candles[cand.sym], cand.type);
    console.log(`\n${cand.label}`);
    console.log(`  ${"week".padEnd(8)} trades  W   L    longestL  $net      maxDD   bust`);
    let stratNet = 0;
    for (const w of weeks) {
      const r = simWeek(sigs, candles[cand.sym], w.from, w.to, ACCT_INIT);
      stratNet += r.net;
      const wr = r.trades > 0 ? (r.wins / r.trades * 100).toFixed(0) : "—";
      console.log(`  ${w.name.padEnd(8)} ${String(r.trades).padStart(5)}   ${String(r.wins).padStart(3)} ${String(r.trades - r.wins).padStart(3)}    ${String(r.longestL).padStart(2)}      ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(8)}  $${r.maxDD.toFixed(2).padStart(6)}  ${r.bust > 0 ? "❌" + r.bust : "✓"}    (WR ${wr}%)`);
    }
    console.log(`  ${"-".padEnd(70, "-")}`);
    console.log(`  ${"TOTAL".padEnd(8)} 5wk apr+1wk may ${stratNet >= 0 ? "+" : ""}$${stratNet.toFixed(2)}`);
  }

  // Combined book per week (each strategy starts each week with $150)
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`COMBINED BOOK (5 strategies, each starts week with $150)`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  ${"week".padEnd(8)} sumNet     totalTrades  busts`);
  let bookNet = 0;
  for (const w of weeks) {
    let netW = 0, trW = 0, bustW = 0;
    for (const cand of CANDIDATES) {
      const sigs = detect(candles[cand.sym], cand.type);
      const r = simWeek(sigs, candles[cand.sym], w.from, w.to, ACCT_INIT);
      netW += r.net; trW += r.trades; bustW += r.bust;
    }
    bookNet += netW;
    console.log(`  ${w.name.padEnd(8)} ${netW >= 0 ? "+" : ""}$${netW.toFixed(2).padStart(8)}  ${String(trW).padStart(4)}         ${bustW}`);
  }
  console.log(`  ${"-".padEnd(70, "-")}`);
  console.log(`  ${"TOTAL".padEnd(8)} ${bookNet >= 0 ? "+" : ""}$${bookNet.toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

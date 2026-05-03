// 3-window cross-validation on the multiplier-capable winners from the
// rd-strategy-port-to-multipliers screen. $20 acct, $5 stake, 100× mult.
//
// Splits 60d into W0/TRAIN/TEST (20d each), tracks balance with bust resets,
// reports per-window net/WR/maxDD/bust. Validation = net positive in ALL 3
// windows AND ≤2 busts cumulative.
//
// Usage: npx ts-node scripts/rd-multiplier-validate.ts

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 60;
const ACCT_INIT = 20, STAKE = 5, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

type Cand = { sym: string; type: "FADE_UP" | "FADE_DOWN" | "DRIFT_UP" | "DRIFT_DOWN"; label: string };
const CANDIDATES: Cand[] = [
  { sym: "JD75",      type: "FADE_DOWN",  label: "JD75_FADE_DOWN" },
  { sym: "BOOM300N",  type: "FADE_UP",    label: "BOOM300N_FADE_UP" },
  { sym: "CRASH300N", type: "FADE_DOWN",  label: "CRASH300N_FADE_DOWN" },
  { sym: "JD75",      type: "FADE_UP",    label: "JD75_FADE_UP" },
  { sym: "BOOM300N",  type: "DRIFT_DOWN", label: "BOOM300N_DRIFT_DOWN" },
  { sym: "JD50",      type: "FADE_DOWN",  label: "JD50_FADE_DOWN" },
  { sym: "CRASH300N", type: "FADE_UP",    label: "CRASH300N_FADE_UP" },
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
    catch (e) { console.error(`  fetch fail ${end}: ${(e as Error).message}`); break; }
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
    if (type === "FADE_UP" && upPierce) {
      const d = FADE_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d });
    }
    if (type === "FADE_DOWN" && dnPierce) {
      const d = FADE_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d });
    }
    if (type === "DRIFT_UP" && upPierce) {
      const d = DRIFT_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, side: "BUY", entry: cur.close, stop: cur.close - d, target: cur.close + d });
    }
    if (type === "DRIFT_DOWN" && dnPierce) {
      const d = DRIFT_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, side: "SELL", entry: cur.close, stop: cur.close + d, target: cur.close - d });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type WinResult = { trades: number; wins: number; net: number; finalBal: number; peak: number; trough: number; maxDD: number; bust: number };

function simulate(sigs: Sig[], candles: Candle[], fromEpoch: number, toEpoch: number, noOverlap: boolean): WinResult {
  let bal = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, maxDD = 0;
  let trades = 0, wins = 0, net = 0, bust = 0;
  let busy = -1;

  for (const sig of sigs) {
    if (sig.epoch < fromEpoch || sig.epoch >= toEpoch) continue;
    if (noOverlap && sig.idx < busy) continue;
    const commission = round2(STAKE * COMMISSION_FRAC);
    if (bal < STAKE + commission) { bust++; bal = ACCT_INIT; peak = ACCT_INIT; trough = ACCT_INIT; }
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
    let pnl = STAKE * MULT * move - commission;
    if (pnl < -STAKE) pnl = -STAKE;
    pnl = round2(pnl);
    bal = round2(bal + pnl);
    trades++;
    if (exit === "TP") wins++;
    net += pnl;
    if (bal > peak) peak = bal;
    if (bal < trough) trough = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    busy = exitIdx;
  }
  return { trades, wins, net: round2(net), finalBal: bal, peak: round2(peak), trough: round2(trough), maxDD: round2(maxDD), bust };
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

  // Use first symbol's range as window reference
  const ref = candles[CANDIDATES[0].sym];
  const earliest = ref[0].epoch, latest = ref[ref.length-1].epoch;
  const total = latest - earliest;
  const w0End = earliest + total / 3, trainEnd = earliest + 2 * total / 3;
  const windows = [
    { name: "W0",    from: earliest, to: w0End },
    { name: "TRAIN", from: w0End,    to: trainEnd },
    { name: "TEST",  from: trainEnd, to: latest },
  ];
  console.log(`\nWindows (UTC):`);
  for (const w of windows) console.log(`  ${w.name}: ${new Date(w.from*1000).toISOString().slice(0,10)} → ${new Date(w.to*1000).toISOString().slice(0,10)}`);
  console.log(`\nAcct=$${ACCT_INIT}  Stake=$${STAKE}  Mult=${MULT}×  Fade kAtr=${FADE_KATR}  Drift kAtr=${DRIFT_KATR}\n`);

  for (const overlapMode of [false, true]) {
    console.log(`${"".padEnd(115, "═")}`);
    console.log(`MODE: ${overlapMode ? "no-overlap (1 trade at a time)" : "all-in (every signal taken)"}`);
    console.log(`${"".padEnd(115, "═")}`);
    console.log(`${"strat".padEnd(26)} window  trades  wins   WR      $net      finalBal  peak    maxDD   bust   verdict`);

    for (const cand of CANDIDATES) {
      const sigs = detect(candles[cand.sym], cand.type);
      let allPositive = true; let totalBust = 0;
      const lines: string[] = [];
      for (const w of windows) {
        const r = simulate(sigs, candles[cand.sym], w.from, w.to, overlapMode);
        if (r.trades === 0) { lines.push(`${"".padEnd(26)} ${w.name.padEnd(7)} 0 trades`); allPositive = false; continue; }
        totalBust += r.bust;
        const wr = r.wins / r.trades;
        const verd = r.net > 0 ? (r.bust === 0 ? "+ pass" : `+ ${r.bust} bust`) : "− fail";
        if (r.net <= 0) allPositive = false;
        lines.push(`${"".padEnd(26)} ${w.name.padEnd(7)} ${String(r.trades).padStart(5)}  ${String(r.wins).padStart(4)}   ${(wr*100).toFixed(1).padStart(5)}%  ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(8)}  $${r.finalBal.toFixed(2).padStart(7)}  $${r.peak.toFixed(2).padStart(7)}  $${r.maxDD.toFixed(2).padStart(6)}  ${String(r.bust).padStart(3)}    ${verd}`);
      }
      const tag = allPositive && totalBust <= 2 ? "★ VALIDATED" : allPositive ? "  positive but bust-prone" : "  rejected";
      console.log(`\n${cand.label.padEnd(26)} ${tag}`);
      for (const l of lines) console.log(l);
    }
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

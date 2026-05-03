// Port the RD R-stack screen (15-bar pierce, MOM_RATIO=0.7, kAtr fade=4.0 /
// drift=2.5) to multiplier-capable Deriv symbols. Goal: find the closest
// analog so fast2 can run LIVE.
//
// For each symbol we test BOTH possible biases (BUY-drift / SELL-drift) and
// BOTH detectors (fade / drift). 60 days of 5m bars, $20 acct / $3 stake / 100×.
//
// Usage: npx ts-node scripts/rd-strategy-port-to-multipliers.ts

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOLS = [
  "BOOM300N", "CRASH300N",
  "BOOM500",  "CRASH500",
  "BOOM1000", "CRASH1000",
  "JD100", "JD75", "JD50",
];

const GR = 300, DAYS = 60;
const ACCT = 20, STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(WS_URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, totalBars: number): Promise<Candle[]> {
  const PAGE = 5000;
  let end: any = "latest";
  const all: Candle[] = [];
  let remaining = totalBars;
  while (remaining > 0) {
    const ask = Math.min(PAGE, remaining);
    let r: any;
    try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: ask, end: String(end), style: "candles", granularity: gr }); }
    catch (e) { console.error(`  fetch fail ${sym} ${end}: ${(e as Error).message}`); break; }
    const raw = (r.candles ?? []) as any[];
    if (raw.length === 0) break;
    const page = raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
      .sort((a, b) => a.epoch - b.epoch);
    all.unshift(...page);
    if (page.length < ask) break;
    end = page[0].epoch - 1;
    remaining -= page.length;
  }
  // dedupe by epoch
  const seen = new Set<number>();
  return all.filter((b) => { if (seen.has(b.epoch)) return false; seen.add(b.epoch); return true; }).sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

type Sig = { idx: number; epoch: number; strat: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

// Test ALL 4 detector branches and let the result tell us which has edge
function detectAll(candles: Candle[], sym: string): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    if (upPierce) {
      const dF = FADE_KATR * a, dD = DRIFT_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, strat: `${sym}_FADE_UP`,    side: "SELL", entry: cur.close, stop: cur.close + dF, target: cur.close - dF });
      out.push({ idx: i, epoch: cur.epoch, strat: `${sym}_DRIFT_UP`,   side: "BUY",  entry: cur.close, stop: cur.close - dD, target: cur.close + dD });
    }
    if (dnPierce) {
      const dF = FADE_KATR * a, dD = DRIFT_KATR * a;
      out.push({ idx: i, epoch: cur.epoch, strat: `${sym}_FADE_DOWN`,  side: "BUY",  entry: cur.close, stop: cur.close - dF, target: cur.close + dF });
      out.push({ idx: i, epoch: cur.epoch, strat: `${sym}_DRIFT_DOWN`, side: "SELL", entry: cur.close, stop: cur.close + dD, target: cur.close - dD });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Stat = { trades: number; wins: number; net: number; r: number };
function newStat(): Stat { return { trades: 0, wins: 0, net: 0, r: 0 }; }

async function main() {
  const c = new C(); await c.ready;
  const need = DAYS * 24 * 12 + 250;
  console.log(`R-stack port screen: 15-bar pierce, MOM=${MOM_RATIO}, fadeK=${FADE_KATR}, driftK=${DRIFT_KATR}`);
  console.log(`Window: last ${DAYS} days · 5m · acct=$${ACCT} stake=$${STAKE} mult=${MULT}×`);
  console.log(`${"".padEnd(95, "═")}\n`);

  const allRows: { sym: string; strat: string; stat: Stat; tperday: number }[] = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym}: fetching... `);
    let candles: Candle[] = [];
    try { candles = await fetchPaged(c, sym, GR, need); } catch (e) { console.log(`fail ${(e as Error).message}`); continue; }
    if (candles.length === 0) { console.log(`no data`); continue; }
    const span = (candles[candles.length-1].epoch - candles[0].epoch) / 86400;
    console.log(`${candles.length}b / ${span.toFixed(1)}d`);

    const sigs = detectAll(candles, sym);
    if (sigs.length === 0) { console.log(`  no signals\n`); continue; }

    // Group by strat label
    const byStrat: Record<string, Sig[]> = {};
    for (const s of sigs) (byStrat[s.strat] ??= []).push(s);

    for (const [stratName, group] of Object.entries(byStrat)) {
      const stat = newStat();
      for (const sig of group) {
        const commission = round2(STAKE * COMMISSION_FRAC);
        if (sig.idx + 1 >= candles.length) continue;
        const finBar = candles[sig.idx + 1];
        const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
        const delta = finalE - sig.entry;
        const stop = sig.stop + delta;
        const target = sig.target + delta;
        let exit: "TP" | "SL" | null = null; let exitPrice = 0;
        for (let j = sig.idx + 1; j < candles.length; j++) {
          const b = candles[j];
          if (sig.side === "BUY") {
            if (b.low <= stop) { exit = "SL"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; break; }
            if (b.high >= target) { exit = "TP"; exitPrice = target; break; }
          } else {
            if (b.high >= stop) { exit = "SL"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
            if (b.low <= target) { exit = "TP"; exitPrice = target; break; }
          }
        }
        if (exit == null) continue;
        const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
        let pnl = STAKE * MULT * move - commission;
        if (pnl < -STAKE) pnl = -STAKE;
        pnl = round2(pnl);
        stat.trades++;
        if (exit === "TP") { stat.wins++; stat.r += 1; } else { stat.r -= 1; }
        stat.net += pnl;
      }
      const tperday = stat.trades / span;
      allRows.push({ sym, strat: stratName, stat, tperday });
    }
  }
  c.close();

  // Sort by net descending, show winners
  allRows.sort((a, b) => b.stat.net - a.stat.net);
  console.log(`\n${"".padEnd(95, "═")}`);
  console.log(`RESULTS (sorted by $ net):`);
  console.log(`${"strat".padEnd(24)} trades   WR     $net      R      t/day   verdict`);
  for (const row of allRows) {
    const { stat } = row;
    const wr = stat.trades > 0 ? stat.wins / stat.trades : 0;
    const rAvg = stat.trades > 0 ? stat.r / stat.trades : 0;
    const verdict = stat.net > 200 ? "★ STRONG" : stat.net > 50 ? "weak +" : stat.net > -50 ? "flat" : "negative";
    console.log(`${row.strat.padEnd(24)} ${String(stat.trades).padStart(5)}   ${(wr*100).toFixed(1).padStart(5)}%  ${(stat.net >= 0 ? "+" : "")}$${stat.net.toFixed(2).padStart(7)}  ${(rAvg >= 0 ? "+" : "")}${rAvg.toFixed(2)}R   ${row.tperday.toFixed(2).padStart(5)}    ${verdict}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

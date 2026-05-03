// RD CALL/PUT 3-window cross-validation on the strong candidates from
// rd-callput-screen.ts. $20 acct, $5 flat stake, payout=0.95×.
//
// Splits 90 days into 3 equal 30-day windows (W0=oldest, TRAIN, TEST).
// Reports per-window: trades, wins, WR, $net, peak/trough balance, max DD,
// bust count. A strategy must be net-positive in ALL 3 windows to validate.
//
// Concurrency: at H=20 a trade holds 100 min while new signals fire. We
// model TWO modes:
//   - "no-overlap" (skip new signal if any open) — conservative, what bot
//     should do at $5/$20
//   - "all-in" (every signal taken regardless) — upper bound, real EV
//
// Usage: npx ts-node scripts/rd-callput-validate.ts

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 90;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const ACCT_INIT = 20, STAKE = 5;
const PAYOUTS = [0.95, 0.85]; // best/realistic

type Cand = { sym: "RDBEAR" | "RDBULL"; pierce: "UP" | "DOWN"; bet: "CALL" | "PUT"; H: number; label: string };
const CANDIDATES: Cand[] = [
  { sym: "RDBULL", pierce: "DOWN", bet: "CALL", H: 20, label: "RDBULL_FADE_DOWN_H20" }, // 61.3%
  { sym: "RDBULL", pierce: "DOWN", bet: "CALL", H: 10, label: "RDBULL_FADE_DOWN_H10" }, // 59.7%
  { sym: "RDBULL", pierce: "UP",   bet: "CALL", H: 10, label: "RDBULL_DRIFT_UP_H10" },   // 58.9%
  { sym: "RDBULL", pierce: "UP",   bet: "CALL", H: 20, label: "RDBULL_DRIFT_UP_H20" },   // 57.4%
  { sym: "RDBULL", pierce: "DOWN", bet: "CALL", H: 5,  label: "RDBULL_FADE_DOWN_H5" },   // 57.3%
  { sym: "RDBEAR", pierce: "UP",   bet: "PUT",  H: 20, label: "RDBEAR_FADE_UP_H20" },    // 56.7%
  { sym: "RDBEAR", pierce: "UP",   bet: "PUT",  H: 10, label: "RDBEAR_FADE_UP_H10" },    // 55.3%
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

type Sig = { idx: number; epoch: number; pierce: "UP" | "DOWN"; entry: number };
function detectPierces(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    if (cur.close > hi && cpu >= MOM_RATIO) out.push({ idx: i, epoch: cur.epoch, pierce: "UP", entry: cur.close });
    if (cur.close < lo && cpd >= MOM_RATIO) out.push({ idx: i, epoch: cur.epoch, pierce: "DOWN", entry: cur.close });
  }
  return out;
}

type Result = { trades: number; wins: number; net: number; peak: number; trough: number; bust: number; finalBal: number; maxDD: number };

function simulate(sigs: Sig[], candles: Candle[], cand: Cand, fromEpoch: number, toEpoch: number, payout: number, mode: "no-overlap" | "all-in"): Result {
  let bal = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, maxDD = 0;
  let trades = 0, wins = 0, net = 0, bust = 0;
  let busy = -1; // bar idx until which we're holding (no-overlap mode)

  for (const sig of sigs) {
    if (sig.pierce !== cand.pierce) continue;
    if (sig.epoch < fromEpoch || sig.epoch >= toEpoch) continue;
    if (mode === "no-overlap" && sig.idx < busy) continue;
    const futIdx = sig.idx + cand.H;
    if (futIdx >= candles.length) continue;
    const futClose = candles[futIdx].close;
    const moved = futClose - sig.entry;
    if (moved === 0) continue;
    if (bal < STAKE) { bust++; bal = ACCT_INIT; continue; } // ruin → reset to track multiple busts

    const wonDirection = cand.bet === "CALL" ? moved > 0 : moved < 0;
    const pnl = wonDirection ? STAKE * payout : -STAKE;
    bal = Math.round((bal + pnl) * 100) / 100;
    trades++;
    if (wonDirection) wins++;
    net += pnl;
    if (bal > peak) peak = bal;
    if (bal < trough) trough = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    busy = sig.idx + cand.H;
  }
  return { trades, wins, net: Math.round(net * 100) / 100, peak, trough, bust, finalBal: Math.round(bal * 100) / 100, maxDD: Math.round(maxDD * 100) / 100 };
}

async function main() {
  const c = new C(); await c.ready;
  const need = DAYS * 24 * 12 + 250;

  const candles: Record<string, Candle[]> = {};
  for (const sym of ["RDBEAR", "RDBULL"]) {
    process.stdout.write(`${sym} fetching... `);
    candles[sym] = await fetchPaged(c, sym, GR, need);
    const span = (candles[sym][candles[sym].length-1].epoch - candles[sym][0].epoch) / 86400;
    console.log(`${candles[sym].length}b / ${span.toFixed(1)}d`);
  }
  c.close();

  // Define windows from RDBEAR's epoch range (both symbols share Deriv server clock)
  const ref = candles["RDBEAR"];
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

  console.log(`\nAcct=$${ACCT_INIT}  Stake=$${STAKE}  Mode=no-overlap (one position at a time)`);
  console.log(`Validation rule: must be NET POSITIVE in all 3 windows AT 0.85 PAYOUT to deploy live.\n`);

  for (const payout of PAYOUTS) {
    console.log(`${"".padEnd(110, "═")}`);
    console.log(`PAYOUT = ${payout}× (breakeven WR = ${(100/(100+payout*100)*100).toFixed(2)}%)`);
    console.log(`${"".padEnd(110, "═")}`);
    console.log(`${"strat".padEnd(28)} window  trades  wins   WR      $net      finalBal  maxDD   bust   verdict`);

    for (const cand of CANDIDATES) {
      const sigs = detectPierces(candles[cand.sym]);
      let allPositive = true;
      const lines: string[] = [];
      for (const w of windows) {
        const r = simulate(sigs, candles[cand.sym], cand, w.from, w.to, payout, "no-overlap");
        if (r.trades === 0) { lines.push(`${"".padEnd(28)} ${w.name.padEnd(7)} 0 trades`); allPositive = false; continue; }
        const wr = r.wins / r.trades;
        const verd = r.net > 0 ? (r.bust === 0 ? "+ pass" : "+ but bust") : "− fail";
        if (r.net <= 0) allPositive = false;
        lines.push(`${"".padEnd(28)} ${w.name.padEnd(7)} ${String(r.trades).padStart(5)}  ${String(r.wins).padStart(4)}   ${(wr*100).toFixed(1).padStart(5)}%  ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(7)}  $${r.finalBal.toFixed(2).padStart(6)}  $${r.maxDD.toFixed(2).padStart(5)}  ${String(r.bust).padStart(3)}    ${verd}`);
      }
      const tag = allPositive ? "★ VALIDATED" : "  rejected";
      console.log(`\n${cand.label.padEnd(28)} ${tag}`);
      for (const l of lines) console.log(l);
    }
    console.log();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

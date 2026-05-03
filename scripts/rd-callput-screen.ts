// RD CALL/PUT (rise/fall) screen — find a binary-options strategy on
// RDBEAR/RDBULL that the Deriv account CAN trade live. Multipliers aren't
// offered for these symbols, so we need a fixed-payout signal with WR > ~53%
// (breakeven at 95% payout = 51.3%; +1.7% buffer for spread/slippage).
//
// Approach: take the existing 15-bar pierce signal, evaluate close-vs-close
// outcome at horizons 1/3/5/10/20 bars, BOTH fade and drift hypotheses.
// Any combo with WR > 53% over a meaningful sample is a candidate.
//
// Usage: npx ts-node scripts/rd-callput-screen.ts

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GR = 300, DAYS = 90;
const LOOKBACK = 15, MOM_RATIO = 0.7;
const HORIZONS = [1, 3, 5, 10, 20]; // bars (5m * H = horizon in minutes)
const PAYOUT = 0.95;

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

type Signal = { idx: number; epoch: number; pierce: "UP" | "DOWN"; entry: number };

function detectPierces(candles: Candle[]): Signal[] {
  const out: Signal[] = [];
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

type Stat = { n: number; wins: number };
function newStat(): Stat { return { n: 0, wins: 0 }; }

async function main() {
  const c = new C(); await c.ready;
  const need = DAYS * 24 * 12 + 250;
  console.log(`RD CALL/PUT (binary) screen · ${DAYS}d 5m · LB=${LOOKBACK} MOM=${MOM_RATIO}`);
  console.log(`Payout=${PAYOUT}× → breakeven WR=${(100/(100+PAYOUT*100)).toFixed(3)}; target ≥0.530\n`);

  for (const sym of ["RDBEAR", "RDBULL"]) {
    process.stdout.write(`${sym}: fetching... `);
    const candles = await fetchPaged(c, sym, GR, need);
    if (candles.length === 0) { console.log(`no data`); continue; }
    const span = (candles[candles.length-1].epoch - candles[0].epoch) / 86400;
    console.log(`${candles.length}b / ${span.toFixed(1)}d`);

    const sigs = detectPierces(candles);
    const upSigs = sigs.filter((s) => s.pierce === "UP");
    const dnSigs = sigs.filter((s) => s.pierce === "DOWN");
    console.log(`  pierces: up=${upSigs.length}, dn=${dnSigs.length}`);

    // For each horizon, compute WR for: FADE-UP (predict close lower at H), FADE-DOWN (predict close higher),
    // DRIFT-UP (predict close higher), DRIFT-DOWN (predict close lower).
    const grid: Record<string, Stat> = {};
    for (const H of HORIZONS) {
      grid[`H${H}_FADE_UP`] = newStat();
      grid[`H${H}_FADE_DOWN`] = newStat();
      grid[`H${H}_DRIFT_UP`] = newStat();
      grid[`H${H}_DRIFT_DOWN`] = newStat();
    }

    for (const sig of sigs) {
      for (const H of HORIZONS) {
        const futIdx = sig.idx + H;
        if (futIdx >= candles.length) continue;
        const futClose = candles[futIdx].close;
        const moved = futClose - sig.entry;
        if (moved === 0) continue; // tie skip

        if (sig.pierce === "UP") {
          // FADE-UP: bet PUT (close lower than entry)
          { const k = grid[`H${H}_FADE_UP`]; k.n++; if (moved < 0) k.wins++; }
          // DRIFT-UP: bet CALL (close higher)
          { const k = grid[`H${H}_DRIFT_UP`]; k.n++; if (moved > 0) k.wins++; }
        } else {
          // FADE-DOWN: bet CALL (close higher)
          { const k = grid[`H${H}_FADE_DOWN`]; k.n++; if (moved > 0) k.wins++; }
          // DRIFT-DOWN: bet PUT (close lower)
          { const k = grid[`H${H}_DRIFT_DOWN`]; k.n++; if (moved < 0) k.wins++; }
        }
      }
    }

    console.log(`  ${"strat".padEnd(20)} n      wins    WR      EV/contract($1 stake)   verdict`);
    for (const H of HORIZONS) {
      for (const dir of ["FADE_UP", "FADE_DOWN", "DRIFT_UP", "DRIFT_DOWN"]) {
        const k = grid[`H${H}_${dir}`];
        if (k.n === 0) continue;
        const wr = k.wins / k.n;
        const ev = wr * PAYOUT - (1 - wr); // per $1 stake
        const verdict = wr >= 0.55 ? "★ STRONG" : wr >= 0.53 ? "viable" : wr >= 0.51 ? "marginal" : "negative";
        console.log(`  ${`H=${H} ${dir}`.padEnd(20)} ${String(k.n).padStart(4)}   ${String(k.wins).padStart(4)}    ${(wr*100).toFixed(2).padStart(5)}%  ${(ev >= 0 ? "+" : "")}$${ev.toFixed(4)}              ${verdict}`);
      }
    }
    console.log();
  }
  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

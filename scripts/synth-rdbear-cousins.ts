// Test RDBEAR mean-rev detector on sister/cousin Deriv random indices.
// Per-month breakdown across full history.
// Universe:
//   RDBEAR  — validated baseline (bear-drift, SELL-only)
//   RDBULL  — bull-drift mirror (BUY-only, fade down-pierces)
//   R_10/25/50/75/100  — uniform volatility (test BOTH sides)

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 3, MULT = 100, COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, KATR = 2.5, MOM_RATIO = 0.7;
const GR = 300; // 5m

const ASSETS: Array<{ sym: string; sides: ("BUY" | "SELL")[] }> = [
  { sym: "RDBEAR",  sides: ["SELL"] },               // validated baseline
  { sym: "RDBULL",  sides: ["BUY"] },                // bull mirror
  { sym: "R_10",    sides: ["BUY", "SELL"] },
  { sym: "R_25",    sides: ["BUY", "SELL"] },
  { sym: "R_50",    sides: ["BUY", "SELL"] },
  { sym: "R_75",    sides: ["BUY", "SELL"] },
  { sym: "R_100",   sides: ["BUY", "SELL"] },
];

const TODAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
const NEED_DAYS = 240;
const FROM = TODAY - NEED_DAYS * 86400;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 60_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = []; let cursor = end;
  while (candles.length < count) { const want = Math.min(5000, count - candles.length);
    let r: any; try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); }
    catch { return candles; }
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch); cursor = ch[0].epoch - 1; if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

// Breakout mean-rev detector — fade up-pierces with SELL, down-pierces with BUY (no regime gates)
function sim(candles: Candle[], side: "BUY" | "SELL", from: number, to: number) {
  let trades = 0, wins = 0, net = 0;
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    if (candles[i].epoch < from || candles[i].epoch >= to) continue;
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = KATR * a;
    let entry = 0, stop = 0, target = 0;
    if (side === "SELL") {
      if (!(cur.close > hi && closePosUp >= MOM_RATIO)) continue;
      entry = cur.close; stop = cur.close + dist; target = cur.close - dist;
    } else {
      if (!(cur.close < lo && closePosDn >= MOM_RATIO)) continue;
      entry = cur.close; stop = cur.close - dist; target = cur.close + dist;
    }
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - entry;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null; let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (side === "BUY") {
        if (b.low <= stopAdj) { exit = "SL"; exitPrice = stopAdj - stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      } else {
        if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      }
    }
    if (!exit) continue;
    const move = side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    if (exit === "TP") wins++; trades++; net += pnl;
  }
  return { trades, wins, net, wr: trades > 0 ? wins / trades : 0 };
}

async function main() {
  console.log(`RDBEAR-cousin breakout-mean-rev test (${NEED_DAYS} days, 5m, lb=15 kAtr=2.5 m=0.7, no regime)\n`);
  const c = new C(); await c.ready;

  type AsyncRes = { sym: string; firstEpoch: number; candles: Candle[] };
  const fetched: AsyncRes[] = [];
  for (const a of ASSETS) {
    process.stdout.write(`Fetching ${a.sym}... `);
    const need = Math.ceil(NEED_DAYS * 86400 / GR) + 50;
    let candles: Candle[] = [];
    try { candles = await fetchPaged(c, a.sym, GR, need, TODAY); } catch { console.log(`FAILED`); continue; }
    if (candles.length < 50) { console.log(`only ${candles.length} bars — skip`); continue; }
    const firstEpoch = candles[0].epoch;
    console.log(`${candles.length} bars from ${new Date(firstEpoch * 1000).toISOString().slice(0,10)}`);
    fetched.push({ sym: a.sym, firstEpoch, candles });
  }
  c.close();
  console.log();

  // Per-month breakdown for each (asset, side)
  for (const a of ASSETS) {
    const f = fetched.find((x) => x.sym === a.sym); if (!f) continue;
    for (const side of a.sides) {
      const startD = new Date(f.firstEpoch * 1000);
      let y = startD.getUTCFullYear(), m = startD.getUTCMonth();
      const totals = { trades: 0, wins: 0, net: 0 };
      const monthRows: string[] = [];
      while (true) {
        const start = Math.floor(Date.UTC(y, m, 1) / 1000);
        const nextM = m === 11 ? 0 : m + 1; const nextY = m === 11 ? y + 1 : y;
        const end = Math.floor(Date.UTC(nextY, nextM, 1) / 1000);
        if (start >= TODAY) break;
        const r = sim(f.candles, side, start, Math.min(end, TODAY));
        totals.trades += r.trades; totals.wins += r.wins; totals.net += r.net;
        const tag = `${y}-${String(m + 1).padStart(2, "0")}`;
        monthRows.push(`    ${tag}  ${String(r.trades).padStart(5)}t  ${(r.wr*100).toFixed(0).padStart(2)}%  ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(0).padStart(5)}`);
        if (m === 11) { y++; m = 0; } else m++;
      }
      const wr = totals.trades > 0 ? totals.wins / totals.trades : 0;
      const epd = totals.trades > 0 ? totals.net / totals.trades : 0;
      const flag = totals.net > 0 && wr >= 0.50 ? " ★" : totals.net > 0 ? " ✓" : "";
      console.log(`${a.sym} ${side}${flag}  TOTAL: ${totals.trades}t  WR=${(wr*100).toFixed(1)}%  net=${totals.net >= 0 ? "+" : ""}$${totals.net.toFixed(2)}  epd=${epd >= 0 ? "+" : ""}$${epd.toFixed(3)}`);
      for (const row of monthRows) console.log(row);
      console.log();
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

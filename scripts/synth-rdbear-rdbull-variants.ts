// Test additional RDBEAR/RDBULL variants — different timeframes + different
// detector geometries — to find a complementary strategy alongside the
// validated 5m mean-rev fade. Per-month breakdown for each.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 3, MULT = 100, COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;

const TODAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
const NEED_DAYS = 240;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 90_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = []; let cursor = end;
  while (candles.length < count) { const want = Math.min(5000, count - candles.length);
    let r: any; try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); } catch { return candles; }
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

type Variant = {
  label: string;
  gr: number;            // granularity seconds
  lookback: number;
  kAtr: number;
  momRatio: number;
  fade: boolean;         // true = fade pierce (mean-rev), false = ride pierce (continuation)
};

function sim(candles: Candle[], side: "BUY" | "SELL", v: Variant, from: number, to: number) {
  let trades = 0, wins = 0, net = 0;
  for (let i = v.lookback + 14 + 1; i < candles.length; i++) {
    if (candles[i].epoch < from || candles[i].epoch >= to) continue;
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = v.kAtr * a;
    let entry = 0, stop = 0, target = 0;
    let pierce: "up" | "dn" | null = null;
    if (cur.close > hi && closePosUp >= v.momRatio) pierce = "up";
    else if (cur.close < lo && closePosDn >= v.momRatio) pierce = "dn";
    if (!pierce) continue;
    // Decide direction based on fade vs ride
    let actualSide: "BUY" | "SELL";
    if (v.fade) actualSide = pierce === "up" ? "SELL" : "BUY";
    else        actualSide = pierce === "up" ? "BUY"  : "SELL";
    if (actualSide !== side) continue;
    if (actualSide === "BUY")  { entry = cur.close; stop = cur.close - dist; target = cur.close + dist; }
    else                       { entry = cur.close; stop = cur.close + dist; target = cur.close - dist; }
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = actualSide === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - entry;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null; let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (actualSide === "BUY") {
        if (b.low <= stopAdj) { exit = "SL"; exitPrice = stopAdj - stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      } else {
        if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      }
    }
    if (!exit) continue;
    const move = actualSide === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    if (exit === "TP") wins++; trades++; net += pnl;
  }
  return { trades, wins, net, wr: trades > 0 ? wins / trades : 0 };
}

async function main() {
  console.log(`RDBEAR / RDBULL variant search (${NEED_DAYS} days, per-month)\n`);
  const c = new C(); await c.ready;

  // Pre-fetch each (sym, gr)
  const gridKey = (sym: string, gr: number) => `${sym}|${gr}`;
  const dataCache = new Map<string, Candle[]>();
  for (const sym of ["RDBEAR", "RDBULL"]) {
    for (const gr of [60, 300, 900]) {
      process.stdout.write(`Fetch ${sym} ${gr/60}m... `);
      const need = Math.ceil(NEED_DAYS * 86400 / gr) + 50;
      const candles = await fetchPaged(c, sym, gr, need, TODAY);
      dataCache.set(gridKey(sym, gr), candles);
      console.log(`${candles.length} bars from ${new Date(candles[0]?.epoch * 1000 ?? 0).toISOString().slice(0,10)}`);
    }
  }
  c.close();

  const variants: Variant[] = [
    { label: "5m fade lb=15 k=2.5 m=0.7 (validated baseline)", gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.7, fade: true },
    { label: "1m fade lb=15 k=2.5 m=0.7 (faster timeframe)",   gr: 60,  lookback: 15, kAtr: 2.5, momRatio: 0.7, fade: true },
    { label: "15m fade lb=15 k=2.5 m=0.7 (slower)",            gr: 900, lookback: 15, kAtr: 2.5, momRatio: 0.7, fade: true },
    { label: "5m fade lb=30 k=2.5 m=0.7 (longer lookback)",    gr: 300, lookback: 30, kAtr: 2.5, momRatio: 0.7, fade: true },
    { label: "5m fade lb=8  k=2.5 m=0.7 (shorter lookback)",   gr: 300, lookback: 8,  kAtr: 2.5, momRatio: 0.7, fade: true },
    { label: "5m fade lb=15 k=1.5 m=0.7 (tighter stops)",      gr: 300, lookback: 15, kAtr: 1.5, momRatio: 0.7, fade: true },
    { label: "5m fade lb=15 k=4.0 m=0.7 (wider stops)",        gr: 300, lookback: 15, kAtr: 4.0, momRatio: 0.7, fade: true },
    { label: "5m RIDE lb=15 k=2.5 m=0.7 (drift-follow)",       gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.7, fade: false },
  ];

  const symSide: Array<[string, "BUY" | "SELL"]> = [["RDBEAR", "SELL"], ["RDBULL", "BUY"]];

  for (const [sym, side] of symSide) {
    console.log(`\n${"".padEnd(110, "═")}`);
    console.log(`${sym} ${side}`);
    console.log(`${"".padEnd(110, "═")}`);
    console.log(`  variant                                                trades   WR    net      epd       per-month notes`);
    for (const v of variants) {
      const candles = dataCache.get(gridKey(sym, v.gr))!;
      // Total
      const r = sim(candles, side, v, candles[0].epoch, TODAY);
      const wr = r.trades > 0 ? r.wins / r.trades : 0;
      const epd = r.trades > 0 ? r.net / r.trades : 0;
      // Per-month positivity check
      const startD = new Date(candles[0].epoch * 1000);
      let y = startD.getUTCFullYear(), m = startD.getUTCMonth();
      let posMonths = 0, totalMonths = 0;
      while (true) {
        const start = Math.floor(Date.UTC(y, m, 1) / 1000);
        const nextM = m === 11 ? 0 : m + 1; const nextY = m === 11 ? y + 1 : y;
        const end = Math.floor(Date.UTC(nextY, nextM, 1) / 1000);
        if (start >= TODAY) break;
        const mr = sim(candles, side, v, start, Math.min(end, TODAY));
        if (mr.trades >= 5) { totalMonths++; if (mr.net > 0) posMonths++; }
        if (m === 11) { y++; m = 0; } else m++;
      }
      const flag = r.net > 0 && wr >= 0.50 && posMonths === totalMonths ? " ★" : r.net > 0 ? " ✓" : "";
      console.log(`  ${v.label.padEnd(54)}  ${String(r.trades).padStart(5)}t   ${(wr*100).toFixed(0).padStart(2)}%   ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(0).padStart(5)}   ${epd >= 0 ? "+" : ""}$${epd.toFixed(2)}    ${posMonths}/${totalMonths} mo+${flag}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Extended cousin screener — try multiple detector strategies on each candidate
// asset. If the validated R-stack (fade + drift) doesn't work, fall back to
// spike-fade or RSI mean-reversion. Goal: find any deploy-grade edge per asset.
//
// Universe: 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, 1HZ150V, 1HZ200V, 1HZ250V,
//           stpRNG, DSI10, DSI20, DSI30
// Detectors: 5m fade BUY/SELL, 5m drift BUY/SELL, 1m spike-fade BUY/SELL,
//            5m RSI extreme BUY/SELL

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;

const TODAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);
const NEED_DAYS = 200;

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

function rsi(c: Candle[], i: number, p = 14): number {
  if (i < p) return 50;
  let gain = 0, loss = 0;
  for (let j = i - p + 1; j <= i; j++) { const d = c[j].close - c[j-1].close; if (d > 0) gain += d; else loss -= d; }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

type Variant = { id: string; gr: number; type: "fade" | "drift" | "spike" | "rsi"; side: "BUY" | "SELL" };

function sim(candles: Candle[], v: Variant, from: number, to: number) {
  let trades = 0, wins = 0, net = 0;
  const LB = 15, MR = 0.7;
  for (let i = LB + 14 + 1; i < candles.length; i++) {
    if (candles[i].epoch < from || candles[i].epoch >= to) continue;
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let entry = 0, stop = 0, target = 0; let qual = false;
    if (v.type === "fade" || v.type === "drift") {
      let hi = -Infinity, lo = Infinity;
      for (let m = i - LB; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
      const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
      const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
      const dist = 2.5 * a;
      if (v.type === "fade") {
        if (v.side === "SELL" && cur.close > hi && cpu >= MR) { entry = cur.close; stop = entry + dist; target = entry - dist; qual = true; }
        else if (v.side === "BUY" && cur.close < lo && cpd >= MR) { entry = cur.close; stop = entry - dist; target = entry + dist; qual = true; }
      } else {
        if (v.side === "BUY" && cur.close > hi && cpu >= MR) { entry = cur.close; stop = entry - dist; target = entry + dist; qual = true; }
        else if (v.side === "SELL" && cur.close < lo && cpd >= MR) { entry = cur.close; stop = entry + dist; target = entry - dist; qual = true; }
      }
    } else if (v.type === "spike") {
      const aPrev = atr(candles, i - 1, 14); if (aPrev <= 0) continue;
      const spk = candles[i - 1]; const range = spk.high - spk.low;
      if (range < 3.0 * aPrev) continue;
      const conf = candles[i];
      if (v.side === "SELL") {
        if (!(spk.close > spk.open)) continue;
        if (!(conf.close < spk.close)) continue;
        entry = conf.close; stop = spk.high + 0.05 * aPrev; target = entry - 0.7 * range;
        if (target <= 0 || stop <= entry) continue;
        qual = true;
      } else {
        if (!(spk.close < spk.open)) continue;
        if (!(conf.close > spk.close)) continue;
        entry = conf.close; stop = spk.low - 0.05 * aPrev; target = entry + 0.7 * range;
        if (target <= 0 || stop >= entry) continue;
        qual = true;
      }
    } else if (v.type === "rsi") {
      const r = rsi(candles, i, 14);
      const cur = candles[i];
      const dist = 1.5 * a;
      if (v.side === "SELL" && r > 75) { entry = cur.close; stop = entry + 0.5 * a; target = entry - 1.0 * a; qual = true; }
      else if (v.side === "BUY" && r < 25) { entry = cur.close; stop = entry - 0.5 * a; target = entry + 1.0 * a; qual = true; }
    }
    if (!qual || target <= 0) continue;

    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = v.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - entry;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null; let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (v.side === "BUY") {
        if (b.low <= stopAdj) { exit = "SL"; exitPrice = stopAdj - stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      } else {
        if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      }
    }
    if (!exit) continue;
    const move = v.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    if (exit === "TP") wins++; trades++; net += pnl;
  }
  return { trades, wins, net, wr: trades > 0 ? wins / trades : 0, epd: trades > 0 ? net / trades : 0 };
}

// Untested cousins (available per active_symbols call):
//   1HZ Volatility family (high-freq 1s tick)
//   Step Index family (engineered "stepping" RNG)
//   BOOM/CRASH 50, 150N, 1000 (extra spike cadences not yet tested)
const ASSETS = [
  "1HZ10V", "1HZ15V", "1HZ25V", "1HZ30V", "1HZ50V", "1HZ75V", "1HZ90V", "1HZ100V",
  "stpRNG", "stpRNG2", "stpRNG3", "stpRNG4", "stpRNG5",
  "BOOM50", "BOOM150N", "BOOM1000",
  "CRASH50", "CRASH150N", "CRASH1000",
];

const VARIANTS: Variant[] = [
  { id: "fade5m_BUY",  gr: 300, type: "fade",  side: "BUY"  },
  { id: "fade5m_SELL", gr: 300, type: "fade",  side: "SELL" },
  { id: "drift5m_BUY", gr: 300, type: "drift", side: "BUY"  },
  { id: "drift5m_SELL",gr: 300, type: "drift", side: "SELL" },
  { id: "spike1m_BUY", gr: 60,  type: "spike", side: "BUY"  },
  { id: "spike1m_SELL",gr: 60,  type: "spike", side: "SELL" },
  { id: "rsi5m_BUY",   gr: 300, type: "rsi",   side: "BUY"  },
  { id: "rsi5m_SELL",  gr: 300, type: "rsi",   side: "SELL" },
];

async function main() {
  console.log(`Cousin asset extended strategy search — ${NEED_DAYS} days\n`);
  const c = new C(); await c.ready;

  // Pre-fetch unique (asset, gr) combos
  const dataCache = new Map<string, Candle[]>();
  for (const sym of ASSETS) {
    for (const gr of [60, 300]) {
      const key = `${sym}|${gr}`;
      const need = Math.ceil(NEED_DAYS * 86400 / gr) + 100;
      process.stdout.write(`Fetching ${sym}@${gr}s... `);
      const candles = await fetchPaged(c, sym, gr, need, TODAY);
      if (candles.length < 50) {
        console.log(`only ${candles.length} bars — skip`);
      } else {
        const startD = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
        console.log(`${candles.length} bars from ${startD}`);
      }
      dataCache.set(key, candles);
    }
  }
  c.close();
  console.log();

  type Result = { sym: string; vid: string; trades: number; wr: number; net: number; epd: number; posMonths: number; totalMonths: number };
  const allResults: Result[] = [];

  for (const sym of ASSETS) {
    for (const v of VARIANTS) {
      const candles = dataCache.get(`${sym}|${v.gr}`)!;
      if (!candles || candles.length < 50) continue;
      const start = candles[0].epoch;
      const tot = sim(candles, v, start, TODAY);
      // Per-month
      const startD = new Date(start * 1000);
      let y = startD.getUTCFullYear(), m = startD.getUTCMonth();
      let posMonths = 0, totalMonths = 0;
      while (true) {
        const mStart = Math.floor(Date.UTC(y, m, 1) / 1000);
        const nextM = m === 11 ? 0 : m + 1; const nextY = m === 11 ? y + 1 : y;
        const mEnd = Math.floor(Date.UTC(nextY, nextM, 1) / 1000);
        if (mStart >= TODAY) break;
        const mr = sim(candles, v, mStart, Math.min(mEnd, TODAY));
        if (mr.trades >= 5) { totalMonths++; if (mr.net > 0) posMonths++; }
        if (m === 11) { y++; m = 0; } else m++;
      }
      allResults.push({ sym, vid: v.id, trades: tot.trades, wr: tot.wr, net: tot.net, epd: tot.epd, posMonths, totalMonths });
    }
  }

  // Per-asset: show best variant + ★ if deploy-grade
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`PER-ASSET BEST VARIANT (sorted by net $, ★=net>0 + 50%+ WR + every-month positive)`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  asset       best variant        trades   WR    net       epd       months+/total`);
  for (const sym of ASSETS) {
    const arr = allResults.filter((r) => r.sym === sym).sort((a, b) => b.net - a.net);
    if (arr.length === 0) { console.log(`  ${sym.padEnd(10)}  no data`); continue; }
    const top = arr[0];
    const flag = top.net > 0 && top.wr >= 0.50 && top.posMonths === top.totalMonths && top.totalMonths > 0 ? " ★" : top.net > 0 ? " ✓" : " 🔴";
    console.log(`  ${sym.padEnd(10)}  ${top.vid.padEnd(18)}  ${String(top.trades).padStart(5)}t   ${(top.wr*100).toFixed(0).padStart(2)}%   ${top.net >= 0 ? "+" : ""}$${top.net.toFixed(0).padStart(5)}    ${top.epd >= 0 ? "+" : ""}$${top.epd.toFixed(2)}    ${top.posMonths}/${top.totalMonths}${flag}`);
    // Show all variants for this asset
    for (const r of arr.slice(1)) {
      console.log(`              ${r.vid.padEnd(18)}  ${String(r.trades).padStart(5)}t   ${(r.wr*100).toFixed(0).padStart(2)}%   ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(0).padStart(5)}    ${r.epd >= 0 ? "+" : ""}$${r.epd.toFixed(2)}    ${r.posMonths}/${r.totalMonths}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// ETH OB winner — structural feature deep-dive.
// Run the saved config on the 333-day window, capture per-trade features at
// signal time, compare winners vs losers, identify the strongest discriminators
// to use as additional filters.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestAtr, latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig, BacktestTrade } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryETHUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res, rej) => { this.ws.on("open", () => res()); this.ws.on("error", rej); });
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { this.ws.close(); }
}
async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: string = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of collected) if (!seen.has(c.epoch)) { seen.add(c.epoch); out.push(c); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m-1] + s[m]) / 2;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a,b)=>a+b,0) / xs.length : 0; }

type Feature = {
  side: "BUY" | "SELL";
  pnlR: number;
  isWin: boolean;
  exitReason: string;
  // Volatility
  atr: number;
  atrPctOfPrice: number;
  // Trend
  adx: number;
  trending: number;
  // Stop/risk geometry
  stopDistAtr: number;        // |entry - stop| / atr
  stopDistPct: number;        // |entry - stop| / entry as %
  // Time
  hourUtc: number;
  dayOfWeek: number;          // 0=Sun, 6=Sat
  // Excursion (post-entry, in R units)
  mfeR: number;               // max favorable excursion within trade window
  maeR: number;               // max adverse excursion (absolute)
  barsInTrade: number;
};

async function main() {
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();

  // Run the saved config (with-trend@20 · edge · 6:1)
  const obParams: Record<string, number> = {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 6.0,
  };
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? obParams : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 6.0, costBps: COST_BPS,
    withTrendOnlyAboveAdx: 20,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  const trades = r.trades;
  console.log(`[eth-ob-features] ${trades.length} trades over ${candles.length} bars (~333d)\n`);

  // Build feature rows
  const rows: Feature[] = [];
  for (const t of trades) {
    const i = t.openedAtIndex;
    const window = candles.slice(0, i + 1);
    const atr = latestAtr(window, 14);
    if (atr <= 0) continue;
    const reg = latestRegime(window, 22, 14);
    const entry = t.entryPrice;
    const stopDist = Math.abs(entry - t.stopPrice);
    const stopDistAtr = stopDist / atr;
    const stopDistPct = (stopDist / entry) * 100;

    // MFE/MAE during trade window
    let mfe = -Infinity, mae = Infinity;
    for (let j = i + 1; j <= t.closedAtIndex; j++) {
      const b = candles[j];
      if (t.side === "BUY") {
        mfe = Math.max(mfe, b.high - entry);
        mae = Math.min(mae, b.low - entry);
      } else {
        mfe = Math.max(mfe, entry - b.low);
        mae = Math.min(mae, entry - b.high);
      }
    }
    if (!isFinite(mfe)) mfe = 0;
    if (!isFinite(mae)) mae = 0;
    const mfeR = stopDist > 0 ? mfe / stopDist : 0;
    const maeR = stopDist > 0 ? mae / stopDist : 0;

    const risk = stopDist / entry;
    const pnlR = risk > 0 ? t.pnlPct / risk : 0;
    const d = new Date(candles[i].epoch * 1000);

    rows.push({
      side: t.side, pnlR, isWin: t.pnlPct > 0, exitReason: t.exitReason,
      atr, atrPctOfPrice: (atr / entry) * 100,
      adx: reg.adx, trending: reg.trending ? 1 : 0,
      stopDistAtr, stopDistPct,
      hourUtc: d.getUTCHours(), dayOfWeek: d.getUTCDay(),
      mfeR, maeR, barsInTrade: t.closedAtIndex - i,
    });
  }

  const winners = rows.filter((x) => x.isWin);
  const losers = rows.filter((x) => !x.isWin);
  console.log(`Winners: ${winners.length}, Losers: ${losers.length}\n`);

  // Feature comparison table
  console.log(`══ Feature distribution: winners vs losers (median / mean) ══`);
  const features: Array<keyof Feature> = ["adx", "atrPctOfPrice", "stopDistAtr", "stopDistPct", "mfeR", "maeR", "barsInTrade"];
  console.log(`  ${"feature".padEnd(20)}  ${"win med".padStart(8)} ${"win mean".padStart(9)}  ${"los med".padStart(8)} ${"los mean".padStart(9)}  ${"med ratio".padStart(10)}  signal?`);
  for (const f of features) {
    const w = winners.map((r) => r[f] as number);
    const l = losers.map((r) => r[f] as number);
    const wm = median(w), lm = median(l);
    const wmean = mean(w), lmean = mean(l);
    const ratio = lm !== 0 ? wm / lm : 0;
    const signal = Math.abs(ratio - 1) >= 0.20 ? "★" : Math.abs(ratio - 1) >= 0.10 ? " ·" : "";
    console.log(`  ${String(f).padEnd(20)}  ${wm.toFixed(2).padStart(8)} ${wmean.toFixed(2).padStart(9)}  ${lm.toFixed(2).padStart(8)} ${lmean.toFixed(2).padStart(9)}  ${ratio.toFixed(2).padStart(10)}  ${signal}`);
  }

  // Hour-of-day analysis
  console.log(`\n══ Hour-of-day winrate (UTC) ══`);
  const byHour: Record<number, { w: number; l: number; pnl: number }> = {};
  for (const x of rows) {
    byHour[x.hourUtc] ??= { w: 0, l: 0, pnl: 0 };
    if (x.isWin) byHour[x.hourUtc].w++; else byHour[x.hourUtc].l++;
    byHour[x.hourUtc].pnl += STAKE * Math.max(-1, (x.pnlR * x.stopDistPct / 100) * MULT);
  }
  for (let h = 0; h < 24; h++) {
    const b = byHour[h];
    if (!b || (b.w + b.l) < 3) continue;
    const total = b.w + b.l;
    const wr = (100 * b.w / total).toFixed(0);
    const bar = Math.min(40, Math.max(0, b.w * 4));
    console.log(`  ${h.toString().padStart(2, "0")}:00  n=${String(total).padStart(2)}  WR=${wr.padStart(2)}%  ${"█".repeat(bar)}`);
  }

  // Day-of-week analysis
  console.log(`\n══ Day-of-week winrate (UTC) ══`);
  const byDow: Record<number, { w: number; l: number }> = {};
  for (const x of rows) {
    byDow[x.dayOfWeek] ??= { w: 0, l: 0 };
    if (x.isWin) byDow[x.dayOfWeek].w++; else byDow[x.dayOfWeek].l++;
  }
  const dnames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const b = byDow[d];
    if (!b) continue;
    const total = b.w + b.l;
    const wr = (100 * b.w / total).toFixed(0);
    console.log(`  ${dnames[d]}  n=${String(total).padStart(3)}  WR=${wr.padStart(2)}%`);
  }

  // ADX strength buckets
  console.log(`\n══ ADX strength bucket analysis ══`);
  const adxBuckets = [
    { name: "20-25", lo: 20, hi: 25 },
    { name: "25-30", lo: 25, hi: 30 },
    { name: "30-35", lo: 30, hi: 35 },
    { name: "35-40", lo: 35, hi: 40 },
    { name: "40+",   lo: 40, hi: 999 },
  ];
  for (const ab of adxBuckets) {
    const inBucket = rows.filter((r) => r.adx >= ab.lo && r.adx < ab.hi);
    if (inBucket.length === 0) continue;
    const w = inBucket.filter((r) => r.isWin).length;
    const wr = (100 * w / inBucket.length).toFixed(0);
    const expR = mean(inBucket.map((r) => r.pnlR));
    console.log(`  ADX ${ab.name.padEnd(6)}  n=${String(inBucket.length).padStart(3)}  WR=${wr.padStart(2)}%  expR=${expR >= 0 ? "+" : ""}${expR.toFixed(2)}R`);
  }

  // Exit-reason breakdown
  console.log(`\n══ Exit reason breakdown ══`);
  const byReason: Record<string, { count: number; totalR: number }> = {};
  for (const x of rows) {
    const k = x.exitReason;
    byReason[k] = byReason[k] ?? { count: 0, totalR: 0 };
    byReason[k].count++;
    byReason[k].totalR += x.pnlR;
  }
  for (const [k, v] of Object.entries(byReason)) {
    console.log(`  ${k.padEnd(18)}  n=${String(v.count).padStart(3)}  avg R=${v.totalR / v.count >= 0 ? "+" : ""}${(v.totalR / v.count).toFixed(2)}R`);
  }

  // Side bias
  console.log(`\n══ BUY vs SELL ══`);
  const buys = rows.filter((r) => r.side === "BUY");
  const sells = rows.filter((r) => r.side === "SELL");
  console.log(`  BUY:   n=${buys.length}  WR=${(100*buys.filter((r)=>r.isWin).length/buys.length).toFixed(0)}%  expR=${mean(buys.map((r)=>r.pnlR)).toFixed(2)}R`);
  console.log(`  SELL:  n=${sells.length}  WR=${(100*sells.filter((r)=>r.isWin).length/sells.length).toFixed(0)}%  expR=${mean(sells.map((r)=>r.pnlR)).toFixed(2)}R`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Silver OB feature analysis — structural breakdown of winners vs losers.
// Identical methodology to ETH OB feature analysis. NO permanent changes
// to silver-ob.ts; this is exploration-only.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestAtr, latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = silverOb.symbols[0];
const STAKE = silverOb.validation.stake;
const MULT = silverOb.validation.multiplier;
const COST_BPS = silverOb.costBps;

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

async function main() {
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYMBOL, silverOb.granularity, 9500);
  c.close();

  const r = await runBacktest({
    symbol: SYMBOL, granularity: silverOb.granularity as any, count: candles.length,
    atrSlMult: silverOb.atrSlMult, atrTpMult: silverOb.atrTpMult, costBps: silverOb.costBps,
    maxAdx: silverOb.maxAdx,
    detectors: silverOb.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  const trades = r.trades;
  console.log(`[silver-ob-features] Silver OB · ${trades.length} trades over ${candles.length} 15m bars (~${Math.round((candles[candles.length-1].epoch - candles[0].epoch)/86400)}d)\n`);

  type F = {
    side: "BUY" | "SELL"; pnlR: number; isWin: boolean; exitReason: string;
    atr: number; atrPctOfPrice: number; adx: number; trending: number;
    stopDistAtr: number; stopDistPct: number;
    hourUtc: number; dayOfWeek: number;
    mfeR: number; maeR: number; barsInTrade: number;
  };
  const rows: F[] = [];
  for (const t of trades) {
    const i = t.openedAtIndex;
    const window = candles.slice(0, i + 1);
    const atr = latestAtr(window, 14);
    if (atr <= 0) continue;
    const reg = latestRegime(window, 22, 14);
    const entry = t.entryPrice;
    const stopDist = Math.abs(entry - t.stopPrice);
    let mfe = -Infinity, mae = Infinity;
    for (let j = i + 1; j <= t.closedAtIndex; j++) {
      const b = candles[j];
      if (t.side === "BUY") { mfe = Math.max(mfe, b.high - entry); mae = Math.min(mae, b.low - entry); }
      else { mfe = Math.max(mfe, entry - b.low); mae = Math.min(mae, entry - b.high); }
    }
    if (!isFinite(mfe)) mfe = 0;
    if (!isFinite(mae)) mae = 0;
    const risk = stopDist / entry;
    const pnlR = risk > 0 ? t.pnlPct / risk : 0;
    const d = new Date(candles[i].epoch * 1000);
    rows.push({
      side: t.side, pnlR, isWin: t.pnlPct > 0, exitReason: t.exitReason,
      atr, atrPctOfPrice: (atr / entry) * 100, adx: reg.adx, trending: reg.trending ? 1 : 0,
      stopDistAtr: stopDist / atr, stopDistPct: (stopDist / entry) * 100,
      hourUtc: d.getUTCHours(), dayOfWeek: d.getUTCDay(),
      mfeR: stopDist > 0 ? mfe / stopDist : 0,
      maeR: stopDist > 0 ? mae / stopDist : 0,
      barsInTrade: t.closedAtIndex - i,
    });
  }
  const winners = rows.filter((x) => x.isWin);
  const losers = rows.filter((x) => !x.isWin);
  console.log(`Winners: ${winners.length}, Losers: ${losers.length}\n`);

  console.log(`══ Feature distribution: winners vs losers (median) ══`);
  const features: Array<keyof F> = ["adx", "atrPctOfPrice", "stopDistAtr", "stopDistPct", "mfeR", "maeR", "barsInTrade"];
  console.log(`  ${"feature".padEnd(20)}  ${"win med".padStart(8)}  ${"los med".padStart(8)}  ${"ratio".padStart(8)}  signal?`);
  for (const f of features) {
    const w = winners.map((r) => r[f] as number);
    const l = losers.map((r) => r[f] as number);
    const wm = median(w), lm = median(l);
    const ratio = lm !== 0 ? wm / lm : 0;
    const signal = Math.abs(ratio - 1) >= 0.20 ? "★" : Math.abs(ratio - 1) >= 0.10 ? " ·" : "";
    console.log(`  ${String(f).padEnd(20)}  ${wm.toFixed(2).padStart(8)}  ${lm.toFixed(2).padStart(8)}  ${ratio.toFixed(2).padStart(8)}  ${signal}`);
  }

  console.log(`\n══ Hour-of-day winrate (UTC) ══`);
  const byHour: Record<number, { w: number; l: number }> = {};
  for (const x of rows) {
    byHour[x.hourUtc] ??= { w: 0, l: 0 };
    if (x.isWin) byHour[x.hourUtc].w++; else byHour[x.hourUtc].l++;
  }
  for (let h = 0; h < 24; h++) {
    const b = byHour[h];
    if (!b || (b.w + b.l) < 2) continue;
    const total = b.w + b.l;
    const wr = (100 * b.w / total).toFixed(0);
    console.log(`  ${h.toString().padStart(2, "0")}:00  n=${String(total).padStart(2)}  WR=${wr.padStart(2)}%`);
  }

  console.log(`\n══ Day-of-week winrate (UTC) ══`);
  const byDow: Record<number, { w: number; l: number }> = {};
  for (const x of rows) { byDow[x.dayOfWeek] ??= { w: 0, l: 0 }; if (x.isWin) byDow[x.dayOfWeek].w++; else byDow[x.dayOfWeek].l++; }
  const dnames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let d = 0; d < 7; d++) {
    const b = byDow[d]; if (!b) continue;
    const total = b.w + b.l;
    console.log(`  ${dnames[d]}  n=${String(total).padStart(3)}  WR=${(100*b.w/total).toFixed(0).padStart(2)}%`);
  }

  console.log(`\n══ ADX strength bucket ══`);
  const adxBuckets = [
    { name: "0-10",  lo: 0, hi: 10 },
    { name: "10-15", lo: 10, hi: 15 },
    { name: "15-18", lo: 15, hi: 18 },
    { name: "18-20", lo: 18, hi: 20 },
    { name: "20-22", lo: 20, hi: 22 },
  ];
  for (const ab of adxBuckets) {
    const inB = rows.filter((r) => r.adx >= ab.lo && r.adx < ab.hi);
    if (inB.length === 0) continue;
    const w = inB.filter((r) => r.isWin).length;
    const expR = mean(inB.map((r) => r.pnlR));
    console.log(`  ADX ${ab.name.padEnd(6)}  n=${String(inB.length).padStart(3)}  WR=${(100*w/inB.length).toFixed(0).padStart(2)}%  expR=${expR >= 0 ? "+" : ""}${expR.toFixed(2)}R`);
  }

  console.log(`\n══ Side ══`);
  const buys = rows.filter((r) => r.side === "BUY");
  const sells = rows.filter((r) => r.side === "SELL");
  console.log(`  BUY:   n=${buys.length}  WR=${(100*buys.filter((r)=>r.isWin).length/Math.max(1,buys.length)).toFixed(0)}%  expR=${mean(buys.map((r)=>r.pnlR)).toFixed(2)}R`);
  console.log(`  SELL:  n=${sells.length}  WR=${(100*sells.filter((r)=>r.isWin).length/Math.max(1,sells.length)).toFixed(0)}%  expR=${mean(sells.map((r)=>r.pnlR)).toFixed(2)}R`);

  console.log(`\n══ Exit reason ══`);
  const byReason: Record<string, { count: number; totalR: number }> = {};
  for (const x of rows) {
    byReason[x.exitReason] ??= { count: 0, totalR: 0 };
    byReason[x.exitReason].count++;
    byReason[x.exitReason].totalR += x.pnlR;
  }
  for (const [k, v] of Object.entries(byReason)) {
    console.log(`  ${k.padEnd(18)}  n=${String(v.count).padStart(3)}  avg R=${v.totalR/v.count >= 0 ? "+" : ""}${(v.totalR/v.count).toFixed(2)}R`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

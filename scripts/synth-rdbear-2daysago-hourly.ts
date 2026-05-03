// RDBEAR breakout-continuation 5m — variants 1/2/7 per-hour for 2 days ago.
//
// Tests three configs that passed yesterday's edge hunt, broken out hour by
// hour for 2026-04-29 (UTC). Goal: see if the edge is concentrated in
// particular hours or distributed throughout the day, and whether the
// "higher kAtr 2.5" variant's outperformance was a fluke.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COST_BPS = 5.0;

const SYM = "RDBEAR";
const GR = 300; // 5m

// 2 days ago in UTC
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const TARGET_START = TODAY_START - 2 * 86400; // 2026-04-29 00:00 UTC
const TARGET_END = TARGET_START + 86400;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline (kAtr=2.0 momR=0.70)",  lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "#2 tighter momR=0.75",              lookback: 15, kAtr: 2.0, momRatio: 0.75 },
  { name: "#7 higher kAtr=2.5",                lookback: 15, kAtr: 2.5, momRatio: 0.70 },
];

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message));
          else resolve(m);
        }
      } catch { /* ignore */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout req_id=${id}`)); }
      }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = end;
  while (candles.length < count) {
    const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch);
    cursor = ch[0].epoch - 1;
    if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

type HourBucket = { hour: number; trades: number; wins: number; losses: number; totalUsd: number; sumR: number };

async function evalVariant(v: Variant, allCandles: Candle[]): Promise<HourBucket[]> {
  const detectors = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation"
      ? { lookback: v.lookback, atrPeriod: 14, kAtr: v.kAtr, momRatio: v.momRatio, sideFilter: -1 }
      : d.params,
  }));
  const r = await runBacktest({
    symbol: SYM as any, granularity: GR as any, count: allCandles.length,
    atrSlMult: 1.0, atrTpMult: 1.0, costBps: COST_BPS, detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, allCandles);
  const hours: HourBucket[] = [];
  for (let h = 0; h < 24; h++) hours.push({ hour: h, trades: 0, wins: 0, losses: 0, totalUsd: 0, sumR: 0 });
  for (const t of r.trades) {
    const epoch = allCandles[t.openedAtIndex].epoch;
    if (epoch < TARGET_START || epoch >= TARGET_END) continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    const bucket = hours[hour];
    bucket.trades++;
    bucket.totalUsd += pnlUsd;
    bucket.sumR += pnlUsd / STAKE;
    if (pnlUsd > 0) bucket.wins++; else if (pnlUsd < 0) bucket.losses++;
  }
  return hours;
}

async function main() {
  const targetDate = new Date(TARGET_START * 1000).toISOString().slice(0, 10);
  console.log(`RDBEAR breakout 5m — per-hour test for 2 days ago (${targetDate} UTC)`);
  console.log(`Variants: #1 baseline · #2 tighter momR · #7 higher kAtr`);
  console.log(`Stake $${STAKE}  ·  MULT ${MULT}×\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, TARGET_END);
  c.close();
  console.log(`Fetched ${candles.length} bars (${((candles[candles.length - 1].epoch - candles[0].epoch) / 86400).toFixed(1)}d, warmup ends at ${new Date(TARGET_START * 1000).toISOString().slice(0, 13)}Z)\n`);

  const results: Array<{ v: Variant; hours: HourBucket[] }> = [];
  for (const v of VARIANTS) {
    const hours = await evalVariant(v, candles);
    results.push({ v, hours });
  }

  // Per-hour table for each variant.
  for (const { v, hours } of results) {
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`${v.name}  ·  lb=${v.lookback} kAtr=${v.kAtr} momR=${v.momRatio} SELL-only`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  hour    trades  W/L      WR      total $    expR`);
    let dayTrades = 0, dayWins = 0, dayLosses = 0, dayTotal = 0, daySumR = 0;
    for (const h of hours) {
      if (h.trades === 0) continue;
      const wr = h.trades > 0 ? h.wins / h.trades : 0;
      const expR = h.trades > 0 ? h.sumR / h.trades : 0;
      console.log(`  ${String(h.hour).padStart(2)}:00     ${String(h.trades).padStart(2)}t   ${h.wins}W/${h.losses}L  ${(wr * 100).toFixed(0).padStart(3)}%  ${h.totalUsd >= 0 ? "+" : ""}$${h.totalUsd.toFixed(2).padStart(8)}  ${expR.toFixed(2).padStart(5)}`);
      dayTrades += h.trades; dayWins += h.wins; dayLosses += h.losses; dayTotal += h.totalUsd; daySumR += h.sumR;
    }
    const dayWR = dayTrades > 0 ? dayWins / dayTrades : 0;
    const dayExpR = dayTrades > 0 ? daySumR / dayTrades : 0;
    console.log(`  ─────────────────────────────────────────────────────────`);
    console.log(`  TOTAL     ${String(dayTrades).padStart(2)}t   ${dayWins}W/${dayLosses}L  ${(dayWR * 100).toFixed(0).padStart(3)}%  ${dayTotal >= 0 ? "+" : ""}$${dayTotal.toFixed(2).padStart(8)}  ${dayExpR.toFixed(2).padStart(5)}`);
    console.log("");
  }

  // Cross-variant per-hour comparison: where do they agree, where diverge?
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`SIDE-BY-SIDE per-hour (only hours where ANY variant fired)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  hour    #1 baseline       #2 tighter momR    #7 higher kAtr`);
  for (let h = 0; h < 24; h++) {
    const r1 = results[0].hours[h]; const r2 = results[1].hours[h]; const r7 = results[2].hours[h];
    if (r1.trades === 0 && r2.trades === 0 && r7.trades === 0) continue;
    const fmt = (x: HourBucket) => x.trades === 0 ? "  -                " : `${String(x.trades).padStart(2)}t ${x.wins}W/${x.losses}L ${(x.totalUsd >= 0 ? "+" : "") + "$" + x.totalUsd.toFixed(0).padStart(4)}`;
    console.log(`  ${String(h).padStart(2)}:00   ${fmt(r1).padEnd(18)}  ${fmt(r2).padEnd(18)}  ${fmt(r7)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

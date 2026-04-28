// Platinum Sweep deep-dive with TRAIN/TEST split + warmup.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXPTUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const MIN_TRADES = 30;
const MIN_PNL_USD = 200;

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

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 1, // ICT default; we'll override
    stopBufferAtrMul: 0.1,
    ...over,
  };
}

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number; skipDaysOfWeekUtc: number[]; buyOnly: boolean; sellOnly: boolean }>;
};

const variants: Variant[] = [
  // Phase A: entry style + R:R baseline
  { name: "ICT 3:1",                                      params: basePs(),                                              filters: {} },
  { name: "confirm 3:1",                                  params: basePs({ entryOnSweep: 0 }),                           filters: {} },
  { name: "ICT 4:1",                                      params: basePs({ targetRMult: 4.0 }),                          filters: {} },
  { name: "confirm 4:1",                                  params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: {} },
  { name: "confirm 5:1",                                  params: basePs({ entryOnSweep: 0, targetRMult: 5.0 }),         filters: {} },
  // Phase B: SELL-only (LTC bear bias from OB)
  { name: "ICT 3:1 + SELL",                               params: basePs(),                                              filters: { sellOnly: true } },
  { name: "confirm 3:1 + SELL",                           params: basePs({ entryOnSweep: 0 }),                           filters: { sellOnly: true } },
  { name: "confirm 4:1 + SELL",                           params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: { sellOnly: true } },
  { name: "confirm 5:1 + SELL",                           params: basePs({ entryOnSweep: 0, targetRMult: 5.0 }),         filters: { sellOnly: true } },
  // BUY control
  { name: "confirm 3:1 + BUY (control)",                  params: basePs({ entryOnSweep: 0 }),                           filters: { buyOnly: true } },
  // Phase C: with-trend filter
  { name: "ICT 3:1 + withTrend@20",                       params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20",                   params: basePs({ entryOnSweep: 0 }),                           filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 4:1 + withTrend@20",                   params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 5:1 + withTrend@20",                   params: basePs({ entryOnSweep: 0, targetRMult: 5.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 4:1 + withTrend@20 + SELL",            params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: { withTrendOnlyAboveAdx: 20, sellOnly: true } },
  // Phase D: ADX gates
  { name: "confirm 4:1 + maxAdx=22",                      params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: { maxAdx: 22 } },
  { name: "confirm 4:1 + minAdx=22",                      params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),         filters: { minAdx: 22 } },
  // Phase E: smaller swing window (Gold lesson)
  { name: "confirm 4:1 + swing1",                         params: basePs({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1 }), filters: {} },
  { name: "confirm 4:1 + swing1 + SELL",                  params: basePs({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1 }), filters: { sellOnly: true } },
];

const TRAIN_START = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const TRAIN_END   = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_START  = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_END    = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

async function runWindowed(v: any, allCandles: Candle[], windowStart: number, windowEnd: number) {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? v.params : d.params,
  }));
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const r = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  const inWin = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  return { trades: inWin.length, wins, expR, pnlUsd };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[plat-sweep] Symbol: Platinum/USD (frxXPTUSD) · cost ${COST_BPS} bps · 1h TF`);
  console.log(`TRAIN: 2026-01-01 → 2026-03-31 · TEST: 2026-04-01 → 2026-04-27\n`);
  const candles = await fetchPaged(c, SYMBOL, 3600, 5500);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars`); return; }
  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`Fetched ${candles.length} 1h bars (${fromDate} → ${toDate}, ~${Math.round(candles.length/24)}d)`);
  const trainWarmup = candles.filter((cn) => cn.epoch < TRAIN_START).length;
  const testWarmup  = candles.filter((cn) => cn.epoch < TEST_START).length;
  console.log(`TRAIN warmup: ${trainWarmup} bars (~${Math.round(trainWarmup/24)}d) · TEST warmup: ${testWarmup} bars (~${Math.round(testWarmup/24)}d)\n`);

  for (const [label, ws, we] of [["TRAIN: Jan 1 → Mar 31", TRAIN_START, TRAIN_END], ["TEST: Apr 1 → Apr 27 (OOS)", TEST_START, TEST_END]] as const) {
    console.log(`══ ${label} ══`);
    console.log(`  ${"variant".padEnd(58)}  trades  WR    expR    P&L $    qualifies?`);
    const rows: any[] = [];
    for (const v of variants) {
      const r = await runWindowed(v, candles, ws, we);
      const qualifies = r.trades >= MIN_TRADES && r.pnlUsd >= MIN_PNL_USD;
      rows.push({ name: v.name, ...r, qualifies });
      const wr = r.trades ? `${(100*r.wins/r.trades).toFixed(0)}%` : "—";
      console.log(`  ${v.name.padEnd(58)}  ${String(r.trades).padStart(3)}    ${wr.padStart(3)}   ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R   ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}    ${qualifies ? "  ✓" : ""}`);
    }
    const elig = rows.filter((r) => r.trades >= MIN_TRADES).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 3);
    console.log(`  TOP 3 by $ (≥${MIN_TRADES}t):`);
    for (const r of elig) console.log(`    ${r.name.padEnd(58)} ${r.trades}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · ${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
    console.log(``);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

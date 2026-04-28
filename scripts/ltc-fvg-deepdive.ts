// LTC FVG deep-dive. SELL-only (LTC bear bias from OB) + minGap sweep.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryLTCUSD";
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
    atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12,
    targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0,
    ...over,
  };
}

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number; skipDaysOfWeekUtc: number[]; buyOnly: boolean; sellOnly: boolean }>;
};

const variants: Variant[] = [
  // Phase A: minGap sweep (no filter)
  { name: "edge · 3:1 · minGap=0.15 (default)",          params: basePs(),                                         filters: {} },
  { name: "edge · 3:1 · minGap=0.30",                    params: basePs({ minGapAtrMul: 0.30 }),                   filters: {} },
  { name: "edge · 3:1 · minGap=0.50",                    params: basePs({ minGapAtrMul: 0.50 }),                   filters: {} },
  { name: "edge · 3:1 · minGap=0.70 (Silver winner)",    params: basePs({ minGapAtrMul: 0.70 }),                   filters: {} },
  // Phase B: SELL-only test (LTC bear bias)
  { name: "edge · 3:1 + SELL-only",                      params: basePs(),                                         filters: { sellOnly: true } },
  { name: "edge · 3:1 + BUY-only (control)",             params: basePs(),                                         filters: { buyOnly: true } },
  { name: "edge · 3:1 + SELL · minGap=0.30",             params: basePs({ minGapAtrMul: 0.30 }),                   filters: { sellOnly: true } },
  { name: "edge · 3:1 + SELL · minGap=0.50",             params: basePs({ minGapAtrMul: 0.50 }),                   filters: { sellOnly: true } },
  // R:R sweep with SELL
  { name: "edge · 4:1 + SELL",                           params: basePs({ targetRMult: 4.0 }),                     filters: { sellOnly: true } },
  { name: "edge · 5:1 + SELL",                           params: basePs({ targetRMult: 5.0 }),                     filters: { sellOnly: true } },
  { name: "edge · 4.5:1 + SELL",                         params: basePs({ targetRMult: 4.5 }),                     filters: { sellOnly: true } },
  // R:R sweep no filter
  { name: "edge · 4:1",                                  params: basePs({ targetRMult: 4.0 }),                     filters: {} },
  { name: "edge · 5:1",                                  params: basePs({ targetRMult: 5.0 }),                     filters: {} },
  // Phase C: ETH-style filters
  { name: "edge · 3:1 + with-trend@20",                  params: basePs(),                                         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "edge · 4:1 + with-trend@20",                  params: basePs({ targetRMult: 4.0 }),                     filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "edge · 4:1 + SELL + with-trend@20",           params: basePs({ targetRMult: 4.0 }),                     filters: { sellOnly: true, withTrendOnlyAboveAdx: 20 } },
  // Phase D: ADX gates
  { name: "edge · 4:1 + minAdx=22",                      params: basePs({ targetRMult: 4.0 }),                     filters: { minAdx: 22 } },
  { name: "edge · 4:1 + SELL + minAdx=22",               params: basePs({ targetRMult: 4.0 }),                     filters: { sellOnly: true, minAdx: 22 } },
  { name: "edge · 4:1 + maxAdx=40",                      params: basePs({ targetRMult: 4.0 }),                     filters: { maxAdx: 40 } },
  // Phase E: entry depth
  { name: "ce · 3:1",                                    params: basePs({ entryDepth: 1 }),                        filters: {} },
  { name: "ce · 4:1 + SELL",                             params: basePs({ entryDepth: 1, targetRMult: 4.0 }),      filters: { sellOnly: true } },
];

type ResultRow = { variant: string; trades: number; wins: number; expR: number; pnlUsd: number; qualifies: boolean };

async function runVariant(v: Variant, candles: Candle[], gran: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "fvg",
    params: d.id === "fvg" ? v.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL, granularity: gran as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  const wins = r.trades.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of r.trades) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = r.trades.length ? totalR / r.trades.length : 0;
  return {
    variant: v.name, trades: r.trades.length, wins, expR, pnlUsd,
    qualifies: r.trades.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[ltc-fvg-deepdive] LTC / 1h × 8000 bars · cost ${COST_BPS} bps\n`);
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();
  console.log(`fetched ${candles.length} bars\n`);
  console.log(`  ${"variant".padEnd(54)}  trades  WR    expR    P&L $    qualifies?`);
  const all: ResultRow[] = [];
  for (const v of variants) {
    const row = await runVariant(v, candles, 3600);
    all.push(row);
    const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
    console.log(`  ${row.variant.padEnd(54)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}    ${row.qualifies ? "  ✓" : ""}`);
  }
  console.log(`\nTOP 5 by P&L $ (≥${MIN_TRADES} trades):`);
  const elig = all.filter((r) => r.trades >= MIN_TRADES);
  elig.sort((a, b) => b.pnlUsd - a.pnlUsd);
  for (const r of elig.slice(0, 5)) {
    console.log(`  ${r.variant.padEnd(54)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`);
  }
  console.log(`\nQUALIFYING (≥${MIN_TRADES} trades, ≥+$${MIN_PNL_USD}):`);
  const q = all.filter((r) => r.qualifies);
  if (q.length === 0) console.log(`  (none — null result)`);
  else q.forEach((r) => console.log(`  ${r.variant} → ${r.trades}t · ${r.wins}W · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });

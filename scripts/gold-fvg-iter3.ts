// Gold FVG deep-dive. Reference points: Silver=0.7minGap; ETH=0.3+filters.
// Gold OB & Sweep both have BUY-only asymmetry — likely also true for Gold FVG.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAUUSD";
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
  // ITER2 WIN: 4.5 + BUY + minAdx=22 = 86t / 36% WR / +0.48R / +$511.81
  { name: "WIN-iter2: 4.5+BUY+minAdx=22",                params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 22 } },
  // minAdx fine sweep
  { name: "4.5+BUY+minAdx=20",                           params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 20 } },
  { name: "4.5+BUY+minAdx=24",                           params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 24 } },
  { name: "4.5+BUY+minAdx=26",                           params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 26 } },
  { name: "4.5+BUY+minAdx=28",                           params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 28 } },
  // R:R sweep at minAdx=22
  { name: "R3.5+BUY+minAdx=22",                          params: basePs({ targetRMult: 3.5 }),                     filters: { buyOnly: true, minAdx: 22 } },
  { name: "R4+BUY+minAdx=22",                            params: basePs({ targetRMult: 4.0 }),                     filters: { buyOnly: true, minAdx: 22 } },
  { name: "R4.25+BUY+minAdx=22",                         params: basePs({ targetRMult: 4.25 }),                    filters: { buyOnly: true, minAdx: 22 } },
  { name: "R4.75+BUY+minAdx=22",                         params: basePs({ targetRMult: 4.75 }),                    filters: { buyOnly: true, minAdx: 22 } },
  { name: "R5+BUY+minAdx=22",                            params: basePs({ targetRMult: 5.0 }),                     filters: { buyOnly: true, minAdx: 22 } },
  { name: "R6+BUY+minAdx=22",                            params: basePs({ targetRMult: 6.0 }),                     filters: { buyOnly: true, minAdx: 22 } },
  // Add range cap on top of minAdx=22 (sweet spot of trending zone)
  { name: "4.5+BUY+minAdx=22+maxAdx=50",                 params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 22, maxAdx: 50 } },
  { name: "4.5+BUY+minAdx=22+maxAdx=40",                 params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 22, maxAdx: 40 } },
  // skipSat already no-op at iter1 — confirm with minAdx=22
  { name: "4.5+BUY+minAdx=22+skipSat",                   params: basePs({ targetRMult: 4.5 }),                     filters: { buyOnly: true, minAdx: 22, skipDaysOfWeekUtc: [6] } },
  // minGap on top of minAdx=22
  { name: "4.5+BUY+minAdx=22+minGap=0.2",                params: basePs({ targetRMult: 4.5, minGapAtrMul: 0.2 }),  filters: { buyOnly: true, minAdx: 22 } },
  { name: "4.5+BUY+minAdx=22+minGap=0.10",               params: basePs({ targetRMult: 4.5, minGapAtrMul: 0.10 }), filters: { buyOnly: true, minAdx: 22 } },
  { name: "4.5+BUY+minAdx=22+minGap=0.30",               params: basePs({ targetRMult: 4.5, minGapAtrMul: 0.30 }), filters: { buyOnly: true, minAdx: 22 } },
  // requireRejection on top
  { name: "4.5+BUY+minAdx=22+requireRejection",          params: basePs({ targetRMult: 4.5, requireRejection: 1 }), filters: { buyOnly: true, minAdx: 22 } },
  // maxActive sweep
  { name: "4.5+BUY+minAdx=22+maxActive=6",               params: basePs({ targetRMult: 4.5, maxActive: 6 }),       filters: { buyOnly: true, minAdx: 22 } },
  { name: "4.5+BUY+minAdx=22+maxActive=20",              params: basePs({ targetRMult: 4.5, maxActive: 20 }),      filters: { buyOnly: true, minAdx: 22 } },
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
  console.log(`[gold-fvg-deepdive] Gold / 1h × 8000 bars · cost ${COST_BPS} bps\n`);
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

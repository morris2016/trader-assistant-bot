// LTC Sweep deep-dive. ICT vs confirm; SELL-only (LTC bear bias from OB findings) + filters.

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

async function main() {
  const c = new C(); await c.ready;
  console.log(`[ltc-sweep-deepdive] Symbol: Litecoin / USD (cryLTCUSD) · cost ${COST_BPS} bps\n`);
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars`); return; }

  console.log(`══ 1h × ${candles.length} bars (~${Math.round(candles.length/24)}d 24/7) ══`);
  console.log(`  ${"variant".padEnd(58)}  trades  WR    expR    P&L $    qualifies?`);
  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d,
      enabled: d.id === "liquiditySweep",
      params: d.id === "liquiditySweep" ? v.params : d.params,
    }));
    const r = await runBacktest({
      symbol: SYMBOL, granularity: 3600 as any, count: candles.length,
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
    const qualifies = r.trades.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD;
    rows.push({ name: v.name, trades: r.trades.length, wins, expR, pnlUsd });
    const wr = r.trades.length ? `${(100*wins/r.trades.length).toFixed(0)}%` : "—";
    console.log(`  ${v.name.padEnd(58)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}    ${qualifies ? "  ✓" : ""}`);
  }
  console.log(`\nTOP 5 by P&L $ (≥${MIN_TRADES} trades):`);
  rows.filter((r) => r.trades >= MIN_TRADES).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(58)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
  console.log(`\nQUALIFYING (≥${MIN_TRADES} trades, ≥+$${MIN_PNL_USD}):`);
  const q = rows.filter((r) => r.trades >= MIN_TRADES && r.pnlUsd >= MIN_PNL_USD);
  if (q.length === 0) console.log(`  (none)`);
  else q.forEach((r) => console.log(`  ${r.name} → ${r.trades}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`));
}
main().catch((e) => { console.error(e); process.exit(1); });

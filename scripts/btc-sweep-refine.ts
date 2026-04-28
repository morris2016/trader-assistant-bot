// Iteration 2: refine around BTC Sweep winner — confirmation-style + with-trend@20.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryBTCUSD";
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

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 0, // CONFIRMATION-STYLE locked
    stopBufferAtrMul: 0.1,
    ...over,
  };
}

type Variant = { name: string; params: Record<string, number>; filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }> };
const variants: Variant[] = [
  // Baseline
  { name: "WIN: confirm 3:1 + withTrend@20",                 params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 20 } },
  // Confirm without with-trend filter
  { name: "confirm 3:1 (no filter)",                         params: basePs(),                                              filters: {} },
  { name: "confirm 3:1 + maxAdx=22",                         params: basePs(),                                              filters: { maxAdx: 22 } },
  { name: "confirm 3:1 + minAdx=22",                         params: basePs(),                                              filters: { minAdx: 22 } },
  // ADX threshold sweep on with-trend
  { name: "confirm 3:1 + withTrend@18",                      params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 18 } },
  { name: "confirm 3:1 + withTrend@22",                      params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "confirm 3:1 + withTrend@24",                      params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 24 } },
  { name: "confirm 3:1 + withTrend@26",                      params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 26 } },
  // R:R sweep
  { name: "confirm 2:1 + withTrend@20",                      params: basePs({ targetRMult: 2.0 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 2.5:1 + withTrend@20",                    params: basePs({ targetRMult: 2.5 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 4:1 + withTrend@20",                      params: basePs({ targetRMult: 4.0 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 5:1 + withTrend@20",                      params: basePs({ targetRMult: 5.0 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 6:1 + withTrend@20",                      params: basePs({ targetRMult: 6.0 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  // Confirmation window sweep
  { name: "confirm 3:1 + withTrend@20 + confWin=2",          params: basePs({ confirmationWindow: 2 }),                     filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20 + confWin=4",          params: basePs({ confirmationWindow: 4 }),                     filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20 + confWin=5",          params: basePs({ confirmationWindow: 5 }),                     filters: { withTrendOnlyAboveAdx: 20 } },
  // Pool stringency
  { name: "confirm 3:1 + withTrend@20 + minEqualCount=3",    params: basePs({ minEqualCount: 3 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20 + tighter eqTol=0.05", params: basePs({ equalToleranceAtrMul: 0.05 }),                filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20 + looser eqTol=0.2",   params: basePs({ equalToleranceAtrMul: 0.2 }),                 filters: { withTrendOnlyAboveAdx: 20 } },
  // Lookback
  { name: "confirm 3:1 + withTrend@20 + lookback=30",        params: basePs({ lookbackBars: 30 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "confirm 3:1 + withTrend@20 + lookback=80",        params: basePs({ lookbackBars: 80 }),                          filters: { withTrendOnlyAboveAdx: 20 } },
  // Combined champions
  { name: "confirm 4:1 + withTrend@22",                      params: basePs({ targetRMult: 4.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "confirm 5:1 + withTrend@22",                      params: basePs({ targetRMult: 5.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
];

async function main() {
  const c = new C(); await c.ready;
  console.log(`[btc-sweep-refine] BTC / 1h × 8000 bars · iter-2 around confirm + withTrend@20\n`);
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();
  console.log(`fetched ${candles.length} bars\n`);
  console.log(`  ${"variant".padEnd(58)}  trades  WR    expR    P&L $`);

  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === "liquiditySweep",
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
    rows.push({ name: v.name, trades: r.trades.length, wins, expR, pnlUsd });
    const wr = r.trades.length ? `${(100*wins/r.trades.length).toFixed(0)}%` : "—";
    console.log(`  ${v.name.padEnd(58)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}`);
  }

  console.log(`\nTOP 5 by P&L $ (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(58)}  ${String(r.trades).padStart(3)} trades · WR ${(100*r.wins/r.trades).toFixed(0)}% · pnl=${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
}
main().catch((e) => { console.error(e); process.exit(1); });

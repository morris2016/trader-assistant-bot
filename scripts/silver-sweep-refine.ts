// Iteration 2: refine around the winning sweep config (1h, ICT-style entry,
// with-trend above ADX 22). Vary R:R, ADX threshold, pool stringency, swing
// width, and combinations.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;
const GRANULARITY = 3600;
const COUNT = 3000;

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
    atrPeriod: 14,
    equalToleranceAtrMul: 0.1,
    minEqualCount: 2,
    lookbackBars: 50,
    confirmationWindow: 3,
    poolRetentionBarsAfterSweep: 20,
    swingLeft: 2,
    swingRight: 2,
    targetRMult: 3.0,
    entryOnSweep: 1, // locked: ICT-style entry
    stopBufferAtrMul: 0.1,
    ...over,
  };
}

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }>;
};

// Iteration 2: refine R:R + ADX threshold + pool stringency + swing width.
const variants: Variant[] = [
  // R:R sweep with the winning regime filter
  { name: "WIN baseline: 3:1 + withTrend@22",                params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "2:1 + withTrend@22",                              params: basePs({ targetRMult: 2.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "2.5:1 + withTrend@22",                            params: basePs({ targetRMult: 2.5 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "4:1 + withTrend@22",                              params: basePs({ targetRMult: 4.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "5:1 + withTrend@22",                              params: basePs({ targetRMult: 5.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "6:1 + withTrend@22",                              params: basePs({ targetRMult: 6.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "8:1 + withTrend@22",                              params: basePs({ targetRMult: 8.0 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  // ADX threshold sweep on the winner
  { name: "3:1 + withTrend@18 (looser trend)",               params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 18 } },
  { name: "3:1 + withTrend@20",                              params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "3:1 + withTrend@26 (stricter trend)",             params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 26 } },
  { name: "3:1 + withTrend@30",                              params: basePs(),                                              filters: { withTrendOnlyAboveAdx: 30 } },
  // Pool stringency at the winning filter
  { name: "3:1 + withTrend@22 + tighter eqTol=0.05",         params: basePs({ equalToleranceAtrMul: 0.05 }),                filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "3:1 + withTrend@22 + looser eqTol=0.2",           params: basePs({ equalToleranceAtrMul: 0.2 }),                 filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "3:1 + withTrend@22 + minEqualCount=3",            params: basePs({ minEqualCount: 3 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  // Swing width
  { name: "3:1 + withTrend@22 + swing 3/3",                  params: basePs({ swingLeft: 3, swingRight: 3 }),               filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "3:1 + withTrend@22 + swing 4/4",                  params: basePs({ swingLeft: 4, swingRight: 4 }),               filters: { withTrendOnlyAboveAdx: 22 } },
  // Lookback window for pools
  { name: "3:1 + withTrend@22 + lookback=80",                params: basePs({ lookbackBars: 80 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "3:1 + withTrend@22 + lookback=30",                params: basePs({ lookbackBars: 30 }),                          filters: { withTrendOnlyAboveAdx: 22 } },
  // Combined champions
  { name: "5:1 + withTrend@22 + minEqualCount=3",            params: basePs({ targetRMult: 5.0, minEqualCount: 3 }),        filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "4:1 + withTrend@26 (max-trend)",                  params: basePs({ targetRMult: 4.0 }),                          filters: { withTrendOnlyAboveAdx: 26 } },
];

async function main() {
  const c = new C(); await c.ready;
  console.log(`[silver-sweep-refine] Silver / 1h × ${COUNT} bars · iteration-2 around ICT/withTrend winner\n`);
  const candles = await fetchPaged(c, SYMBOL, GRANULARITY, COUNT);
  c.close();

  console.log(`fetched ${candles.length} bars\n`);
  console.log(`  ${"variant".padEnd(50)}  trades  WR    expR     P&L $`);

  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === "liquiditySweep",
      params: d.id === "liquiditySweep" ? v.params : d.params,
    }));
    const r = await runBacktest({
      symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
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
    console.log(
      `  ${v.name.padEnd(50)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}`,
    );
  }

  console.log(`\nTOP 5 by Expectancy R (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.expR - a.expR).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(50)}  ${String(r.trades).padStart(3)} trades · ${(100*r.wins/r.trades).toFixed(0)}% WR · expR=${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)} · pnl=${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
  console.log(`\nTOP 5 by P&L $ (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(50)}  ${String(r.trades).padStart(3)} trades · ${(100*r.wins/r.trades).toFixed(0)}% WR · expR=${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)} · pnl=${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
}

main().catch((e) => { console.error(e); process.exit(1); });

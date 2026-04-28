// BTC Sweep deep-dive. Hypothesis: trend-continuation should fit BTC better
// than OB/FVG (which both nullified). Sweep with with-trend filter captures
// stop-hunts before continuation in trends — aligned with crypto's direction.
//
// IMPORTANT: on BTC, R-expectancy is unreliable due to Deriv's -100% cap
// truncating extreme adverse moves. Trust $ totals as the honest metric.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryBTCUSD";
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;
const MIN_TRADES = 30;
const MIN_PNL_USD = 200; // for BTC: trust $ over R; require ≥+$200 over 333 days = ~$0.60/day

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

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }>;
};

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
    entryOnSweep: 1,
    stopBufferAtrMul: 0.1,
    ...over,
  };
}

const variants: Variant[] = [
  // Silver-style baseline (the validated Silver Sweep config)
  { name: "ICT 3:1 + withTrend@20 (Silver-winner)",     params: basePs(),                             filters: { withTrendOnlyAboveAdx: 20 } },
  // Confirmation-style entry (legacy)
  { name: "confirm 3:1 + withTrend@20",                 params: basePs({ entryOnSweep: 0 }),          filters: { withTrendOnlyAboveAdx: 20 } },
  // No filter
  { name: "ICT 3:1 (no filter)",                        params: basePs(),                             filters: {} },
  // ADX gate variants
  { name: "ICT 3:1 + minAdx=22 (trending only)",        params: basePs(),                             filters: { minAdx: 22 } },
  { name: "ICT 3:1 + maxAdx=22 (ranging only)",         params: basePs(),                             filters: { maxAdx: 22 } },
  { name: "ICT 3:1 + withTrend@18",                     params: basePs(),                             filters: { withTrendOnlyAboveAdx: 18 } },
  { name: "ICT 3:1 + withTrend@22",                     params: basePs(),                             filters: { withTrendOnlyAboveAdx: 22 } },
  { name: "ICT 3:1 + withTrend@26",                     params: basePs(),                             filters: { withTrendOnlyAboveAdx: 26 } },
  // R:R sweep with the candidate-best filter
  { name: "ICT 2:1 + withTrend@20",                     params: basePs({ targetRMult: 2.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 4:1 + withTrend@20",                     params: basePs({ targetRMult: 4.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 5:1 + withTrend@20",                     params: basePs({ targetRMult: 5.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 6:1 + withTrend@20",                     params: basePs({ targetRMult: 6.0 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  // Pool stringency
  { name: "ICT 3:1 + withTrend@20 + minEqualCount=3",   params: basePs({ minEqualCount: 3 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 3:1 + withTrend@20 + tighter eqTol=0.05", params: basePs({ equalToleranceAtrMul: 0.05 }), filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 3:1 + withTrend@20 + looser eqTol=0.2",  params: basePs({ equalToleranceAtrMul: 0.2 }),  filters: { withTrendOnlyAboveAdx: 20 } },
  // Lookback variations
  { name: "ICT 3:1 + withTrend@20 + lookback=30",       params: basePs({ lookbackBars: 30 }),         filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 3:1 + withTrend@20 + lookback=80",       params: basePs({ lookbackBars: 80 }),         filters: { withTrendOnlyAboveAdx: 20 } },
];

type ResultRow = {
  variant: string; trades: number; wins: number; expR: number; totalR: number; pnlUsd: number; qualifies: boolean;
};

async function runVariant(v: Variant, candles: Candle[], gran: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? v.params : d.params,
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
    variant: v.name, trades: r.trades.length, wins, expR, totalR, pnlUsd,
    // For BTC: use $ as primary qualifier; require ≥ MIN_TRADES and ≥ +$200 over 333 days
    qualifies: r.trades.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[btc-sweep-deepdive] Symbol: Bitcoin / USD · cost ${COST_BPS} bps`);
  console.log(`Note: on BTC, R-expectancy is unreliable due to Deriv −100% cap. Treat $ as truth.\n`);

  const all: ResultRow[] = [];
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();

  console.log(`══ 1h × ${candles.length} bars (~${Math.round(candles.length/24)}d 24/7) ══`);
  console.log(`  ${"variant".padEnd(54)}  trades  WR    expR    P&L $    qualifies?`);
  for (const v of variants) {
    const row = await runVariant(v, candles, 3600);
    all.push(row);
    const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
    console.log(
      `  ${row.variant.padEnd(54)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}   ${row.qualifies ? "  ✓" : ""}`,
    );
  }

  console.log(`\n══ TOP 5 by P&L $ (≥${MIN_TRADES} trades) ══`);
  const elig = all.filter((r) => r.trades >= MIN_TRADES);
  elig.sort((a, b) => b.pnlUsd - a.pnlUsd);
  for (const r of elig.slice(0, 5)) {
    console.log(`  ${r.variant.padEnd(54)} trades=${r.trades} WR=${(100*r.wins/r.trades).toFixed(0)}% pnl=${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
  }

  console.log(`\n══ QUALIFYING (≥${MIN_TRADES} trades, ≥+$${MIN_PNL_USD}) ══`);
  const q = all.filter((r) => r.qualifies);
  if (q.length === 0) {
    console.log(`  (none)`);
  } else {
    for (const r of q) {
      console.log(`  ${r.variant} → trades=${r.trades} WR=${(100*r.wins/r.trades).toFixed(0)}% pnl=+$${r.pnlUsd.toFixed(2)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

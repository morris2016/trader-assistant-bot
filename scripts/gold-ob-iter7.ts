// Gold (XAU/USD) OB deep-dive — same systematic process as Silver / ETH / BTC.
// Gold shares Silver's metal regime but tends to trend more cleanly with macro flows.
// Test Silver-style filters (maxAdx<22, qualityLB) AND ETH-style (with-trend@20)
// to see which regime Gold prefers. 1h TF — same start point as ETH OB.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAUUSD";
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;
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

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number; buyOnly: boolean; sellOnly: boolean; skipDaysOfWeekUtc: number[] }>;
};

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
    ...over,
  };
}

const variants: Variant[] = [
  // ITER6 WIN: R4.5 with lb8/disp0.6/obSearch=5/BUY = +$609.81 / 31t / 32% WR / +0.68R
  { name: "WIN-iter6: R4.5/lb8/d0.6",                    params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.25/lb8/d0.6",                              params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.0/lb8/d0.6 (iter5)",                       params: basePs({ targetRMult: 4.0, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  // R 4.5 with lookback variations (winner)
  { name: "R4.5/lb6/d0.6",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.5/lb7/d0.6",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 7, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.5/lb9/d0.6",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 9, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.5/lb10/d0.6",                              params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 10, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.5/lb12/d0.6",                              params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 12, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  // R 4.25 with lookback variations
  { name: "R4.25/lb6/d0.6",                              params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.25/lb7/d0.6",                              params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 7, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.25/lb10/d0.6",                             params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 10, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.25/lb12/d0.6",                             params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 12, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  // R 4.5 with disp variations
  { name: "R4.5/lb8/d0.4",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.4 }), filters: { buyOnly: true } },
  { name: "R4.5/lb8/d0.5",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.5 }), filters: { buyOnly: true } },
  { name: "R4.5/lb8/d0.7",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.7 }), filters: { buyOnly: true } },
  { name: "R4.5/lb8/d0.8 (default)",                     params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.8 }), filters: { buyOnly: true } },
  // Higher R:R with looser lookback (more trades, more reach)
  { name: "R4.75/lb8/d0.6",                              params: basePs({ targetRMult: 4.75, obSearchMaxBack: 5, lookback: 8, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  { name: "R4.75/lb6/d0.5",                              params: basePs({ targetRMult: 4.75, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.5 }), filters: { buyOnly: true } },
  // Best from iter6 also worth re-running for direct comparison: lb6 (was +$556)
  { name: "R4.0/lb6/d0.6 (iter6)",                       params: basePs({ targetRMult: 4.0, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.6 }), filters: { buyOnly: true } },
  // Final stack permutations
  { name: "R4.5/lb6/d0.5",                               params: basePs({ targetRMult: 4.5, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.5 }), filters: { buyOnly: true } },
  { name: "R4.25/lb6/d0.5",                              params: basePs({ targetRMult: 4.25, obSearchMaxBack: 5, lookback: 6, displacementAtrMultiplier: 0.5 }), filters: { buyOnly: true } },
];

type ResultRow = {
  variant: string; trades: number; wins: number; expR: number; totalR: number; pnlUsd: number; qualifies: boolean;
};

async function runVariant(v: Variant, candles: Candle[], gran: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? v.params : d.params,
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
    qualifies: r.trades.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[gold-ob-deepdive] Symbol: Gold / USD (frxXAUUSD) · cost ${COST_BPS} bps`);
  console.log(`Hypothesis: Silver-style or ETH-style filters? Sweep both.\n`);

  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars; abort`); return; }

  console.log(`══ 1h × ${candles.length} bars (~${Math.round(candles.length/24)}d 24/7) ══`);
  console.log(`  ${"variant".padEnd(54)}  trades  WR    expR    P&L $    qualifies?`);
  const all: ResultRow[] = [];
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
    console.log(`  ${r.variant.padEnd(54)} trades=${r.trades} WR=${(100*r.wins/r.trades).toFixed(0)}% expR=${r.expR >= 0 ? "+" : ""}${r.expR.toFixed(2)}R pnl=${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
  }

  console.log(`\n══ QUALIFYING (≥${MIN_TRADES} trades, ≥+$${MIN_PNL_USD}) ══`);
  const q = all.filter((r) => r.qualifies);
  if (q.length === 0) {
    console.log(`  (none)`);
  } else {
    for (const r of q) {
      console.log(`  ${r.variant} → trades=${r.trades} pnl=+$${r.pnlUsd.toFixed(2)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// Silver liquiditySweep deep-dive. Mirrors the OB tuning loop:
//   1) baseline across multiple TFs with structural stops
//   2) sweep params (entryOnSweep, R:R, ADX gates, with-trend, swing/pool sizes)
//   3) winner-vs-loser structural distribution analysis
//   4) print everything; pick the winning recipe at the end

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;
const MIN_TRADES = 30;
const MIN_EXP_R = 0.20;

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

type Tf = { granularity: number; count: number; label: string };
const TFS: Tf[] = [
  { granularity: 300,  count: 5000, label: "5m × 5000  (~17d)" },
  { granularity: 900,  count: 5000, label: "15m × 5000 (~52d)" },
  { granularity: 3600, count: 3000, label: "1h × 3000  (~125d)" },
];

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }>;
};

function baseSweepParams(over: Record<string, number> = {}): Record<string, number> {
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
    entryOnSweep: 0,
    stopBufferAtrMul: 0.1,
    ...over,
  };
}

const variants: Variant[] = [
  // Phase A: timing + R:R sweep
  { name: "baseline (confirm, 3:1)",                  params: baseSweepParams(),                                        filters: {} },
  { name: "ICT-style (entryOnSweep, 3:1)",            params: baseSweepParams({ entryOnSweep: 1 }),                     filters: {} },
  { name: "ICT-style 2:1",                            params: baseSweepParams({ entryOnSweep: 1, targetRMult: 2.0 }),   filters: {} },
  { name: "ICT-style 4:1",                            params: baseSweepParams({ entryOnSweep: 1, targetRMult: 4.0 }),   filters: {} },
  { name: "ICT-style 5:1",                            params: baseSweepParams({ entryOnSweep: 1, targetRMult: 5.0 }),   filters: {} },
  // Phase B: ADX gates on best timing
  { name: "ICT 3:1 + maxAdx=22 (ranging)",            params: baseSweepParams({ entryOnSweep: 1 }),                     filters: { maxAdx: 22 } },
  { name: "ICT 3:1 + minAdx=22 (trending only)",      params: baseSweepParams({ entryOnSweep: 1 }),                     filters: { minAdx: 22 } },
  { name: "ICT 3:1 + with-trend above ADX22",         params: baseSweepParams({ entryOnSweep: 1 }),                     filters: { withTrendOnlyAboveAdx: 22 } },
  // Phase C: pool stringency
  { name: "ICT 3:1 + minEqualCount=3 (stricter)",     params: baseSweepParams({ entryOnSweep: 1, minEqualCount: 3 }),   filters: {} },
  { name: "ICT 3:1 + tighter equalTol=0.05",          params: baseSweepParams({ entryOnSweep: 1, equalToleranceAtrMul: 0.05 }), filters: {} },
  { name: "ICT 3:1 + looser equalTol=0.2",            params: baseSweepParams({ entryOnSweep: 1, equalToleranceAtrMul: 0.2 }),  filters: {} },
  // Phase D: combined best guesses
  { name: "ICT 3:1 + maxAdx=22 + minEqualCount=3",    params: baseSweepParams({ entryOnSweep: 1, minEqualCount: 3 }),   filters: { maxAdx: 22 } },
  { name: "ICT 4:1 + maxAdx=22",                      params: baseSweepParams({ entryOnSweep: 1, targetRMult: 4.0 }),   filters: { maxAdx: 22 } },
];

type ResultRow = {
  variant: string;
  trades: number;
  wins: number;
  expR: number;
  totalR: number;
  pnlUsd: number;
  qualifies: boolean;
};

async function runVariant(v: Variant, candles: Candle[], gran: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? v.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL,
    granularity: gran as any,
    count: candles.length,
    atrSlMult: 1.0,
    atrTpMult: v.params.targetRMult ?? 3.0,
    costBps: COST_BPS,
    ...v.filters,
    detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
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
    variant: v.name,
    trades: r.trades.length,
    wins,
    expR,
    totalR,
    pnlUsd,
    qualifies: r.trades.length >= MIN_TRADES && expR >= MIN_EXP_R,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[silver-sweep-deepdive] connected. Symbol: Silver / USD\n`);

  const all: Array<{ tf: string; row: ResultRow }> = [];

  for (const tf of TFS) {
    let candles: Candle[]; try { candles = await fetchPaged(c, SYMBOL, tf.granularity, tf.count); }
    catch (e) { console.log(`fetch failed ${tf.label}: ${(e as Error).message}`); continue; }
    if (candles.length < 200) { console.log(`${tf.label}: only ${candles.length} bars; skip`); continue; }

    console.log(`══ ${tf.label} · ${candles.length} bars ══`);
    console.log(`  ${"variant".padEnd(46)}  trades  WR    expR     totalR    P&L $    qualifies`);
    for (const v of variants) {
      const row = await runVariant(v, candles, tf.granularity);
      all.push({ tf: tf.label, row });
      const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
      console.log(
        `  ${row.variant.padEnd(46)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ` +
        `${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ` +
        `${(row.totalR >= 0 ? "+" : "") + row.totalR.toFixed(1).padStart(5)}R   ` +
        `${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}   ${row.qualifies ? "  ✓" : ""}`,
      );
    }
    console.log("");
  }
  c.close();

  // Highlights
  console.log(`══════════════════════════════════════════════════════════════════════════`);
  console.log(`TOP 5 by Expectancy R (across all TFs, ≥${MIN_TRADES} trades)`);
  const eligible = all.filter((x) => x.row.trades >= MIN_TRADES);
  eligible.sort((a, b) => b.row.expR - a.row.expR);
  for (const x of eligible.slice(0, 5)) {
    console.log(`  [${x.tf.padEnd(20)}] ${x.row.variant.padEnd(46)} trades=${x.row.trades} WR=${(100*x.row.wins/x.row.trades).toFixed(0)}% expR=${x.row.expR >= 0 ? "+" : ""}${x.row.expR.toFixed(2)} pnl=${x.row.pnlUsd >= 0 ? "+" : ""}$${x.row.pnlUsd.toFixed(2)}`);
  }

  console.log(`\nTOP 5 by P&L $ (across all TFs, ≥${MIN_TRADES} trades)`);
  eligible.sort((a, b) => b.row.pnlUsd - a.row.pnlUsd);
  for (const x of eligible.slice(0, 5)) {
    console.log(`  [${x.tf.padEnd(20)}] ${x.row.variant.padEnd(46)} trades=${x.row.trades} WR=${(100*x.row.wins/x.row.trades).toFixed(0)}% expR=${x.row.expR >= 0 ? "+" : ""}${x.row.expR.toFixed(2)} pnl=${x.row.pnlUsd >= 0 ? "+" : ""}$${x.row.pnlUsd.toFixed(2)}`);
  }

  console.log(`\nQUALIFYING (≥${MIN_TRADES} trades, ≥+${MIN_EXP_R}R expectancy):`);
  const q = all.filter((x) => x.row.qualifies);
  if (q.length === 0) {
    console.log(`  (none yet — see top-by-expectancy above for closest, then iterate)`);
  } else {
    for (const x of q) {
      console.log(`  [${x.tf.padEnd(20)}] ${x.row.variant} → trades=${x.row.trades} expR=+${x.row.expR.toFixed(2)} pnl=+$${x.row.pnlUsd.toFixed(2)}`);
    }
  }
  void latestRegime; // silence unused-import in this round
}

main().catch((e) => { console.error(e); process.exit(1); });

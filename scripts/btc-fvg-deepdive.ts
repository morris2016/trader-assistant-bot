// BTC FVG deep-dive — same systematic process as Silver FVG.
// Hypothesis: minGap quality filter is the primary edge driver (smooth monotonic
// pattern: larger gaps = higher expectancy, fewer trades). If BTC shows the
// same pattern as Silver, we have a tradeable strategy. If pattern is flat or
// inverted, null result like BTC OB.

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
  { granularity: 3600, count: 8000, label: "1h × 8000 (~333d 24/7)" },
];

type Variant = {
  name: string;
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }>;
};

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12,
    targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0,
    ...over,
  };
}

const variants: Variant[] = [
  // minGap sweep — the key filter for Silver FVG
  { name: "edge · 3:1 · minGap=0.15 (default)",      params: basePs(),                                         filters: {} },
  { name: "edge · 3:1 · minGap=0.30",                params: basePs({ minGapAtrMul: 0.30 }),                   filters: {} },
  { name: "edge · 3:1 · minGap=0.50",                params: basePs({ minGapAtrMul: 0.50 }),                   filters: {} },
  { name: "edge · 3:1 · minGap=0.70 (Silver winner)", params: basePs({ minGapAtrMul: 0.70 }),                   filters: {} },
  { name: "edge · 3:1 · minGap=1.0",                 params: basePs({ minGapAtrMul: 1.0 }),                    filters: {} },
  { name: "edge · 3:1 · minGap=1.5",                 params: basePs({ minGapAtrMul: 1.5 }),                    filters: {} },
  // R:R sweep at default minGap (lots of trades)
  { name: "edge · 2:1 · minGap=0.15",                params: basePs({ targetRMult: 2.0 }),                     filters: {} },
  { name: "edge · 4:1 · minGap=0.15",                params: basePs({ targetRMult: 4.0 }),                     filters: {} },
  { name: "edge · 5:1 · minGap=0.15",                params: basePs({ targetRMult: 5.0 }),                     filters: {} },
  // R:R sweep at Silver winner minGap
  { name: "edge · 2:1 · minGap=0.7",                 params: basePs({ minGapAtrMul: 0.7, targetRMult: 2.0 }),  filters: {} },
  { name: "edge · 4:1 · minGap=0.7",                 params: basePs({ minGapAtrMul: 0.7, targetRMult: 4.0 }),  filters: {} },
  { name: "edge · 5:1 · minGap=0.7",                 params: basePs({ minGapAtrMul: 0.7, targetRMult: 5.0 }),  filters: {} },
  // Entry depth variants
  { name: "ce · 3:1 · minGap=0.15",                  params: basePs({ entryDepth: 1 }),                        filters: {} },
  { name: "ce · 3:1 · minGap=0.5",                   params: basePs({ entryDepth: 1, minGapAtrMul: 0.5 }),     filters: {} },
  { name: "far · 3:1 · minGap=0.15",                 params: basePs({ entryDepth: 2 }),                        filters: {} },
  // Rejection filter
  { name: "edge · 3:1 + rejection",                  params: basePs({ requireRejection: 1 }),                  filters: {} },
  { name: "edge · 3:1 + rejection · minGap=0.5",     params: basePs({ requireRejection: 1, minGapAtrMul: 0.5 }), filters: {} },
  // ADX gates (FVG was regime-agnostic on Silver — verify on BTC)
  { name: "edge · 3:1 + maxAdx=22",                  params: basePs(),                                         filters: { maxAdx: 22 } },
  { name: "edge · 3:1 + minAdx=22",                  params: basePs(),                                         filters: { minAdx: 22 } },
  { name: "edge · 3:1 + with-trend@20",              params: basePs(),                                         filters: { withTrendOnlyAboveAdx: 20 } },
];

type ResultRow = {
  variant: string; trades: number; wins: number; expR: number; totalR: number; pnlUsd: number; qualifies: boolean;
};

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
    variant: v.name, trades: r.trades.length, wins, expR, totalR, pnlUsd,
    qualifies: r.trades.length >= MIN_TRADES && expR >= MIN_EXP_R,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[btc-fvg-deepdive] Symbol: Bitcoin / USD · cost ${COST_BPS} bps\n`);

  const all: Array<{ tf: string; row: ResultRow }> = [];
  for (const tf of TFS) {
    let candles: Candle[]; try { candles = await fetchPaged(c, SYMBOL, tf.granularity, tf.count); }
    catch (e) { console.log(`fetch ${tf.label}: ${(e as Error).message}`); continue; }
    if (candles.length < 200) { console.log(`${tf.label}: only ${candles.length} bars; skip`); continue; }

    console.log(`══ ${tf.label} · ${candles.length} bars ══`);
    console.log(`  ${"variant".padEnd(50)}  trades  WR    expR     totalR    P&L $    qualifies`);
    for (const v of variants) {
      const row = await runVariant(v, candles, tf.granularity);
      all.push({ tf: tf.label, row });
      const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
      console.log(
        `  ${row.variant.padEnd(50)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ${(row.totalR >= 0 ? "+" : "") + row.totalR.toFixed(1).padStart(5)}R   ${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}   ${row.qualifies ? "  ✓" : ""}`,
      );
    }
    console.log("");
  }
  c.close();

  console.log(`══ TOP 5 by Expectancy R (≥${MIN_TRADES} trades) ══`);
  const elig = all.filter((x) => x.row.trades >= MIN_TRADES);
  elig.sort((a, b) => b.row.expR - a.row.expR);
  for (const x of elig.slice(0, 5)) {
    console.log(`  ${x.row.variant.padEnd(50)} trades=${x.row.trades} WR=${(100*x.row.wins/x.row.trades).toFixed(0)}% expR=${x.row.expR >= 0 ? "+" : ""}${x.row.expR.toFixed(2)} pnl=${x.row.pnlUsd >= 0 ? "+" : ""}$${x.row.pnlUsd.toFixed(2)}`);
  }
  console.log(`\n══ TOP 5 by P&L $ ══`);
  elig.sort((a, b) => b.row.pnlUsd - a.row.pnlUsd);
  for (const x of elig.slice(0, 5)) {
    console.log(`  ${x.row.variant.padEnd(50)} trades=${x.row.trades} WR=${(100*x.row.wins/x.row.trades).toFixed(0)}% expR=${x.row.expR >= 0 ? "+" : ""}${x.row.expR.toFixed(2)} pnl=${x.row.pnlUsd >= 0 ? "+" : ""}$${x.row.pnlUsd.toFixed(2)}`);
  }
  console.log(`\n══ QUALIFYING (≥${MIN_TRADES} trades, ≥+${MIN_EXP_R}R) ══`);
  const q = all.filter((x) => x.row.qualifies);
  if (q.length === 0) {
    console.log(`  (none yet)`);
  } else {
    for (const x of q) {
      console.log(`  ${x.row.variant} → trades=${x.row.trades} expR=+${x.row.expR.toFixed(2)} pnl=+$${x.row.pnlUsd.toFixed(2)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

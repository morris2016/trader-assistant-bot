// USD/JPY OB deep-dive. JPY pairs typically have wider intraday ranges than
// EUR/USD — better candidate for OB displacement detection. TRAIN/TEST/W0 from
// the start to avoid LTC overfit pattern.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxUSDJPY";
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
  // Phase A: baseline + R:R sweep
  { name: "loose · 3:1 (Silver-style)",                 params: basePs(),                                                  filters: {} },
  { name: "loose · 2:1",                                params: basePs({ targetRMult: 2.0 }),                              filters: {} },
  { name: "loose · 4:1",                                params: basePs({ targetRMult: 4.0 }),                              filters: {} },
  { name: "loose · 5:1",                                params: basePs({ targetRMult: 5.0 }),                              filters: {} },
  { name: "loose · 6:1",                                params: basePs({ targetRMult: 6.0 }),                              filters: {} },
  // Phase B: side bias (Gold lesson — test asymmetry)
  { name: "loose · 3:1 + BUY-only",                     params: basePs(),                                                  filters: { buyOnly: true } },
  { name: "loose · 3:1 + SELL-only",                    params: basePs(),                                                  filters: { sellOnly: true } },
  { name: "loose · 4:1 + BUY-only",                     params: basePs({ targetRMult: 4.0 }),                              filters: { buyOnly: true } },
  { name: "loose · 4:1 + SELL-only",                    params: basePs({ targetRMult: 4.0 }),                              filters: { sellOnly: true } },
  // Phase C: ADX regime gates
  { name: "maxAdx=22 (Silver-ranging)",                 params: basePs(),                                                  filters: { maxAdx: 22 } },
  { name: "minAdx=22 (trending)",                       params: basePs(),                                                  filters: { minAdx: 22 } },
  { name: "with-trend@20 (ETH-style)",                  params: basePs(),                                                  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@22",                              params: basePs(),                                                  filters: { withTrendOnlyAboveAdx: 22 } },
  // Phase D: stricter displacement
  { name: "disp1.2 · 3:1",                              params: basePs({ displacementAtrMultiplier: 1.2 }),                filters: {} },
  { name: "disp1.5 · 3:1",                              params: basePs({ displacementAtrMultiplier: 1.5 }),                filters: {} },
  // Phase E: entry depth
  { name: "ce · 3:1",                                   params: basePs({ entryDepth: 1 }),                                 filters: {} },
  { name: "ce · 4:1",                                   params: basePs({ entryDepth: 1, targetRMult: 4.0 }),               filters: {} },
  // Phase F: requireFVG / quality
  { name: "+FVG · 3:1",                                 params: basePs({ requireFVG: 1 }),                                 filters: {} },
  { name: "qualityLB=10",                               params: basePs({ qualityFilterLookback: 10 }),                     filters: {} },
  // Phase G: combined champions from each asset's recipe
  { name: "ETH-style: with-trend@20 + edge·6:1",        params: basePs({ targetRMult: 6.0 }),                              filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "Gold-style: BUY + lb6/d0.6/obSearch=5 · 4.5:1", params: basePs({ targetRMult: 4.5, lookback: 6, displacementAtrMultiplier: 0.6, obSearchMaxBack: 5 }), filters: { buyOnly: true } },
  { name: "Silver-style: maxAdx=22 + qualityLB=10",     params: basePs({ qualityFilterLookback: 10 }),                     filters: { maxAdx: 22 } },
  // Phase H: skipSat / skipSatSun (crypto trades 24/7 but weekend liquidity differs)
  { name: "loose · 3:1 + skipSat",                      params: basePs(),                                                  filters: { skipDaysOfWeekUtc: [6] } },
  { name: "loose · 4:1 + skipSatSun",                   params: basePs({ targetRMult: 4.0 }),                              filters: { skipDaysOfWeekUtc: [0, 6] } },
];

type ResultRow = {
  variant: string; trades: number; wins: number; expR: number; totalR: number; pnlUsd: number; qualifies: boolean;
};

// Two windows tested with warmup. Trades are filtered to only those within window.
const TRAIN_START = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const TRAIN_END   = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_START  = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_END    = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

async function runWindowed(v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? v.params : d.params,
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
  return {
    variant: v.name, trades: inWin.length, wins, expR, totalR, pnlUsd,
    qualifies: inWin.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[usdjpy-ob] Symbol: USD/JPY (frxUSDJPY) · cost ${COST_BPS} bps · 1h TF`);
  console.log(`TRAIN: 2026-01-01 → 2026-03-31 (~90d) · TEST: 2026-04-01 → 2026-04-27 (~27d)\n`);

  const candles = await fetchPaged(c, SYMBOL, 3600, 5500);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars; abort`); return; }

  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`Fetched ${candles.length} 1h bars (${fromDate} → ${toDate}, ~${Math.round(candles.length/24)}d)`);
  const trainWarmup = candles.filter((cn) => cn.epoch < TRAIN_START).length;
  const testWarmup = candles.filter((cn) => cn.epoch < TEST_START).length;
  console.log(`TRAIN warmup: ${trainWarmup} bars (~${Math.round(trainWarmup/24)}d) before Jan 1`);
  console.log(`TEST warmup:  ${testWarmup} bars (~${Math.round(testWarmup/24)}d) before Apr 1\n`);

  for (const [label, ws, we] of [["TRAIN: Jan 1 → Mar 31", TRAIN_START, TRAIN_END], ["TEST: Apr 1 → Apr 27 (OOS)", TEST_START, TEST_END]] as const) {
    console.log(`══ ${label} ══`);
    console.log(`  ${"variant".padEnd(54)}  trades  WR    expR    P&L $    qualifies?`);
    const all: ResultRow[] = [];
    for (const v of variants) {
      const row = await runWindowed(v, candles, ws, we);
      all.push(row);
      const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
      console.log(
        `  ${row.variant.padEnd(54)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}   ${row.qualifies ? "  ✓" : ""}`,
      );
    }
    const elig = all.filter((r) => r.trades >= MIN_TRADES);
    elig.sort((a, b) => b.pnlUsd - a.pnlUsd);
    console.log(`  TOP 3 by $ (≥${MIN_TRADES}t):`);
    for (const r of elig.slice(0, 3)) {
      console.log(`    ${r.variant.padEnd(54)} ${r.trades}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · ${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
    }
    console.log(``);
  }
  return;
  console.log(`══ unused below ══`);
  if (true) { /* */
    if (true) {
      console.log(`(legacy)`);}
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

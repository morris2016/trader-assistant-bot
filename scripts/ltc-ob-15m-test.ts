// Litecoin (LTC) OB deep-dive — same systematic process as Silver/ETH/BTC/Gold.
// Hypothesis: LTC is "silver of crypto" — lower vol than ETH, less retail-driven than BTC.
// Test Silver-style ranging filters + ETH-style trend-continuation + Gold-style BUY-only.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryLTCUSD";
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
  // ITER3 WIN: +FVG · 3:1 + disp0.6 = 62t / 48% WR / +0.65R / +$972.23
  { name: "WIN-iter3: disp0.6",                         params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: {} },
  { name: "disp0.5",                                    params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.5 }), filters: {} },
  { name: "disp0.7",                                    params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.7 }), filters: {} },
  { name: "disp0.4",                                    params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.4 }), filters: {} },
  // Stack disp0.6 with top single-add wins
  { name: "disp0.6 + rejBody=0.5",                      params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, rejectionBodyAtrMul: 0.5 }), filters: {} },
  { name: "disp0.6 + atrP=20",                          params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, atrPeriod: 20 }), filters: {} },
  { name: "disp0.6 + skipSat",                          params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: { skipDaysOfWeekUtc: [6] } },
  { name: "disp0.6 + skipSatSun",                       params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: { skipDaysOfWeekUtc: [0, 6] } },
  { name: "disp0.6 + retestBars=1",                     params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, retestConfirmationBars: 1 }), filters: {} },
  { name: "disp0.6 + lookback=16",                      params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, lookback: 16 }), filters: {} },
  { name: "disp0.6 + lookback=8",                       params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, lookback: 8 }), filters: {} },
  // R:R fine sweep with disp0.6
  { name: "disp0.6 · 2.5:1",                            params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, targetRMult: 2.5 }), filters: {} },
  { name: "disp0.6 · 3.5:1",                            params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, targetRMult: 3.5 }), filters: {} },
  { name: "disp0.6 · 4:1",                              params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, targetRMult: 4.0 }), filters: {} },
  // Triple stacks
  { name: "disp0.6 + rejBody=0.5 + atrP=20",            params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, rejectionBodyAtrMul: 0.5, atrPeriod: 20 }), filters: {} },
  { name: "disp0.6 + skipSat + rejBody=0.5",            params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6, rejectionBodyAtrMul: 0.5 }), filters: { skipDaysOfWeekUtc: [6] } },
  // Side bias check on top of disp0.6
  { name: "disp0.6 + SELL-only",                        params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: { sellOnly: true } },
  { name: "disp0.6 + with-trend@20",                    params: basePs({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: { withTrendOnlyAboveAdx: 20 } },
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

// Two windows tested with warmup. Both bracket the LTC OB Sep-Apr 1h validation
// to check whether the +FVG·3:1·disp0.6·rejBody0.5 winner generalizes at 15m TF.
const W1_START = Math.floor(new Date('2026-02-01T00:00:00Z').getTime() / 1000);
const W1_END   = Math.floor(new Date('2026-03-15T00:00:00Z').getTime() / 1000);
const W2_START = Math.floor(new Date('2026-03-15T00:00:00Z').getTime() / 1000);
const W2_END   = Math.floor(new Date('2026-04-28T00:00:00Z').getTime() / 1000);

async function runWindowedVariant(v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number): Promise<ResultRow> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? v.params : d.params,
  }));
  // Slice to the candles up to windowEnd (warmup + window)
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const r = await runBacktest({
    symbol: SYMBOL, granularity: 900 as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  // Filter trades: only count those within the window
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
  console.log(`[ltc-ob-15m-test] Symbol: Litecoin / USD (cryLTCUSD) · cost ${COST_BPS} bps · 15m TF`);
  console.log(`Cross-window check: Feb 1 → Mar 15 vs Mar 15 → Apr 27 (each ~42d)\n`);

  const candles = await fetchPaged(c, SYMBOL, 900, 12000);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars; abort`); return; }

  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`Fetched ${candles.length} 15m bars (${fromDate} → ${toDate}, ~${Math.round(candles.length/96)}d)`);

  // Verify warmup is available before window 1
  const w1WarmupBars = candles.filter((cn) => cn.epoch < W1_START).length;
  const w2WarmupBars = candles.filter((cn) => cn.epoch < W2_START).length;
  console.log(`Window 1 warmup: ${w1WarmupBars} bars (~${Math.round(w1WarmupBars/96)}d) before Feb 1`);
  console.log(`Window 2 warmup: ${w2WarmupBars} bars (~${Math.round(w2WarmupBars/96)}d) before Mar 15`);
  if (w1WarmupBars < 100) console.log(`WARNING: window 1 has very little warmup`);
  if (w2WarmupBars < 100) console.log(`WARNING: window 2 has very little warmup`);

  for (const [label, ws, we] of [["WINDOW 1: Feb 1 → Mar 15", W1_START, W1_END], ["WINDOW 2: Mar 15 → Apr 27", W2_START, W2_END]] as const) {
    console.log(`\n══ ${label} ══`);
    console.log(`  ${"variant".padEnd(54)}  trades  WR    expR    P&L $    qualifies?`);
    for (const v of variants) {
      const row = await runWindowedVariant(v, candles, ws, we);
      const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
      console.log(
        `  ${row.variant.padEnd(54)}  ${String(row.trades).padStart(3)}    ${wr.padStart(3)}   ${(row.expR >= 0 ? "+" : "") + row.expR.toFixed(2)}R   ${(row.pnlUsd >= 0 ? "+" : "") + "$" + row.pnlUsd.toFixed(2)}   ${row.qualifies ? "  ✓" : ""}`,
      );
    }
  }
  return;
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

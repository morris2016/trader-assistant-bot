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
  filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number; skipDaysOfWeekUtc: number[]; buyOnly: boolean; sellOnly: boolean; dynamicSideBySma: number }>;
};

// Final base = lbBars=45 + stopBuf=0.25 + eqTol=0.15 + cw=6 + sellOnly + 4:1 + swing1
const W = (over: Record<string, number> = {}) =>
  basePs({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6, stopBufferAtrMul: 0.25, equalToleranceAtrMul: 0.15, lookbackBars: 45, ...over });

// 15m TF: 96 bars/day. SMA values scaled accordingly.
const variants: Variant[] = [
  // CONTROL: 15m baselines
  { name: "CTRL: tuned · sellOnly",                       params: W(),                                                       filters: { sellOnly: true } },
  { name: "CTRL: tuned · buyOnly",                        params: W(),                                                       filters: { buyOnly: true } },
  { name: "CTRL: tuned · no filter",                      params: W(),                                                       filters: {} },
  // DYN — SMA in BARS (96/day at 15m). Sweep across 1d-30d trend windows.
  { name: "DYN sma=96 (1d)",                              params: W(),                                                       filters: { dynamicSideBySma: 96 } },
  { name: "DYN sma=192 (2d)",                             params: W(),                                                       filters: { dynamicSideBySma: 192 } },
  { name: "DYN sma=384 (4d)",                             params: W(),                                                       filters: { dynamicSideBySma: 384 } },
  { name: "DYN sma=672 (1w)",                             params: W(),                                                       filters: { dynamicSideBySma: 672 } },
  { name: "DYN sma=1344 (2w)",                            params: W(),                                                       filters: { dynamicSideBySma: 1344 } },
  { name: "DYN sma=1920 (20d)",                           params: W(),                                                       filters: { dynamicSideBySma: 1920 } },
  { name: "DYN sma=2880 (30d) — winner on 1h",            params: W(),                                                       filters: { dynamicSideBySma: 2880 } },
  // R:R variations on 15m best
  { name: "DYN sma=2880 · 3:1",                           params: W({ targetRMult: 3.0 }),                                   filters: { dynamicSideBySma: 2880 } },
  { name: "DYN sma=2880 · 5:1",                           params: W({ targetRMult: 5.0 }),                                   filters: { dynamicSideBySma: 2880 } },
  { name: "DYN sma=672 · 3:1",                            params: W({ targetRMult: 3.0 }),                                   filters: { dynamicSideBySma: 672 } },
  { name: "DYN sma=1344 · 3:1",                           params: W({ targetRMult: 3.0 }),                                   filters: { dynamicSideBySma: 1344 } },
];

// Window: Dec 1, 2025 → Feb 28, 2026 (~90 days). With ~30d warm-up before Dec 1.
// Trades fired during warm-up are filtered out; only Dec 1 - Feb 28 count.
const WINDOW_START_EPOCH = Math.floor(new Date('2025-12-01T00:00:00Z').getTime() / 1000);
const WINDOW_END_EPOCH = Math.floor(new Date('2026-03-01T00:00:00Z').getTime() / 1000); // exclusive

async function main() {
  const c = new C(); await c.ready;
  console.log(`[ltc-sweep-decfeb] Symbol: Litecoin / USD (cryLTCUSD) · cost ${COST_BPS} bps`);
  console.log(`Window: 2025-12-01 → 2026-02-28 (~90d) with warm-up before window start\n`);

  // 15m TF — 90d window = 8640 bars + ~1 month warmup = up to 12000 bars.
  const allCandles = await fetchPaged(c, SYMBOL, 900, 12000);
  c.close();
  if (allCandles.length < 200) { console.log(`only ${allCandles.length} bars`); return; }

  // Find the index slice ending at Feb 28, 2026 (inclusive of bars before that date)
  let windowEndIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < WINDOW_END_EPOCH) { windowEndIdx = i; break; }
  }
  // Slice candles from beginning to window end. Warm-up = all bars before WINDOW_START.
  const candles = allCandles.slice(0, windowEndIdx + 1);
  const warmupBars = candles.filter((cn) => cn.epoch < WINDOW_START_EPOCH).length;
  const windowBars = candles.length - warmupBars;
  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const winStartDate = new Date(WINDOW_START_EPOCH * 1000).toISOString().slice(0, 10);
  const winEndDate = new Date(candles[candles.length - 1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`Total candles fetched: ${allCandles.length} bars (data: ${fromDate} → ${new Date(allCandles[allCandles.length-1].epoch*1000).toISOString().slice(0,10)})`);
  console.log(`Warm-up: ${warmupBars} bars (~${Math.round(warmupBars/96)}d) from ${fromDate} → ${winStartDate}`);
  console.log(`Trade window: ${windowBars} bars (~${Math.round(windowBars/96)}d) from ${winStartDate} → ${winEndDate}`);
  console.log(`══ Trades counted only if epoch ≥ ${WINDOW_START_EPOCH} (Dec 1, 2025 UTC) ══\n`);
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
      symbol: SYMBOL, granularity: 900 as any, count: candles.length,
      atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
      ...v.filters,
      detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, candles);
    // Filter trades: only count those opened within the trade window
    const inWindow = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= WINDOW_START_EPOCH);
    const wins = inWindow.filter((t) => t.pnlPct > 0).length;
    let totalR = 0, pnlUsd = 0;
    for (const t of inWindow) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totalR += t.pnlPct / risk;
      pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
    }
    const expR = inWindow.length ? totalR / inWindow.length : 0;
    const qualifies = inWindow.length >= MIN_TRADES && pnlUsd >= MIN_PNL_USD;
    rows.push({ name: v.name, trades: inWindow.length, wins, expR, pnlUsd });
    const wr = inWindow.length ? `${(100*wins/inWindow.length).toFixed(0)}%` : "—";
    console.log(`  ${v.name.padEnd(58)}  ${String(inWindow.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}    ${qualifies ? "  ✓" : ""}`);
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

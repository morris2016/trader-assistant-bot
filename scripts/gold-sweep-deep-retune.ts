// Deep retune of gold_sweep with broader variant search.
// 3-window validation (W0/TRAIN/TEST). If no variant achieves combined $500+
// with all windows positive, the strategy gets dropped.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAUUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, any>();
  ready: Promise<void>;
  constructor() { this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); const id = m.req_id;
      if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(p: any): Promise<any> { const id = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id })); setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
  close() { this.ws.close(); } }

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(5000, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

function basePs(over: any = {}) {
  return { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 1, stopBufferAtrMul: 0.1, ...over };
}

type Variant = { name: string; params: any; filters: any };
const variants: Variant[] = [
  // Phase A: ICT vs confirm baseline
  { name: "ICT 3:1",                                       params: basePs(),                                                 filters: {} },
  { name: "confirm 3:1",                                   params: basePs({ entryOnSweep: 0 }),                              filters: {} },
  // Phase B: side bias
  { name: "ICT 3:1 + BUY",                                 params: basePs(),                                                 filters: { buyOnly: true } },
  { name: "ICT 3:1 + SELL",                                params: basePs(),                                                 filters: { sellOnly: true } },
  { name: "confirm 3:1 + BUY",                             params: basePs({ entryOnSweep: 0 }),                              filters: { buyOnly: true } },
  { name: "confirm 3:1 + SELL",                            params: basePs({ entryOnSweep: 0 }),                              filters: { sellOnly: true } },
  // Phase C: R:R sweep at BUY
  { name: "ICT 4:1 + BUY",                                 params: basePs({ targetRMult: 4.0 }),                             filters: { buyOnly: true } },
  { name: "ICT 5:1 + BUY",                                 params: basePs({ targetRMult: 5.0 }),                             filters: { buyOnly: true } },
  { name: "confirm 4:1 + BUY",                             params: basePs({ entryOnSweep: 0, targetRMult: 4.0 }),            filters: { buyOnly: true } },
  { name: "confirm 5:1 + BUY",                             params: basePs({ entryOnSweep: 0, targetRMult: 5.0 }),            filters: { buyOnly: true } },
  // Phase D: ADX gates
  { name: "ICT 3:1 + minAdx=22",                           params: basePs(),                                                 filters: { minAdx: 22 } },
  { name: "ICT 3:1 + minAdx=24",                           params: basePs(),                                                 filters: { minAdx: 24 } },
  { name: "ICT 3:1 + maxAdx=22 (ranging)",                 params: basePs(),                                                 filters: { maxAdx: 22 } },
  { name: "ICT 3:1 + maxAdx=40",                           params: basePs(),                                                 filters: { maxAdx: 40 } },
  { name: "ICT 4:1 + minAdx=22",                           params: basePs({ targetRMult: 4.0 }),                             filters: { minAdx: 22 } },
  // Phase E: with-trend
  { name: "ICT 3:1 + with-trend@20",                       params: basePs(),                                                 filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "ICT 4:1 + with-trend@20",                       params: basePs({ targetRMult: 4.0 }),                             filters: { withTrendOnlyAboveAdx: 20 } },
  // Phase F: swing variations
  { name: "ICT 3:1 + swing1",                              params: basePs({ swingLeft: 1, swingRight: 1 }),                  filters: {} },
  { name: "ICT 3:1 + swing1 + BUY",                        params: basePs({ swingLeft: 1, swingRight: 1 }),                  filters: { buyOnly: true } },
  { name: "ICT 4:1 + swing1 + BUY",                        params: basePs({ swingLeft: 1, swingRight: 1, targetRMult: 4.0 }),filters: { buyOnly: true } },
  { name: "confirm 3:1 + swing1 + BUY",                    params: basePs({ entryOnSweep: 0, swingLeft: 1, swingRight: 1 }), filters: { buyOnly: true } },
  // Phase G: combined ranging+side
  { name: "ICT 3:1 + maxAdx=22 + BUY",                     params: basePs(),                                                 filters: { maxAdx: 22, buyOnly: true } },
  { name: "ICT 3:1 + minAdx=22 + BUY",                     params: basePs(),                                                 filters: { minAdx: 22, buyOnly: true } },
  // Phase H: tight stops vs loose
  { name: "ICT 3:1 + BUY + stopBuf=0.05",                  params: basePs({ stopBufferAtrMul: 0.05 }),                       filters: { buyOnly: true } },
  { name: "ICT 3:1 + BUY + stopBuf=0.2",                   params: basePs({ stopBufferAtrMul: 0.2 }),                        filters: { buyOnly: true } },
  // Phase I: pool params
  { name: "ICT 3:1 + BUY + lbBars=100",                    params: basePs({ lookbackBars: 100 }),                            filters: { buyOnly: true } },
  { name: "ICT 3:1 + BUY + lbBars=30",                     params: basePs({ lookbackBars: 30 }),                             filters: { buyOnly: true } },
  // Phase J: minEqual=3 (stricter pools)
  { name: "ICT 3:1 + minEqual=3",                          params: basePs({ minEqualCount: 3 }),                             filters: {} },
  { name: "ICT 3:1 + minEqual=3 + BUY",                    params: basePs({ minEqualCount: 3 }),                             filters: { buyOnly: true } },
  // Phase K: dynamicSideBySma (regime auto-flip)
  { name: "ICT 3:1 + dynSma=72 (3d)",                      params: basePs(),                                                 filters: { dynamicSideBySma: 72 } },
  { name: "ICT 3:1 + dynSma=168 (1w)",                     params: basePs(),                                                 filters: { dynamicSideBySma: 168 } },
  { name: "ICT 3:1 + dynSma=336 (2w)",                     params: basePs(),                                                 filters: { dynamicSideBySma: 336 } },
  { name: "ICT 3:1 + dynSma=720 (30d)",                    params: basePs(),                                                 filters: { dynamicSideBySma: 720 } },
  { name: "ICT 4:1 + dynSma=336",                          params: basePs({ targetRMult: 4.0 }),                             filters: { dynamicSideBySma: 336 } },
];

async function runWindow(v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number) {
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? v.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL as any, granularity: 3600 as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  const inWin = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  return { trades: inWin.length, wins, expR, pnlUsd };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Fetching Gold 1h ...`);
  const candles = await fetchPaged(c, SYMBOL, 3600, 4000);
  c.close();
  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`Got ${candles.length} 1h bars (${fromDate} → ${toDate})\n`);

  const latest = candles[candles.length-1].epoch;
  const TEST_END = latest + 1; const TEST_START = TEST_END - 27 * 86400;
  const TRAIN_END = TEST_START; const TRAIN_START = TRAIN_END - 60 * 86400;
  const W0_END = TRAIN_START; const W0_START = W0_END - 45 * 86400;
  console.log(`W0: ${new Date(W0_START*1000).toISOString().slice(0,10)} → ${new Date(W0_END*1000).toISOString().slice(0,10)} (45d)`);
  console.log(`TRAIN: ${new Date(TRAIN_START*1000).toISOString().slice(0,10)} → ${new Date(TRAIN_END*1000).toISOString().slice(0,10)} (60d)`);
  console.log(`TEST: ${new Date(TEST_START*1000).toISOString().slice(0,10)} → ${new Date(TEST_END*1000).toISOString().slice(0,10)} (27d)\n`);

  console.log(`  ${"variant".padEnd(58)}  W0           TRAIN        TEST         passes?`);
  type Row = { name: string; w0: any; tr: any; te: any; passes: boolean; total: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const w0 = await runWindow(v, candles, W0_START, W0_END);
    const tr = await runWindow(v, candles, TRAIN_START, TRAIN_END);
    const te = await runWindow(v, candles, TEST_START, TEST_END);
    const passes = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0 && (w0.trades + tr.trades + te.trades) >= 20;
    const total = w0.pnlUsd + tr.pnlUsd + te.pnlUsd;
    rows.push({ name: v.name, w0, tr, te, passes, total });
    const fmt = (r: any) => `${(r.pnlUsd>=0?"+":"")}$${r.pnlUsd.toFixed(0).padStart(5)}(${String(r.trades).padStart(2)}t)`;
    console.log(`  ${v.name.padEnd(58)}  ${fmt(w0)}   ${fmt(tr)}   ${fmt(te)}   ${passes?"✓":"✗"}`);
  }

  const passing = rows.filter((r) => r.passes).sort((a, b) => b.total - a.total);
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  if (passing.length === 0) {
    console.log(`❌ NO 3-window passers — gold_sweep should be DROPPED`);
    console.log(`Best by combined $ (any window may be negative):`);
    rows.sort((a, b) => b.total - a.total);
    for (const r of rows.slice(0, 5)) {
      console.log(`  ${r.name.padEnd(58)} combined $${r.total.toFixed(0)} (W0/TRAIN/TEST: $${r.w0.pnlUsd.toFixed(0)}/$${r.tr.pnlUsd.toFixed(0)}/$${r.te.pnlUsd.toFixed(0)})`);
    }
  } else {
    console.log(`✓ ${passing.length} passing variants. Top 5 by combined $:`);
    for (const r of passing.slice(0, 5)) {
      console.log(`  ${r.name.padEnd(58)} combined $${r.total.toFixed(0)} (W0/TRAIN/TEST: $${r.w0.pnlUsd.toFixed(0)}/$${r.tr.pnlUsd.toFixed(0)}/$${r.te.pnlUsd.toFixed(0)})`);
    }
    const top = passing[0];
    console.log(`\nWinner: ${top.name}`);
    console.log(`  Combined: $${top.total.toFixed(0)} over ~132d`);
    console.log(`  STRONG threshold ($500+): ${top.total >= 500 ? "✓ YES" : "✗ NO (WEAK tier)"}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

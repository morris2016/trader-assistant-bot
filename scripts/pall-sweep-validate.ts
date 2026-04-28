// Palladium Sweep 3-window cross-validation.
// Config under test: liquiditySweep with stopBufferAtrMul=0.25, targetRMult=4, defaults elsewhere.
// Pass criteria: all 3 windows positive, ≥5 trades per window, combined ≥ $500 STRONG threshold.
// Also validates 3 nearby configs to confirm parameter robustness.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXPDUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const GR = 3600;
const FETCH = 4000;
const MIN_TRADES_PER_WINDOW = 5;
const STRONG_THRESHOLD = 500;

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
    let r: any = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); break; }
      catch (e) { if (attempt === 5) throw e; await new Promise((res) => setTimeout(res, 3000 + attempt * 2000)); }
    }
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

function swParams(over: any = {}) {
  return { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 0, stopBufferAtrMul: 0.1, ...over };
}

type Config = { name: string; params: any; filters: any };
const configs: Config[] = [
  { name: "PRIMARY: stopBuf=0.25·4:1",        params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.25 }), filters: {} },
  { name: "robustness: stopBuf=0.25·3:1",     params: swParams({ stopBufferAtrMul: 0.25 }),                filters: {} },
  { name: "robustness: stopBuf=0.30·4:1",     params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.30 }), filters: {} },
  { name: "robustness: stopBuf=0.35·4:1",     params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.35 }), filters: {} },
];

async function runWindow(cfg: Config, candles: Candle[], windowStart: number, windowEnd: number) {
  let endIdx = candles.length - 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const subset = candles.slice(0, endIdx + 1);
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? cfg.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL as any, granularity: GR as any, count: subset.length,
    atrSlMult: 1.0, atrTpMult: cfg.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...cfg.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, subset);
  const inWin = r.trades.filter((t) => subset[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  const wr = inWin.length ? wins / inWin.length : 0;
  return { trades: inWin.length, wins, wr, expR, pnlUsd };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Palladium/USD Sweep 3-window cross-validation\n`);
  process.stdout.write("");

  const candles = await fetchPaged(c, SYMBOL, GR, FETCH);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars`); return; }

  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  const totalDays = (candles[candles.length-1].epoch - candles[0].epoch) / 86400;
  console.log(`${candles.length} bars · ${fromDate} → ${toDate} (${totalDays.toFixed(0)}d)`);

  let testD: number, trainD: number, w0D: number;
  if (totalDays >= 200) { testD = 27; trainD = 90; w0D = 90; }
  else if (totalDays >= 130) { testD = 21; trainD = 60; w0D = 45; }
  else if (totalDays >= 80) { testD = 14; trainD = 45; w0D = 21; }
  else { testD = 10; trainD = 21; w0D = 9; }

  const latest = candles[candles.length-1].epoch;
  const TEST_END = latest + 1; const TEST_START = TEST_END - testD * 86400;
  const TRAIN_END = TEST_START; const TRAIN_START = TRAIN_END - trainD * 86400;
  const W0_END = TRAIN_START; const W0_START = W0_END - w0D * 86400;
  const w0Available = candles[0].epoch <= W0_START;

  const fmtDate = (ep: number) => new Date(ep * 1000).toISOString().slice(0, 10);
  console.log(`W0:    ${fmtDate(W0_START)} → ${fmtDate(W0_END)} (${w0D}d, ${w0Available?"✓":"⚠ partial"})`);
  console.log(`TRAIN: ${fmtDate(TRAIN_START)} → ${fmtDate(TRAIN_END)} (${trainD}d)`);
  console.log(`TEST:  ${fmtDate(TEST_START)} → ${fmtDate(TEST_END)} (${testD}d, OOS)\n`);
  process.stdout.write("");

  const results: any[] = [];
  for (const cfg of configs) {
    const w0 = await runWindow(cfg, candles, W0_START, W0_END);
    const tr = await runWindow(cfg, candles, TRAIN_START, TRAIN_END);
    const te = await runWindow(cfg, candles, TEST_START, TEST_END);
    const enoughTrades = w0.trades >= MIN_TRADES_PER_WINDOW && tr.trades >= MIN_TRADES_PER_WINDOW && te.trades >= MIN_TRADES_PER_WINDOW;
    const allPositive = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
    const total = w0.pnlUsd + tr.pnlUsd + te.pnlUsd;
    const passes = enoughTrades && allPositive;
    const strong = passes && total >= STRONG_THRESHOLD;
    results.push({ cfg, w0, tr, te, total, passes, strong });

    const fmt = (x: any) => `${(x.pnlUsd>=0?"+":"")}$${x.pnlUsd.toFixed(0).padStart(4)}(${String(x.trades).padStart(2)}t,${(x.wr*100).toFixed(0).padStart(2)}%WR,${(x.expR>=0?"+":"")}${x.expR.toFixed(2)}R)`;
    console.log(`──────────────────────────────────────────────────────────────────────────────`);
    console.log(`${cfg.name}`);
    console.log(`  W0    ${fmt(w0)}`);
    console.log(`  TRAIN ${fmt(tr)}`);
    console.log(`  TEST  ${fmt(te)}  ← OOS`);
    console.log(`  combined: ${total>=0?"+":""}$${total.toFixed(0)}  ${passes?"✓ PASSES 3-window":"✗ FAILS"}  ${strong?"★ STRONG (≥$500)":""}`);
    process.stdout.write("");
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`VERDICT`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  const primary = results[0];
  if (primary.strong) {
    console.log(`✓✓ PRIMARY config PASSES STRONG threshold — register as palladium_sweep.`);
  } else if (primary.passes) {
    console.log(`✓ PRIMARY config passes 3-window CV but combined $${primary.total.toFixed(0)} < $${STRONG_THRESHOLD} STRONG threshold.`);
  } else {
    console.log(`✗ PRIMARY config FAILS 3-window CV.`);
  }
  const robustPasses = results.slice(1).filter((r) => r.passes).length;
  console.log(`Parameter robustness: ${robustPasses}/${results.length-1} nearby configs also pass 3-window CV.`);
}

main().catch((e) => { console.error(e); process.exit(1); });

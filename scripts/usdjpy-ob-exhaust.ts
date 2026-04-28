// USD/JPY OB exhaustive search.
// TFs: 5m, 10m, 15m, 30m, 1h, 4h
// Per TF: ~35 variants × 3 windows (W0/TRAIN/TEST)
// Goal: find ANY TF/config that passes 3-window OOS, or definitively reject.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxUSDJPY";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const MIN_TRADES_PER_WINDOW = 5;
const MIN_COMBINED_USD = 200;

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

function obParams(over: any = {}) {
  return {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
    ...over,
  };
}

type Variant = { name: string; params: any; filters: any };

// Comprehensive variant set tailored for USD/JPY (JPY pairs: ~0.5-1% daily ranges, slow trends)
function variantsFor(): Variant[] {
  const vs: Variant[] = [];
  // Phase A: R:R sweep on baseline
  for (const r of [2, 3, 4, 5, 6]) vs.push({ name: `loose·${r}:1`, params: obParams({ targetRMult: r }), filters: {} });
  // Phase B: Side bias × R:R
  for (const side of ["BUY", "SELL"]) for (const r of [3, 4, 5]) {
    const f = side === "BUY" ? { buyOnly: true } : { sellOnly: true };
    vs.push({ name: `loose·${r}:1+${side}`, params: obParams({ targetRMult: r }), filters: f });
  }
  // Phase C: ADX gates
  for (const min of [18, 22, 24, 26]) vs.push({ name: `loose·3:1+minAdx=${min}`, params: obParams(), filters: { minAdx: min } });
  for (const max of [22, 30, 40, 50]) vs.push({ name: `loose·3:1+maxAdx=${max}`, params: obParams(), filters: { maxAdx: max } });
  vs.push({ name: "withTrend@20", params: obParams(), filters: { withTrendOnlyAboveAdx: 20 } });
  vs.push({ name: "withTrend@22", params: obParams(), filters: { withTrendOnlyAboveAdx: 22 } });
  // Phase D: Displacement strictness
  for (const d of [0.5, 0.6, 1.0, 1.2, 1.5]) vs.push({ name: `disp${d}·3:1`, params: obParams({ displacementAtrMultiplier: d }), filters: {} });
  // Phase E: Entry depth
  vs.push({ name: "ce·3:1", params: obParams({ entryDepth: 1 }), filters: {} });
  vs.push({ name: "ce·4:1", params: obParams({ entryDepth: 1, targetRMult: 4 }), filters: {} });
  vs.push({ name: "far·3:1", params: obParams({ entryDepth: 2 }), filters: {} });
  // Phase F: requireFVG / quality
  vs.push({ name: "+FVG·3:1", params: obParams({ requireFVG: 1 }), filters: {} });
  vs.push({ name: "+FVG·4:1", params: obParams({ requireFVG: 1, targetRMult: 4 }), filters: {} });
  vs.push({ name: "+FVG·3:1+disp0.6", params: obParams({ requireFVG: 1, displacementAtrMultiplier: 0.6 }), filters: {} });
  vs.push({ name: "+FVG·3:1+rejBody=0.5", params: obParams({ requireFVG: 1, rejectionBodyAtrMul: 0.5 }), filters: {} });
  // Phase G: lookback / obSearch
  for (const l of [6, 8, 16]) vs.push({ name: `loose·3:1+lb=${l}`, params: obParams({ lookback: l }), filters: {} });
  for (const ob of [5, 8]) vs.push({ name: `loose·3:1+obSearch=${ob}`, params: obParams({ obSearchMaxBack: ob }), filters: {} });
  // Phase H: Combined champions
  vs.push({ name: "minAdx=22+ce·4:1", params: obParams({ entryDepth: 1, targetRMult: 4 }), filters: { minAdx: 22 } });
  vs.push({ name: "+FVG+minAdx=22·4:1", params: obParams({ requireFVG: 1, targetRMult: 4 }), filters: { minAdx: 22 } });
  vs.push({ name: "minAdx=22+BUY·4:1", params: obParams({ targetRMult: 4 }), filters: { minAdx: 22, buyOnly: true } });
  vs.push({ name: "minAdx=22+SELL·4:1", params: obParams({ targetRMult: 4 }), filters: { minAdx: 22, sellOnly: true } });
  vs.push({ name: "withTrend@20+ce·5:1", params: obParams({ entryDepth: 1, targetRMult: 5 }), filters: { withTrendOnlyAboveAdx: 20 } });
  return vs;
}

async function runWindow(v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number, gr: number) {
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? v.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL as any, granularity: gr as any, count: candles.length,
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

const TFS = [
  { gr: 300,   label: "5m",   barsPerDay: 288, fetchCount: 9000 },   // ~31d
  { gr: 600,   label: "10m",  barsPerDay: 144, fetchCount: 9000 },   // ~62d
  { gr: 900,   label: "15m",  barsPerDay: 96,  fetchCount: 12000 },  // ~125d
  { gr: 1800,  label: "30m",  barsPerDay: 48,  fetchCount: 8000 },   // ~166d
  { gr: 3600,  label: "1h",   barsPerDay: 24,  fetchCount: 5000 },   // ~208d
  { gr: 14400, label: "4h",   barsPerDay: 6,   fetchCount: 3000 },   // ~500d
];

async function main() {
  const c = new C(); await c.ready;
  const overall: { tf: string; passers: number; bestVariant?: string; bestCombined?: number; details: string[] }[] = [];
  const variants = variantsFor();
  console.log(`Testing ${variants.length} variants × ${TFS.length} TFs = ${variants.length * TFS.length} configs\n`);

  for (const tf of TFS) {
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`TIMEFRAME: ${tf.label} (granularity ${tf.gr}s)`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    let candles: Candle[];
    try {
      candles = await fetchPaged(c, SYMBOL, tf.gr, tf.fetchCount);
    } catch (e) {
      console.log(`  fetch error: ${(e as Error).message} — skipping`);
      overall.push({ tf: tf.label, passers: 0, details: [] });
      continue;
    }
    if (candles.length < 200) {
      console.log(`  only ${candles.length} bars — skipping`);
      overall.push({ tf: tf.label, passers: 0, details: [] });
      continue;
    }
    const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
    const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
    const totalDays = (candles[candles.length-1].epoch - candles[0].epoch) / 86400;
    console.log(`Got ${candles.length} bars (${fromDate} → ${toDate}, ${totalDays.toFixed(0)}d)`);

    // Window sizes scale by TF availability
    let testD = 27, trainD = 60, w0D = 45;
    if (totalDays >= 200) { testD = 27; trainD = 90; w0D = 90; }
    else if (totalDays >= 130) { testD = 21; trainD = 60; w0D = 45; }
    else if (totalDays >= 80) { testD = 14; trainD = 45; w0D = 21; }
    else if (totalDays >= 40) { testD = 10; trainD = 21; w0D = 9; }
    else { testD = 7; trainD = 14; w0D = 7; }

    const latest = candles[candles.length-1].epoch;
    const TEST_END = latest + 1; const TEST_START = TEST_END - testD * 86400;
    const TRAIN_END = TEST_START; const TRAIN_START = TRAIN_END - trainD * 86400;
    const W0_END = TRAIN_START; const W0_START = W0_END - w0D * 86400;
    console.log(`Windows: W0 ${w0D}d · TRAIN ${trainD}d · TEST ${testD}d`);
    if (candles[0].epoch > W0_START) console.log(`  ⚠ W0 partial — data starts ${new Date(candles[0].epoch*1000).toISOString().slice(0,10)}`);
    console.log(``);

    const rows: { name: string; w0: any; tr: any; te: any; passes: boolean; total: number }[] = [];
    for (const v of variants) {
      const w0 = await runWindow(v, candles, W0_START, W0_END, tf.gr);
      const tr = await runWindow(v, candles, TRAIN_START, TRAIN_END, tf.gr);
      const te = await runWindow(v, candles, TEST_START, TEST_END, tf.gr);
      const enoughTrades = w0.trades >= MIN_TRADES_PER_WINDOW && tr.trades >= MIN_TRADES_PER_WINDOW && te.trades >= MIN_TRADES_PER_WINDOW;
      const allPositive = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
      const total = w0.pnlUsd + tr.pnlUsd + te.pnlUsd;
      const passes = enoughTrades && allPositive;
      rows.push({ name: v.name, w0, tr, te, passes, total });
    }
    rows.sort((a, b) => b.total - a.total);
    const top = rows[0];
    const passers = rows.filter((r) => r.passes);
    console.log(`  Top 5 by combined $:`);
    for (const r of rows.slice(0, 5)) {
      const fmt = (x: any) => `${(x.pnlUsd>=0?"+":"")}$${x.pnlUsd.toFixed(0).padStart(4)}(${String(x.trades).padStart(2)}t)`;
      console.log(`    ${r.passes ? "✓" : " "} ${r.name.padEnd(30)} W0 ${fmt(r.w0)}  TRAIN ${fmt(r.tr)}  TEST ${fmt(r.te)}  combined ${(r.total>=0?"+":"")}$${r.total.toFixed(0)}`);
    }
    console.log(`  Passers (3-window+): ${passers.length}${passers.length > 0 ? ` — top: ${passers[0].name} ($${passers[0].total.toFixed(0)})` : ""}`);
    overall.push({ tf: tf.label, passers: passers.length, bestVariant: passers[0]?.name, bestCombined: passers[0]?.total, details: passers.slice(0, 3).map((p) => `${p.name} $${p.total.toFixed(0)}`) });
    console.log(``);
  }
  c.close();

  console.log(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  USD/JPY OB EXHAUSTIVE SEARCH — FINAL VERDICT                                 ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  for (const o of overall) {
    if (o.passers > 0) {
      console.log(`  ${o.tf.padEnd(4)} ✓ ${o.passers} passers — best: ${o.bestVariant} ($${o.bestCombined?.toFixed(0)})`);
    } else {
      console.log(`  ${o.tf.padEnd(4)} ✗ no 3-window passers`);
    }
  }
  const totalPassers = overall.reduce((s, o) => s + o.passers, 0);
  console.log(``);
  if (totalPassers === 0) {
    console.log(`❌ USD/JPY OB exhausted across all 6 TFs — DROP. Forex SMC OB is structurally too sparse.`);
  } else {
    const best = overall.filter((o) => o.passers > 0).sort((a, b) => (b.bestCombined ?? 0) - (a.bestCombined ?? 0))[0];
    console.log(`✓ Best across all TFs: ${best.tf} / ${best.bestVariant} (combined $${best.bestCombined?.toFixed(0)})`);
    if ((best.bestCombined ?? 0) >= 500) console.log(`   STRONG threshold met — register.`);
    else console.log(`   ⚠ Below $500 STRONG threshold — drop or treat as marginal.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

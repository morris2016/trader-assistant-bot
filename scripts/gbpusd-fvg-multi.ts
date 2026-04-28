// GBP/USD FVG multi-TF tiered search.
// FVG has been the strongest detector across registry (Silver, Gold, Plat all FVG).
// Tier 1: 15m, 30m, 1h. Variants: minGap sweep (Silver winner=0.7, Gold=default, Plat=default+adx),
// R:R sweep, ADX gates, BUY/SELL bias, GBP-specific stopBuffer/rejection tweaks.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxGBPUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const MIN_TRADES_PER_WINDOW = 5;

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

function fvgParams(over: any = {}) {
  return { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12,
    targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0, ...over };
}

type Variant = { name: string; params: any; filters: any };
const tier1Variants: Variant[] = [
  // Phase A: minGap sweep (default 0.15 → Silver winner 0.7)
  { name: "minGap=0.15·3:1 (default)",     params: fvgParams(),                                   filters: {} },
  { name: "minGap=0.30·3:1",               params: fvgParams({ minGapAtrMul: 0.30 }),             filters: {} },
  { name: "minGap=0.50·3:1",               params: fvgParams({ minGapAtrMul: 0.50 }),             filters: {} },
  { name: "minGap=0.70·3:1 (Silver)",      params: fvgParams({ minGapAtrMul: 0.70 }),             filters: {} },
  // Phase B: R:R sweep
  { name: "minGap=0.15·4:1",               params: fvgParams({ targetRMult: 4 }),                 filters: {} },
  { name: "minGap=0.30·4:1",               params: fvgParams({ minGapAtrMul: 0.30, targetRMult: 4 }), filters: {} },
  { name: "minGap=0.50·4:1",               params: fvgParams({ minGapAtrMul: 0.50, targetRMult: 4 }), filters: {} },
  { name: "minGap=0.15·5:1",               params: fvgParams({ targetRMult: 5 }),                 filters: {} },
  // Phase C: BUY/SELL bias (Gold/Plat were BUY-only)
  { name: "BUY·4:1",                       params: fvgParams({ targetRMult: 4 }),                 filters: { buyOnly: true } },
  { name: "SELL·4:1",                      params: fvgParams({ targetRMult: 4 }),                 filters: { sellOnly: true } },
  { name: "BUY·4:1·minGap=0.30",           params: fvgParams({ minGapAtrMul: 0.30, targetRMult: 4 }), filters: { buyOnly: true } },
  { name: "SELL·4:1·minGap=0.30",          params: fvgParams({ minGapAtrMul: 0.30, targetRMult: 4 }), filters: { sellOnly: true } },
  // Phase D: ADX gates (Gold winner: minAdx=24)
  { name: "minAdx=22·3:1",                 params: fvgParams(),                                   filters: { minAdx: 22 } },
  { name: "minAdx=24·3:1 (Gold)",          params: fvgParams(),                                   filters: { minAdx: 24 } },
  { name: "minAdx=22·4:1",                 params: fvgParams({ targetRMult: 4 }),                 filters: { minAdx: 22 } },
  { name: "maxAdx=22·3:1 (ranging)",       params: fvgParams(),                                   filters: { maxAdx: 22 } },
  { name: "withTrend@20·3:1",              params: fvgParams(),                                   filters: { withTrendOnlyAboveAdx: 20 } },
  // Phase E: ce (entryDepth=1) variants
  { name: "ce·3:1",                        params: fvgParams({ entryDepth: 1 }),                  filters: {} },
  { name: "ce·4:1",                        params: fvgParams({ entryDepth: 1, targetRMult: 4 }),  filters: {} },
  // Phase F: GBP-specific (wider stop, requireRejection for news survival)
  { name: "GBP: wideBuf·3:1",              params: fvgParams({ stopBufferAtrMul: 0.2 }),          filters: {} },
  { name: "GBP: wideBuf+rej·4:1",          params: fvgParams({ stopBufferAtrMul: 0.2, requireRejection: 1, targetRMult: 4 }), filters: {} },
  { name: "GBP: rej·3:1",                  params: fvgParams({ requireRejection: 1 }),            filters: {} },
  { name: "GBP: minGap=0.50+rej·4:1",      params: fvgParams({ minGapAtrMul: 0.50, requireRejection: 1, targetRMult: 4 }), filters: {} },
];

async function runWindow(v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number, gr: number) {
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "fvg",
    params: d.id === "fvg" ? v.params : d.params,
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
  { gr: 3600,  label: "1h",   fetchCount: 5000 },
];

async function main() {
  const c = new C(); await c.ready;
  console.log(`GBP/USD FVG tier-1 search · ${tier1Variants.length} variants × ${TFS.length} TFs\n`);
  process.stdout.write("");

  const overall: { tf: string; passers: any[]; topByCombined: any[] }[] = [];

  for (const tf of TFS) {
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`TF: ${tf.label}`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    process.stdout.write("");
    let candles: Candle[];
    try { candles = await fetchPaged(c, SYMBOL, tf.gr, tf.fetchCount); }
    catch (e) { console.log(`  fetch error — skipping`); overall.push({ tf: tf.label, passers: [], topByCombined: [] }); continue; }
    if (candles.length < 200) { console.log(`  only ${candles.length} bars — skipping`); overall.push({ tf: tf.label, passers: [], topByCombined: [] }); continue; }

    const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
    const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
    const totalDays = (candles[candles.length-1].epoch - candles[0].epoch) / 86400;
    console.log(`  ${candles.length} bars (${fromDate} → ${toDate}, ${totalDays.toFixed(0)}d)`);
    process.stdout.write("");

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
    console.log(`  Windows: W0=${w0D}d (${w0Available?"✓":"⚠ partial"}) TRAIN=${trainD}d TEST=${testD}d\n`);
    process.stdout.write("");

    const rows: any[] = [];
    for (let i = 0; i < tier1Variants.length; i++) {
      const v = tier1Variants[i];
      const w0 = await runWindow(v, candles, W0_START, W0_END, tf.gr);
      const tr = await runWindow(v, candles, TRAIN_START, TRAIN_END, tf.gr);
      const te = await runWindow(v, candles, TEST_START, TEST_END, tf.gr);
      const enoughTrades = (w0Available ? w0.trades : MIN_TRADES_PER_WINDOW) >= MIN_TRADES_PER_WINDOW && tr.trades >= MIN_TRADES_PER_WINDOW && te.trades >= MIN_TRADES_PER_WINDOW;
      const allPositive = (w0Available ? w0.pnlUsd >= 0 : true) && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
      const passes = enoughTrades && allPositive;
      const total = (w0Available ? w0.pnlUsd : 0) + tr.pnlUsd + te.pnlUsd;
      rows.push({ name: v.name, w0, tr, te, passes, total });
      const fmt = (x: any) => `${(x.pnlUsd>=0?"+":"")}$${x.pnlUsd.toFixed(0).padStart(4)}(${String(x.trades).padStart(2)}t)`;
      console.log(`    [${String(i+1).padStart(2)}/${tier1Variants.length}] ${v.name.padEnd(30)} W0 ${fmt(w0)} TR ${fmt(tr)} TE ${fmt(te)} | ${passes?"✓":" "} combined ${(total>=0?"+":"")}$${total.toFixed(0)}`);
      process.stdout.write("");
    }
    rows.sort((a, b) => b.total - a.total);
    const passers = rows.filter((r) => r.passes);
    overall.push({ tf: tf.label, passers, topByCombined: rows.slice(0, 5) });
    console.log(`  → ${passers.length} 3-window passers${passers.length > 0 ? `; top: ${passers[0].name} ($${passers[0].total.toFixed(0)})` : ""}\n`);
    process.stdout.write("");
  }
  c.close();

  console.log(`╔══════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  GBP/USD FVG TIER-1 VERDICT                                                   ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════════════╝`);
  for (const o of overall) {
    if (o.passers.length > 0) {
      console.log(`  ${o.tf.padEnd(4)} ✓ ${o.passers.length} passers — best: ${o.passers[0].name} (combined $${o.passers[0].total.toFixed(0)})`);
    } else {
      const top = o.topByCombined[0];
      console.log(`  ${o.tf.padEnd(4)} ✗ no passers (best: ${top?.name ?? "—"} $${top?.total.toFixed(0) ?? 0})`);
    }
  }
  const totalPassers = overall.reduce((s, o) => s + o.passers.length, 0);
  if (totalPassers === 0) console.log(`\n❌ Tier-1 found nothing. Recommend dropping GBP/USD FVG.`);
  else {
    const best = overall.flatMap((o) => o.passers.map((p) => ({ tf: o.tf, ...p })))
                        .sort((a, b) => b.total - a.total)[0];
    console.log(`\n✓ Best: ${best.tf} / ${best.name} combined $${best.total.toFixed(0)}`);
    console.log(best.total >= 500 ? `   STRONG threshold met.` : `   ⚠ Below $500 STRONG threshold.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

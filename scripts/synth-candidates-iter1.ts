// Synthetic candidates iter-1 — broad validation across the 8 today-screener
// winners on BOTH 15m and 1h timeframes. Each asset has its OWN variant pack
// tailored to its market character (no copying between assets).
//
// Goal: pick 3 winners that hold across 3-window CV (W0 / TRAIN / TEST) on at
// least one timeframe. No-overfitting rule: must be positive in ALL 3 windows.
//
// Asset character → variant logic:
//   - CRASH 1000 / 500   : rare DOWN spikes on smooth up-drift → SELL-bias FVG, asymmetric stops
//   - JD100              : periodic up+down jumps → wider stop buffers, sweep favors jumps
//   - RDBULL             : constant up-drift → BUY-bias dominant
//   - BOOM 300N          : rare UP spikes on smooth down-drift (mirror of crash) → BUY-bias for OB
//   - stpRNG3            : fixed-step random walk → low noise, raw defaults
//   - 1HZ90V             : high-vol random walk → tight stops, fast detection
//
// Three-window CV per (asset × detector × tf): W0 Oct-Dec 25 / TRAIN Jan-Mar 26 / TEST Apr 1-28 26.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const MIN_TRADES_1H = 30;     // ~30+ trades over 3 months 1h ≈ 0.3/day
const MIN_TRADES_15M = 80;    // ~80+ trades over 3 months 15m ≈ 0.9/day

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() { this.connect(); }
  private connect() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
    this.ws.on("close", () => {
      for (const { reject } of this.pending.values()) reject(new Error("ws closed"));
      this.pending.clear();
    });
    this.ws.on("error", () => { /* close handler will fire */ });
  }
  async reconnect(): Promise<void> {
    try { this.ws.close(); } catch {}
    for (const { reject } of this.pending.values()) reject(new Error("ws reconnecting"));
    this.pending.clear();
    await new Promise((r) => setTimeout(r, 1500));
    this.connect();
    await this.ready;
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ ...p, req_id: id })); }
      catch (e) { this.pending.delete(id); reject(e as Error); return; }
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: string = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    let r: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); break; }
      catch (e) { if (attempt === 2) throw e; await new Promise((res) => setTimeout(res, 1500)); }
    }
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

// ── Detector base params (raw defaults) ──────────────────────────────────────
function fvgPs(over: Record<string, number> = {}) {
  return { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12, targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0, ...over };
}
function obPs(over: Record<string, number> = {}) {
  return { lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0, ...over };
}
function swPs(over: Record<string, number> = {}) {
  return { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 0, stopBufferAtrMul: 0.1, ...over };
}

type Variant = {
  name: string;
  detector: "orderBlock" | "fvg" | "liquiditySweep";
  params: Record<string, number>;
  filters: Partial<{ maxAdx: number; minAdx: number; buyOnly: boolean; sellOnly: boolean }>;
};

// ── Per-asset variant builders ───────────────────────────────────────────────
// Each one tailored to the asset's character. NOT generalized.

// CRASH 1000 / 500 — rare DOWN spikes, smooth up-drift. FVG fills favor longs
// off pullbacks, but the asymmetric SELL-only is also worth probing.
function crashFvgVariants(): Variant[] {
  return [
    { name: "raw·3:1",                   detector: "fvg", params: fvgPs(), filters: {} },
    { name: "minGap=0.50·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50 }), filters: {} },
    { name: "minGap=0.30·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.30 }), filters: {} },
    { name: "minGap=0.50·4:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50, targetRMult: 4 }), filters: {} },
    { name: "minGap=0.50·3:1+BUY",       detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50 }), filters: { buyOnly: true } },
    { name: "minGap=0.50·3:1+SELL",      detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50 }), filters: { sellOnly: true } },
    { name: "minGap=0.50·3:1+stopBuf=0.25", detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50, stopBufferAtrMul: 0.25 }), filters: {} },
    { name: "raw·4:1+adx[18,38]",        detector: "fvg", params: fvgPs({ targetRMult: 4 }), filters: { minAdx: 18, maxAdx: 38 } },
  ];
}

// JD100 — jump-diffusion. Sweep wins big single-day. Wide stops survive jumps.
function jumpVariants(detector: "fvg" | "liquiditySweep"): Variant[] {
  if (detector === "liquiditySweep") {
    return [
      { name: "raw·3:1",                   detector, params: swPs(), filters: {} },
      { name: "stopBuf=0.25·4:1",          detector, params: swPs({ stopBufferAtrMul: 0.25, targetRMult: 4 }), filters: {} },
      { name: "stopBuf=0.40·4:1",          detector, params: swPs({ stopBufferAtrMul: 0.40, targetRMult: 4 }), filters: {} },
      { name: "stopBuf=0.50·5:1",          detector, params: swPs({ stopBufferAtrMul: 0.50, targetRMult: 5 }), filters: {} },
      { name: "stopBuf=0.25·4:1+BUY",      detector, params: swPs({ stopBufferAtrMul: 0.25, targetRMult: 4 }), filters: { buyOnly: true } },
      { name: "stopBuf=0.25·4:1+SELL",     detector, params: swPs({ stopBufferAtrMul: 0.25, targetRMult: 4 }), filters: { sellOnly: true } },
      { name: "eqTol=0.20·4:1",            detector, params: swPs({ equalToleranceAtrMul: 0.20, targetRMult: 4 }), filters: {} },
      { name: "swingLR=3·stopBuf=0.25·4:1",detector, params: swPs({ swingLeft: 3, swingRight: 3, stopBufferAtrMul: 0.25, targetRMult: 4 }), filters: {} },
    ];
  }
  return [
    { name: "raw·3:1",                   detector, params: fvgPs(), filters: {} },
    { name: "raw·4:1",                   detector, params: fvgPs({ targetRMult: 4 }), filters: {} },
    { name: "minGap=0.30·3:1",           detector, params: fvgPs({ minGapAtrMul: 0.30 }), filters: {} },
    { name: "minGap=0.50·4:1",           detector, params: fvgPs({ minGapAtrMul: 0.50, targetRMult: 4 }), filters: {} },
    { name: "stopBuf=0.30·4:1",          detector, params: fvgPs({ stopBufferAtrMul: 0.30, targetRMult: 4 }), filters: {} },
    { name: "raw·4:1+BUY",               detector, params: fvgPs({ targetRMult: 4 }), filters: { buyOnly: true } },
    { name: "raw·4:1+SELL",              detector, params: fvgPs({ targetRMult: 4 }), filters: { sellOnly: true } },
  ];
}

// RDBULL — constant up-drift. BUY-only likely dominant. FVG fills should consistently print on pullbacks.
function bullVariants(): Variant[] {
  return [
    { name: "raw·3:1",                   detector: "fvg", params: fvgPs(), filters: {} },
    { name: "minGap=0.50·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50 }), filters: {} },
    { name: "raw·3:1+BUY",               detector: "fvg", params: fvgPs(), filters: { buyOnly: true } },
    { name: "minGap=0.50·3:1+BUY",       detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50 }), filters: { buyOnly: true } },
    { name: "raw·4:1+BUY",               detector: "fvg", params: fvgPs({ targetRMult: 4 }), filters: { buyOnly: true } },
    { name: "minGap=0.30·4:1+BUY",       detector: "fvg", params: fvgPs({ minGapAtrMul: 0.30, targetRMult: 4 }), filters: { buyOnly: true } },
    { name: "minGap=0.50·5:1+BUY",       detector: "fvg", params: fvgPs({ minGapAtrMul: 0.50, targetRMult: 5 }), filters: { buyOnly: true } },
    { name: "raw·3:1+BUY+adx[18,40]",    detector: "fvg", params: fvgPs(), filters: { buyOnly: true, minAdx: 18, maxAdx: 40 } },
  ];
}

// BOOM 300N — mirror of crash: rare UP spikes on smooth down-drift. OB favors
// fade-the-spike trades; SELL-bias on OB might catch consistent pullbacks.
function boomObVariants(): Variant[] {
  return [
    { name: "raw·3:1",                   detector: "orderBlock", params: obPs(), filters: {} },
    { name: "ce·4:1",                    detector: "orderBlock", params: obPs({ entryDepth: 1, targetRMult: 4 }), filters: {} },
    { name: "raw·5:1",                   detector: "orderBlock", params: obPs({ targetRMult: 5 }), filters: {} },
    { name: "ce·4:1+BUY",                detector: "orderBlock", params: obPs({ entryDepth: 1, targetRMult: 4 }), filters: { buyOnly: true } },
    { name: "ce·4:1+SELL",               detector: "orderBlock", params: obPs({ entryDepth: 1, targetRMult: 4 }), filters: { sellOnly: true } },
    { name: "ce·4:1+adx[18,38]",         detector: "orderBlock", params: obPs({ entryDepth: 1, targetRMult: 4 }), filters: { minAdx: 18, maxAdx: 38 } },
    { name: "lb=18·ce·4:1",              detector: "orderBlock", params: obPs({ lookback: 18, entryDepth: 1, targetRMult: 4 }), filters: {} },
    { name: "obSearch=5·ce·4:1",         detector: "orderBlock", params: obPs({ obSearchMaxBack: 5, entryDepth: 1, targetRMult: 4 }), filters: {} },
  ];
}

// stpRNG3 — fixed-step deterministic walk. Low noise → raw defaults likely best.
function stepVariants(): Variant[] {
  return [
    { name: "raw·3:1",                   detector: "fvg", params: fvgPs(), filters: {} },
    { name: "raw·4:1",                   detector: "fvg", params: fvgPs({ targetRMult: 4 }), filters: {} },
    { name: "raw·5:1",                   detector: "fvg", params: fvgPs({ targetRMult: 5 }), filters: {} },
    { name: "minGap=0.10·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.10 }), filters: {} },
    { name: "minGap=0.20·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.20 }), filters: {} },
    { name: "raw·3:1+BUY",               detector: "fvg", params: fvgPs(), filters: { buyOnly: true } },
    { name: "raw·3:1+SELL",              detector: "fvg", params: fvgPs(), filters: { sellOnly: true } },
    { name: "stopBuf=0.05·3:1",          detector: "fvg", params: fvgPs({ stopBufferAtrMul: 0.05 }), filters: {} },
  ];
}

// 1HZ90V — high-vol random walk. Tight stops; raw defaults; fast detection.
function highVolVariants(): Variant[] {
  return [
    { name: "raw·3:1",                   detector: "fvg", params: fvgPs(), filters: {} },
    { name: "raw·4:1",                   detector: "fvg", params: fvgPs({ targetRMult: 4 }), filters: {} },
    { name: "minGap=0.20·3:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.20 }), filters: {} },
    { name: "minGap=0.30·4:1",           detector: "fvg", params: fvgPs({ minGapAtrMul: 0.30, targetRMult: 4 }), filters: {} },
    { name: "stopBuf=0.05·3:1",          detector: "fvg", params: fvgPs({ stopBufferAtrMul: 0.05 }), filters: {} },
    { name: "raw·3:1+BUY",               detector: "fvg", params: fvgPs(), filters: { buyOnly: true } },
    { name: "raw·3:1+SELL",              detector: "fvg", params: fvgPs(), filters: { sellOnly: true } },
    { name: "raw·3:1+adx[20,40]",        detector: "fvg", params: fvgPs(), filters: { minAdx: 20, maxAdx: 40 } },
  ];
}

// ── Candidates: (asset symbol, detector, variant builder) ────────────────────
const candidates: Array<{ symbol: string; label: string; detector: Variant["detector"]; build: () => Variant[] }> = [
  { symbol: "CRASH1000",  label: "CRASH1000 FVG",  detector: "fvg",            build: () => crashFvgVariants() },
  { symbol: "CRASH500",   label: "CRASH500 FVG",   detector: "fvg",            build: () => crashFvgVariants() },
  { symbol: "stpRNG3",    label: "stpRNG3 FVG",    detector: "fvg",            build: () => stepVariants() },
  { symbol: "JD100",      label: "JD100 Sweep",    detector: "liquiditySweep", build: () => jumpVariants("liquiditySweep") },
  { symbol: "JD100",      label: "JD100 FVG",      detector: "fvg",            build: () => jumpVariants("fvg") },
  { symbol: "RDBULL",     label: "RDBULL FVG",     detector: "fvg",            build: () => bullVariants() },
  { symbol: "BOOM300N",   label: "BOOM300N OB",    detector: "orderBlock",     build: () => boomObVariants() },
  { symbol: "1HZ90V",     label: "1HZ90V FVG",     detector: "fvg",            build: () => highVolVariants() },
];

// ── Three-window CV ──────────────────────────────────────────────────────────
const W0_START    = Math.floor(new Date('2025-10-01T00:00:00Z').getTime() / 1000);
const W0_END      = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const TRAIN_START = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
const TRAIN_END   = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_START  = Math.floor(new Date('2026-04-01T00:00:00Z').getTime() / 1000);
const TEST_END    = Math.floor(new Date('2026-04-29T00:00:00Z').getTime() / 1000);

async function runWindowed(symbol: string, gran: number, v: Variant, allCandles: Candle[], windowStart: number, windowEnd: number): Promise<{ trades: number; wins: number; pnlUsd: number; covered: boolean }> {
  // If the data does not reach back to windowStart, this window is "uncovered"
  // → return zero trades and a covered=false flag. Caller should treat that as
  // n/a, not a failed window. This avoids both wasted backtests and false-fail
  // status when (e.g.) 15m bars only cover Feb-Apr but W0 = Oct-Dec.
  if (allCandles.length === 0 || allCandles[0].epoch >= windowEnd) {
    return { trades: 0, wins: 0, pnlUsd: 0, covered: false };
  }
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === v.detector,
    params: d.id === v.detector ? v.params : d.params,
  }));
  // Bisect for the last candle strictly before windowEnd. If none found
  // (windowEnd before all data), treat as uncovered.
  let endIdx = -1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  if (endIdx < 0) return { trades: 0, wins: 0, pnlUsd: 0, covered: false };
  const candles = allCandles.slice(0, endIdx + 1);
  const r = await runBacktest({
    symbol: symbol as any, granularity: gran as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  const inWin = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let pnlUsd = 0;
  for (const t of inWin) pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  // If no trades fell in window, mark uncovered too (no validation possible).
  return { trades: inWin.length, wins, pnlUsd, covered: inWin.length > 0 };
}

type Survivor = { candidate: string; tf: string; variant: string; w0: number; train: number; test: number; total: number; trades: number };

async function main() {
  // Per-asset CLI: run a single candidate so failures stay isolated.
  //   node script.mjs            → run all candidates sequentially
  //   node script.mjs CRASH1000  → only candidates where symbol == CRASH1000
  //   node script.mjs JD100:fvg  → only JD100 FVG (skip JD100 Sweep)
  const arg = process.argv[2];
  let toRun = candidates;
  if (arg) {
    const [sym, det] = arg.split(":");
    toRun = candidates.filter((c) => c.symbol.toUpperCase() === sym.toUpperCase() && (!det || c.detector.toLowerCase().startsWith(det.toLowerCase())));
    if (toRun.length === 0) { console.log(`No candidate matches "${arg}". Available: ${candidates.map((c) => `${c.symbol}:${c.detector}`).join(", ")}`); return; }
  }

  const c = new C(); await c.ready;
  console.log(`[synth-iter1] ${toRun.length}/${candidates.length} candidate(s) × 2 timeframes (15m + 1h) × 3-window CV`);
  console.log(`No-overfitting rule: variant must be POSITIVE in ALL 3 windows on at least one TF.\n`);

  const survivors: Survivor[] = [];

  for (const cand of toRun) {
    const variants = cand.build();
    console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  ${cand.label} (${cand.symbol}) — ${variants.length} variants × 2 TF × 3 windows`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);

    // 15m bar count: 8000 ≈ 83 days. Covers TEST (Apr) + most of TRAIN (Jan-Mar)
    // partially overlapping into W0. Keeps each variant tractable (~1-2 min vs 5+ min at 24000).
    for (const tf of [{ gran: 900, label: "15m", count: 8000, minTrades: MIN_TRADES_15M }, { gran: 3600, label: "1h", count: 6000, minTrades: MIN_TRADES_1H }]) {
      // Top-level retry: if a fetch fails (often because Deriv 15m is unavailable
      // for some synths), reconnect WS and retry once. If still fails, skip the TF
      // and continue — never let a single fetch failure poison the rest of the run.
      let candles: Candle[] = [];
      let fetchErr: Error | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { candles = await fetchPaged(c, cand.symbol, tf.gran, tf.count); fetchErr = null; break; }
        catch (e) { fetchErr = e as Error; try { await c.reconnect(); } catch {} }
      }
      if (fetchErr) { console.log(`  ${tf.label} fetch fail (skipping): ${fetchErr.message}`); continue; }
      if (candles.length < 500) { console.log(`  ${tf.label} only ${candles.length} bars — skip`); continue; }
      const fromD = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
      const toD = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
      console.log(`\n  ── ${tf.label} TF · ${candles.length} bars (${fromD} → ${toD}) ─────────`);
      console.log(`     ${"variant".padEnd(38)}  W0$       TRAIN$    TEST$     status`);

      for (const v of variants) {
        const w0 = await runWindowed(cand.symbol, tf.gran, v, candles, W0_START, W0_END);
        const tr = await runWindowed(cand.symbol, tf.gran, v, candles, TRAIN_START, TRAIN_END);
        const te = await runWindowed(cand.symbol, tf.gran, v, candles, TEST_START, TEST_END);
        const totalTrades = w0.trades + tr.trades + te.trades;
        // PASS = every COVERED window positive AND total trades meet floor.
        // Uncovered windows are n/a (data gap, not a failure).
        const coveredPositive = (w: typeof w0) => !w.covered || w.pnlUsd > 0;
        const allCoveredPositive = coveredPositive(w0) && coveredPositive(tr) && coveredPositive(te);
        const coveredCount = (w0.covered ? 1 : 0) + (tr.covered ? 1 : 0) + (te.covered ? 1 : 0);
        const passes = allCoveredPositive && coveredCount >= 2 && totalTrades >= tf.minTrades;
        const status = passes ? `✓ PASS (${coveredCount}w)` : "";
        const fmt = (w: typeof w0) => w.covered ? pad(w.pnlUsd) : "    n/a ";
        console.log(`     ${v.name.padEnd(38)}  ${fmt(w0)}  ${fmt(tr)}  ${fmt(te)}  ${status}`);
        if (passes) {
          survivors.push({ candidate: cand.label, tf: tf.label, variant: v.name, w0: w0.pnlUsd, train: tr.pnlUsd, test: te.pnlUsd, total: w0.pnlUsd + tr.pnlUsd + te.pnlUsd, trades: totalTrades });
        }
      }
    }
  }

  c.close();

  console.log(`\n\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`SURVIVORS — passed all 3 windows positive AND minimum trade count`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  if (survivors.length === 0) {
    console.log(`  ❌ Nothing held across all 3 windows on either TF. Iter-2 needed.`);
    return;
  }
  survivors.sort((a, b) => b.total - a.total);
  console.log(`  ${"candidate".padEnd(20)} ${"tf".padEnd(4)} ${"variant".padEnd(38)} ${"trades".padStart(6)}   W0$       TRAIN$    TEST$     SUM$`);
  for (const s of survivors) {
    console.log(`  ${s.candidate.padEnd(20)} ${s.tf.padEnd(4)} ${s.variant.padEnd(38)} ${String(s.trades).padStart(6)}   ${pad(s.w0)}  ${pad(s.train)}  ${pad(s.test)}  ${pad(s.total)}`);
  }

  // TOP 3 by total $ across all candidates
  console.log(`\n══ TOP 3 WINNERS ══`);
  const seen = new Set<string>();
  const top3: Survivor[] = [];
  for (const s of survivors) {
    if (seen.has(s.candidate)) continue; // one per asset/detector combo
    seen.add(s.candidate); top3.push(s);
    if (top3.length >= 3) break;
  }
  for (let i = 0; i < top3.length; i++) {
    const s = top3[i];
    console.log(`  [${i+1}] ${s.candidate} · ${s.tf} · ${s.variant} · ${s.trades}t · SUM ${pad(s.total)}`);
  }
}

function pad(n: number): string { const s = (n >= 0 ? "+" : "") + "$" + n.toFixed(0); return s.padStart(8); }

main().catch((e) => { console.error(e); process.exit(1); });

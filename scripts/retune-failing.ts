// Parallel retune of 5 failing strategies. For each, sweep variants across
// W0/TRAIN/TEST 3-window validation. Find the variant (if any) that passes
// all 3 windows. Strategies: silver_sweep, eth_ob, eth_sweep, eth_fvg, gold_sweep.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig, BacktestRequest } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const MIN_TRADES = 5;  // lower threshold per window since 90d windows yield 5-50 trades

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

type WindowResult = { trades: number; wins: number; expR: number; pnlUsd: number };

async function runWindow(req: Partial<BacktestRequest>, candles: Candle[], detectorParams: any, detectorId: string, windowStart: number, windowEnd: number): Promise<WindowResult> {
  let endIdx = candles.length - 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const sliced = candles.slice(0, endIdx + 1);
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === detectorId,
    params: d.id === detectorId ? detectorParams : d.params,
  }));
  const r = await runBacktest({
    ...req, count: sliced.length, costBps: COST_BPS,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, sliced);
  const inWin = r.trades.filter((t) => sliced[t.openedAtIndex].epoch >= windowStart);
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

function obParams(over: any = {}) {
  return {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
    ...over,
  };
}
function fvgParams(over: any = {}) {
  return { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12, targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0, ...over };
}
function sweepParams(over: any = {}) {
  return { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 1, stopBufferAtrMul: 0.1, ...over };
}

type StrategyTune = {
  id: string;
  symbol: string;
  granularity: number;
  detectorId: string;
  variants: Array<{ name: string; params: any; filters: any }>;
};

const tunes: StrategyTune[] = [
  // 1. silver_sweep — was ICT 3:1 + with-trend@20. W0 -$68, TRAIN +$702, TEST +$77. Failed W0.
  {
    id: "silver_sweep", symbol: "frxXAGUSD", granularity: 3600, detectorId: "liquiditySweep",
    variants: [
      { name: "(orig) ICT 3:1 + withTrend@20",       params: sweepParams({ entryOnSweep: 1, targetRMult: 3.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
      { name: "confirm 3:1 (no filter)",             params: sweepParams({ entryOnSweep: 0, targetRMult: 3.0 }), filters: {} },
      { name: "confirm 4:1 + minAdx=22",             params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { minAdx: 22 } },
      { name: "confirm 4:1 + minAdx=24",             params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { minAdx: 24 } },
      { name: "confirm 4:1 + maxAdx=40",             params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { maxAdx: 40 } },
      { name: "ICT 4:1 + minAdx=22",                 params: sweepParams({ entryOnSweep: 1, targetRMult: 4.0 }), filters: { minAdx: 22 } },
      { name: "ICT 5:1 + with-trend@20",             params: sweepParams({ entryOnSweep: 1, targetRMult: 5.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
      { name: "confirm 4:1 + swing1 + minAdx=22",    params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1 }), filters: { minAdx: 22 } },
      { name: "confirm 5:1 + swing1",                params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0, swingLeft: 1, swingRight: 1 }), filters: {} },
    ],
  },
  // 2. eth_ob — was edge·6:1 + with-trend@20 + maxAdx=40 + skipSat. W0 +$253, TRAIN +$238, TEST -$38.
  {
    id: "eth_ob", symbol: "cryETHUSD", granularity: 3600, detectorId: "orderBlock",
    variants: [
      { name: "(orig) edge·6:1+withTrend@20+maxAdx=40+skipSat", params: obParams({ targetRMult: 6.0 }), filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40, skipDaysOfWeekUtc: [6] } },
      { name: "edge·4:1+minAdx=22 (Plat-style)",     params: obParams({ targetRMult: 4.0 }), filters: { minAdx: 22 } },
      { name: "edge·4:1+minAdx=24",                  params: obParams({ targetRMult: 4.0 }), filters: { minAdx: 24 } },
      { name: "edge·5:1+minAdx=22",                  params: obParams({ targetRMult: 5.0 }), filters: { minAdx: 22 } },
      { name: "edge·5:1+withTrend@20",               params: obParams({ targetRMult: 5.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
      { name: "edge·4:1+withTrend@20+maxAdx=50",     params: obParams({ targetRMult: 4.0 }), filters: { withTrendOnlyAboveAdx: 20, maxAdx: 50 } },
      { name: "edge·6:1+minAdx=22+skipSat",          params: obParams({ targetRMult: 6.0 }), filters: { minAdx: 22, skipDaysOfWeekUtc: [6] } },
      { name: "+FVG·4:1+minAdx=22 (LTC-style)",      params: obParams({ targetRMult: 4.0, requireFVG: 1 }), filters: { minAdx: 22 } },
      { name: "+FVG·3:1+disp0.6+rejBody0.5",         params: obParams({ targetRMult: 3.0, requireFVG: 1, displacementAtrMultiplier: 0.6, rejectionBodyAtrMul: 0.5 }), filters: {} },
    ],
  },
  // 3. eth_sweep — was confirm 5:1 no filter. TRAIN +$821, TEST -$108.
  {
    id: "eth_sweep", symbol: "cryETHUSD", granularity: 3600, detectorId: "liquiditySweep",
    variants: [
      { name: "(orig) confirm 5:1",                  params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0 }), filters: {} },
      { name: "confirm 4:1 + minAdx=22",             params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { minAdx: 22 } },
      { name: "confirm 4:1 + minAdx=24",             params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { minAdx: 24 } },
      { name: "confirm 5:1 + minAdx=22",             params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0 }), filters: { minAdx: 22 } },
      { name: "confirm 5:1 + maxAdx=40",             params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0 }), filters: { maxAdx: 40 } },
      { name: "confirm 5:1 + with-trend@20",         params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
      { name: "confirm 4:1 + swing1 + minAdx=22",    params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1 }), filters: { minAdx: 22 } },
      { name: "confirm 5:1 + swing1 + minAdx=22",    params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0, swingLeft: 1, swingRight: 1 }), filters: { minAdx: 22 } },
      { name: "ICT 4:1 + minAdx=22",                 params: sweepParams({ entryOnSweep: 1, targetRMult: 4.0 }), filters: { minAdx: 22 } },
    ],
  },
  // 4. eth_fvg — was edge·6:1 + minGap=0.3 + with-trend@20 + skipSat. W0 -$34, TRAIN +$321, TEST -$59.
  {
    id: "eth_fvg", symbol: "cryETHUSD", granularity: 3600, detectorId: "fvg",
    variants: [
      { name: "(orig) edge·6:1+minGap=0.3+withTrend@20+skipSat", params: fvgParams({ targetRMult: 6.0, minGapAtrMul: 0.3 }), filters: { withTrendOnlyAboveAdx: 20, skipDaysOfWeekUtc: [6] } },
      { name: "edge·4:1+minAdx=22 (Plat-style)",     params: fvgParams({ targetRMult: 4.0 }), filters: { minAdx: 22 } },
      { name: "edge·4:1+minAdx=24",                  params: fvgParams({ targetRMult: 4.0 }), filters: { minAdx: 24 } },
      { name: "edge·4:1+minAdx=26",                  params: fvgParams({ targetRMult: 4.0 }), filters: { minAdx: 26 } },
      { name: "edge·5:1+minAdx=22",                  params: fvgParams({ targetRMult: 5.0 }), filters: { minAdx: 22 } },
      { name: "edge·6:1+minAdx=22",                  params: fvgParams({ targetRMult: 6.0 }), filters: { minAdx: 22 } },
      { name: "edge·4:1+minAdx=22+minGap=0.3",       params: fvgParams({ targetRMult: 4.0, minGapAtrMul: 0.3 }), filters: { minAdx: 22 } },
      { name: "edge·4:1+minAdx=22+minGap=0.5",       params: fvgParams({ targetRMult: 4.0, minGapAtrMul: 0.5 }), filters: { minAdx: 22 } },
      { name: "edge·4:1+minAdx=22+maxAdx=50",        params: fvgParams({ targetRMult: 4.0 }), filters: { minAdx: 22, maxAdx: 50 } },
    ],
  },
  // 5. gold_sweep — was confirm 4:1 + swing1 + cw=6 + eqTol=0.15 + BUY-only. W0 +$210, TRAIN +$254, TEST -$40.
  {
    id: "gold_sweep", symbol: "frxXAUUSD", granularity: 3600, detectorId: "liquiditySweep",
    variants: [
      { name: "(orig) confirm 4:1+swing1+cw=6+eqTol=0.15+BUY", params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6, equalToleranceAtrMul: 0.15 }), filters: { buyOnly: true } },
      { name: "confirm 4:1 + swing1 (no BUY)",       params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6, equalToleranceAtrMul: 0.15 }), filters: {} },
      { name: "confirm 4:1 + swing1 + minAdx=22",    params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6 }), filters: { minAdx: 22 } },
      { name: "confirm 5:1 + swing1 + BUY",          params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6 }), filters: { buyOnly: true } },
      { name: "confirm 5:1 + swing1 + minAdx=22",    params: sweepParams({ entryOnSweep: 0, targetRMult: 5.0, swingLeft: 1, swingRight: 1, confirmationWindow: 6 }), filters: { minAdx: 22 } },
      { name: "ICT 3:1 + swing1 + BUY",              params: sweepParams({ entryOnSweep: 1, targetRMult: 3.0, swingLeft: 1, swingRight: 1 }), filters: { buyOnly: true } },
      { name: "confirm 4:1 (default swings)",        params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: {} },
      { name: "confirm 4:1 + minAdx=22 (default swings)", params: sweepParams({ entryOnSweep: 0, targetRMult: 4.0 }), filters: { minAdx: 22 } },
    ],
  },
];

async function main() {
  const c = new C(); await c.ready;

  // Build candle cache per (symbol, gran)
  const cache = new Map<string, Candle[]>();
  const symbols = new Set(tunes.map((t) => `${t.symbol}-${t.granularity}`));
  for (const sg of symbols) {
    const [sym, grStr] = sg.split("-"); const gr = parseInt(grStr);
    console.log(`Fetching ${sym} ${gr === 900 ? "15m" : "1h"} ...`);
    const candles = await fetchPaged(c, sym, gr, gr === 900 ? 12000 : 4000);
    console.log(`  got ${candles.length} bars (${new Date(candles[0].epoch*1000).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].epoch*1000).toISOString().slice(0,10)})`);
    cache.set(sg, candles);
  }
  c.close();

  // Compute windows based on each asset's data depth
  function makeWindows(candles: Candle[]) {
    const latest = candles[candles.length-1].epoch;
    const earliest = candles[0].epoch;
    const totalDays = (latest - earliest) / 86400;
    // ETH has 333d → use 90/90/27. Gold/Plat ~136d → use 45/60/27. Silver 1h ~208d → use 90/90/27.
    let testD = 27;
    let trainD = totalDays >= 200 ? 90 : 60;
    let w0D = totalDays >= 200 ? 90 : 45;
    const TEST_END = latest + 1;
    const TEST_START = TEST_END - testD * 86400;
    const TRAIN_END = TEST_START;
    const TRAIN_START = TRAIN_END - trainD * 86400;
    const W0_END = TRAIN_START;
    const W0_START = W0_END - w0D * 86400;
    return { W0_START, W0_END, TRAIN_START, TRAIN_END, TEST_START, TEST_END, w0D, trainD, testD };
  }

  const allResults: any[] = [];
  for (const t of tunes) {
    const candles = cache.get(`${t.symbol}-${t.granularity}`)!;
    const w = makeWindows(candles);
    console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
    console.log(`RETUNE: ${t.id}  (${w.w0D}/${w.trainD}/${w.testD} days W0/TRAIN/TEST)`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  ${"variant".padEnd(58)}  W0           TRAIN        TEST         passes?`);
    const variantResults: any[] = [];
    for (const v of t.variants) {
      const baseReq: Partial<BacktestRequest> = {
        symbol: t.symbol as any, granularity: t.granularity as any,
        atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0,
        ...v.filters,
      };
      const w0 = await runWindow(baseReq, candles, v.params, t.detectorId, w.W0_START, w.W0_END);
      const tr = await runWindow(baseReq, candles, v.params, t.detectorId, w.TRAIN_START, w.TRAIN_END);
      const te = await runWindow(baseReq, candles, v.params, t.detectorId, w.TEST_START, w.TEST_END);
      const allTradesEnough = w0.trades >= MIN_TRADES && tr.trades >= MIN_TRADES && te.trades >= MIN_TRADES;
      const passes = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0 && allTradesEnough;
      variantResults.push({ name: v.name, w0, tr, te, passes, totalUsd: w0.pnlUsd + tr.pnlUsd + te.pnlUsd });
      const fmt = (r: any) => `${(r.pnlUsd>=0?"+":"")}$${r.pnlUsd.toFixed(0).padStart(5)}(${String(r.trades).padStart(2)}t)`;
      console.log(`  ${v.name.padEnd(58)}  ${fmt(w0)}   ${fmt(tr)}   ${fmt(te)}   ${passes?"✓":"✗"}`);
    }
    const passing = variantResults.filter((r) => r.passes).sort((a, b) => b.totalUsd - a.totalUsd);
    if (passing.length === 0) {
      console.log(`  → NO 3-window passers. Best by combined $:`);
      const best = variantResults.sort((a, b) => b.totalUsd - a.totalUsd).slice(0, 3);
      for (const r of best) console.log(`     ${r.name} → combined $${r.totalUsd.toFixed(0)}`);
    } else {
      console.log(`  → ${passing.length} passing. Top 3 by combined $:`);
      for (const r of passing.slice(0, 3)) console.log(`     ✓ ${r.name} → combined $${r.totalUsd.toFixed(0)} (W0/TRAIN/TEST: $${r.w0.pnlUsd.toFixed(0)}/$${r.tr.pnlUsd.toFixed(0)}/$${r.te.pnlUsd.toFixed(0)})`);
    }
    allResults.push({ id: t.id, passing });
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`OVERALL RETUNE SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const r of allResults) {
    const top = r.passing[0];
    if (top) console.log(`  ${r.id.padEnd(14)} ✓ FIXED → ${top.name} (combined $${top.totalUsd.toFixed(0)})`);
    else console.log(`  ${r.id.padEnd(14)} ✗ no 3-window winner found`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

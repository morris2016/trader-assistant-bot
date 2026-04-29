// Synthetic-only screener — Deriv R_*, BOOM*, CRASH*, 1HZ*, JD*, stp* indices.
//
// DAILY walk-forward × OB/FVG/Sweep × variant pack per detector. Higher
// resolution than monthly: each day with ≥1 trade is W or L, days with no
// trades are flat (don't count). Different
// shape from real assets:
//   - R_*       : pure random walk with constant volatility (10/25/50/75/100%)
//   - 1HZ*      : 1-second tick versions of R_ (more noise)
//   - BOOM/CRASH: spike indices — one direction has rare large moves (asymmetric)
//   - Step      : fixed-step steady walk
//   - JD*       : jump-diffusion — periodic jumps
//
// SEPARATE from production bot. Doesn't touch src/main/engine/strategies/index.ts.
// Run locally: npx esbuild ... && node .tmp/synth-screen-all.mjs
//
// Output: rank table by net-winning-months × 1000 + total $. Top candidates
// surface for follow-up drill-down (per-asset iter-1 from raw defaults).

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const GR = 3600; // 1h
const FETCH = 4000;
// Daily bucketing — much stricter than monthly. A "winning day" needs ≥1 trade
// netting positive; a "losing day" has trades netting negative; days with no
// trades (or trades < MIN) are "flat" (don't count either way).
const MIN_TRADES_PER_DAY = 1;
const MIN_BARS_PER_DAY = 18;        // synthetic indices trade 24/7 → expect 24 1h bars; allow 18+
const MIN_BARS_REQUIRED = 1500;
// TEST WINDOW: only count trades that open in the last N days. Earlier candles
// serve as warmup for detectors (engine state warms up over the full fetch).
const TEST_DAYS = 3;
const TEST_WINDOW_SEC = TEST_DAYS * 24 * 3600;

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
    for (let attempt = 0; attempt < 4; attempt++) {
      try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); break; }
      catch (e) { if (attempt === 3) throw e; await new Promise((res) => setTimeout(res, 2000 + attempt * 1500)); }
    }
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

function obParams(over: any = {}) {
  return { lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0, ...over };
}
function fvgParams(over: any = {}) {
  return { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12,
    targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0, ...over };
}
function swParams(over: any = {}) {
  return { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50,
    confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2,
    targetRMult: 3.0, entryOnSweep: 0, stopBufferAtrMul: 0.1, ...over };
}

type Variant = { name: string; det: "orderBlock"|"fvg"|"liquiditySweep"; params: any; filters: any };

// Lite screening pack: 4 variants per detector. Synth-tuned hypotheses:
//   - higher minGap on FVG (synthetics have many tiny noise gaps)
//   - ce·4:1 OB (mid-zone fill survives noisy retests)
//   - sweep stopBuf=0.25 (Pall-style — but tested independently per asset)
//   - ADX bands [18, 38] (synth ADX cycles between extremes)
const screeningPack: Variant[] = [
  // OB
  { name: "OB ce·4:1",                det: "orderBlock", params: obParams({ entryDepth: 1, targetRMult: 4 }), filters: {} },
  { name: "OB raw·5:1",               det: "orderBlock", params: obParams({ targetRMult: 5 }), filters: {} },
  { name: "OB adx[18,38]·3:1",        det: "orderBlock", params: obParams(), filters: { minAdx: 18, maxAdx: 38 } },
  { name: "OB ce+adx[18,38]·4:1",     det: "orderBlock", params: obParams({ entryDepth: 1, targetRMult: 4 }), filters: { minAdx: 18, maxAdx: 38 } },
  // FVG
  { name: "FVG raw·3:1",              det: "fvg",        params: fvgParams(), filters: {} },
  { name: "FVG minGap=0.50·3:1",      det: "fvg",        params: fvgParams({ minGapAtrMul: 0.5 }), filters: {} },
  { name: "FVG adx[18,38]·3:1",       det: "fvg",        params: fvgParams(), filters: { minAdx: 18, maxAdx: 38 } },
  { name: "FVG minGap=0.20+adx[18,38]·3:1", det: "fvg",  params: fvgParams({ minGapAtrMul: 0.2 }), filters: { minAdx: 18, maxAdx: 38 } },
  // Sweep
  { name: "Sw raw·3:1",               det: "liquiditySweep", params: swParams(), filters: {} },
  { name: "Sw stopBuf=0.25·4:1",      det: "liquiditySweep", params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.25 }), filters: {} },
  { name: "Sw eqTol=0.05·3:1",        det: "liquiditySweep", params: swParams({ equalToleranceAtrMul: 0.05 }), filters: {} },
  { name: "Sw eqTol=0.20·3:1",        det: "liquiditySweep", params: swParams({ equalToleranceAtrMul: 0.20 }), filters: {} },
];

function dayKey(epoch: number): string {
  // UTC YYYY-MM-DD
  return new Date(epoch * 1000).toISOString().slice(0, 10);
}

async function runVariant(sym: string, v: Variant, candles: Candle[]) {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === v.det,
    params: d.id === v.det ? v.params : d.params,
  }));
  const r = await runBacktest({
    symbol: sym as any, granularity: GR as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...v.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  return r.trades.map((t) => ({ epoch: candles[t.openedAtIndex].epoch, pnlUsd: STAKE * Math.max(-1, t.pnlPct * MULT) }));
}

function scoreVariant(trades: { epoch: number; pnlUsd: number }[], fullDays: string[]) {
  const perDay = new Map<string, { pnl: number; trades: number }>();
  for (const d of fullDays) perDay.set(d, { pnl: 0, trades: 0 });
  for (const t of trades) {
    const k = dayKey(t.epoch);
    const cur = perDay.get(k);
    if (cur) { cur.pnl += t.pnlUsd; cur.trades += 1; }
  }
  let win = 0, lose = 0, flat = 0, total = 0;
  for (const d of fullDays) {
    const cur = perDay.get(d)!;
    total += cur.pnl;
    if (cur.trades < MIN_TRADES_PER_DAY) flat++;
    else if (cur.pnl > 0) win++;
    else if (cur.pnl < 0) lose++;
    else flat++;
  }
  return { win, lose, flat, total };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Deriv SYNTHETIC screener — last ${TEST_DAYS}d × OB/FVG/Sweep · 1h (warmup ~${Math.round(FETCH/24)-TEST_DAYS}d)\n`);
  process.stdout.write("");

  const sr = await c.send({ active_symbols: "brief" });
  const all = (sr.active_symbols ?? []) as any[];
  const synths = all.filter((s) => {
    const m = String(s.market || "").toLowerCase();
    if (!m.includes("synthetic")) return false;
    if (s.exchange_is_open === 0) return false;
    return true;
  });
  console.log(`Active synthetics: ${synths.length}`);
  const submarkets = new Map<string, number>();
  for (const s of synths) submarkets.set(s.submarket, (submarkets.get(s.submarket) ?? 0) + 1);
  console.log(`Submarkets: ${Array.from(submarkets.entries()).map(([k,v])=>`${k}(${v})`).join(", ")}\n`);
  process.stdout.write("");

  type Result = { sym: string; name: string; submarket: string; det: string; variant: string; win: number; lose: number; flat: number; total: number; score: number };
  const all_results: Result[] = [];

  let i = 0;
  for (const s of synths) {
    i++;
    const sym = s.symbol as string;
    const name = s.display_name as string;
    const sub = s.submarket as string;
    process.stdout.write(`[${String(i).padStart(3)}/${synths.length}] ${sym.padEnd(14)} ${name.padEnd(34)}`);

    let candles: Candle[];
    try { candles = await fetchPaged(c, sym, GR, FETCH); }
    catch (e) { console.log(`  fetch fail`); continue; }
    if (candles.length < MIN_BARS_REQUIRED) { console.log(`  only ${candles.length} bars — skip`); continue; }

    // Test window: last TEST_DAYS days. Earlier candles are warmup for detectors.
    const lastEpoch = candles[candles.length - 1].epoch;
    const testStartEpoch = lastEpoch - TEST_WINDOW_SEC;
    const dayBars = new Map<string, number>();
    for (const cn of candles) {
      if (cn.epoch < testStartEpoch) continue;
      const k = dayKey(cn.epoch);
      dayBars.set(k, (dayBars.get(k) ?? 0) + 1);
    }
    const fullDays = Array.from(dayBars.keys()).filter((k) => (dayBars.get(k) ?? 0) >= MIN_BARS_PER_DAY).sort();
    if (fullDays.length < 1) { console.log(`  no full days in test window — skip`); continue; }

    const bestPerDet: { [d: string]: Result } = {};
    for (const v of screeningPack) {
      try {
        const allTrades = await runVariant(sym, v, candles);
        // Only count trades that opened in the test window (post-warmup)
        const trades = allTrades.filter((t) => t.epoch >= testStartEpoch);
        const { win, lose, flat, total } = scoreVariant(trades, fullDays);
        // Score: weight win-loss differential heavily ($10 per net day) + total $
        const score = (win - lose) * 10 + total;
        const cur = bestPerDet[v.det];
        if (!cur || score > cur.score) {
          bestPerDet[v.det] = { sym, name, submarket: sub, det: v.det, variant: v.name, win, lose, flat, total, score };
        }
      } catch {}
    }
    for (const r of Object.values(bestPerDet)) all_results.push(r);

    const summary = ["orderBlock","fvg","liquiditySweep"].map((d) => {
      const r = bestPerDet[d];
      if (!r) return `${d.slice(0,2)}-`;
      return `${d.slice(0,2)}:${r.win}/${r.lose}/${r.flat} ${r.total>=0?"+":""}$${r.total.toFixed(0)}`;
    }).join(" | ");
    console.log(`  ${summary}`);
    process.stdout.write("");
  }
  c.close();

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`TOP 25 CANDIDATES (sorted by net-winning-days × 10 + total $)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  all_results.sort((a, b) => b.score - a.score);
  console.log(`  rank  asset (submarket)                       det           variant                            W/L/F   net    total`);
  for (let k = 0; k < Math.min(25, all_results.length); k++) {
    const r = all_results[k];
    const tag = `${r.sym} ${r.name}`.slice(0, 38);
    const net = r.win - r.lose;
    const totalDays = r.win + r.lose + r.flat;
    const wrPct = (r.win + r.lose) > 0 ? Math.round((r.win / (r.win + r.lose)) * 100) : 0;
    console.log(`  [${String(k+1).padStart(2)}]  ${tag.padEnd(38)} ${r.det.padEnd(13)} ${r.variant.padEnd(36)} ${String(r.win).padStart(3)}/${String(r.lose).padStart(3)}/${String(r.flat).padStart(3)} (${wrPct}%WR) net=${net>=0?"+":""}${net}d ${r.total>=0?"+":""}$${r.total.toFixed(0)}`);
  }

  // Strong-edge candidates over the 3-day test window:
  //   ≥2 winning days, 0 losing days, positive total $
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`STRONG-EDGE 3-DAY (≥2 win days · 0 loss days · positive total)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  const strict = all_results.filter((r) => r.win >= 2 && r.lose === 0 && r.total > 0);
  if (strict.length === 0) {
    console.log(`  ❌ None met the bar — relaxing to ≥1 win day, 0 loss, +$.`);
    const relaxed = all_results.filter((r) => r.win >= 1 && r.lose === 0 && r.total > 0).sort((a, b) => b.total - a.total);
    for (const r of relaxed.slice(0, 20)) {
      console.log(`  ~ ${r.sym} (${r.submarket}) · ${r.det} · ${r.variant} · ${r.win}W/${r.lose}L/${r.flat}F +$${r.total.toFixed(0)}`);
    }
  } else {
    for (const r of strict.slice(0, 20)) {
      console.log(`  ✓ ${r.sym} (${r.submarket}) · ${r.det} · ${r.variant} · ${r.win}W/${r.lose}L/${r.flat}F +$${r.total.toFixed(0)}`);
    }
  }

  console.log(`\nNext step: pick top 3 from strict-only-winners (or top 3 ranked) and drill down with`);
  console.log(`per-asset iter-1 scripts anchored on raw defaults (per the no-copy-strategies rule).`);
}

main().catch((e) => { console.error(e); process.exit(1); });

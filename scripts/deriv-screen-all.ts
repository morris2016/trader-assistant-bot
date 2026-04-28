// Deriv multi-asset screener.
// Fetches all real (non-synthetic) Deriv symbols, runs OB/FVG/Sweep screening
// (3 baseline variants per detector × 1h × 5-month walk-forward), ranks by
// only-winning-month count + total $. Outputs top 3 (asset, detector) pairs to
// drill into for full validation.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const GR = 3600; // 1h
const FETCH = 4000; // ~167 days
const MIN_TRADES_PER_MONTH = 3;
const MIN_BARS_REQUIRED = 2000;

// Skip already-validated/dropped/declined assets
const SKIP_SYMBOLS = new Set([
  "frxXAUUSD", "frxXAGUSD", "frxXPTUSD", "frxXPDUSD", // metals (registered)
  "frxEURUSD", "frxUSDJPY", "frxGBPUSD",              // forex (rejected/dropped)
  // Crypto handled separately — skip all crypto since BTC/ETH/LTC failed
]);
const SKIP_MARKET_PATTERNS = [/synthetic/, /derived/];
const SKIP_CRYPTO = true;

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

// Lite screening pack: 3 variants × 3 detectors = 9 variants per asset.
const screeningPack: Variant[] = [
  // OB — winners across registry: ce·4:1, +adx, +stopBuf
  { name: "OB ce·4:1",                det: "orderBlock", params: obParams({ entryDepth: 1, targetRMult: 4 }),                              filters: {} },
  { name: "OB minAdx=22+ce·4:1",      det: "orderBlock", params: obParams({ entryDepth: 1, targetRMult: 4 }),                              filters: { minAdx: 22 } },
  { name: "OB stopBuf=0.25·4:1",      det: "orderBlock", params: obParams({ targetRMult: 4, stopBufferAtrMul: 0.25 }),                     filters: {} },
  // FVG — registry winners: minGap=0.15·4:1 (Gold/Plat), minGap=0.50·4:1, minAdx=24
  { name: "FVG minGap=0.15·4:1",      det: "fvg",        params: fvgParams({ targetRMult: 4 }),                                            filters: {} },
  { name: "FVG minGap=0.50·4:1",      det: "fvg",        params: fvgParams({ minGapAtrMul: 0.5, targetRMult: 4 }),                         filters: {} },
  { name: "FVG minAdx=24·4:1",        det: "fvg",        params: fvgParams({ targetRMult: 4 }),                                            filters: { minAdx: 24 } },
  // Sweep — registry winner: stopBuf=0.25·4:1
  { name: "Sw stopBuf=0.25·4:1",      det: "liquiditySweep", params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.25 }),                 filters: {} },
  { name: "Sw stopBuf=0.30·4:1",      det: "liquiditySweep", params: swParams({ targetRMult: 4, stopBufferAtrMul: 0.30 }),                 filters: {} },
  { name: "Sw confirm·3:1",           det: "liquiditySweep", params: swParams(),                                                            filters: {} },
];

function monthKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

function scoreVariant(trades: { epoch: number; pnlUsd: number }[], fullMonths: string[]) {
  const perMonth = new Map<string, { pnl: number; trades: number }>();
  for (const m of fullMonths) perMonth.set(m, { pnl: 0, trades: 0 });
  for (const t of trades) {
    const k = monthKey(t.epoch);
    const cur = perMonth.get(k);
    if (cur) { cur.pnl += t.pnlUsd; cur.trades += 1; }
  }
  let win = 0, lose = 0, flat = 0, total = 0;
  for (const m of fullMonths) {
    const cur = perMonth.get(m)!;
    total += cur.pnl;
    if (cur.trades < MIN_TRADES_PER_MONTH) flat++;
    else if (cur.pnl > 0) win++;
    else if (cur.pnl < 0) lose++;
    else flat++;
  }
  return { win, lose, flat, total };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Deriv multi-asset screener — OB/FVG/Sweep × monthly walk-forward · 1h\n`);
  process.stdout.write("");

  const sr = await c.send({ active_symbols: "brief" });
  const all = (sr.active_symbols ?? []) as any[];
  const real = all.filter((s) => {
    const m = String(s.market || "").toLowerCase();
    if (SKIP_MARKET_PATTERNS.some((re) => re.test(m))) return false;
    if (SKIP_CRYPTO && m.includes("crypto")) return false;
    if (SKIP_SYMBOLS.has(s.symbol)) return false;
    if (s.exchange_is_open === 0) return false;
    return true;
  });
  console.log(`Active symbols: ${all.length}, real (non-synth, non-crypto, not-skipped): ${real.length}`);
  console.log(`Markets: ${[...new Set(real.map((s) => s.market))].join(", ")}\n`);
  process.stdout.write("");

  type Result = { sym: string; name: string; market: string; det: string; variant: string; win: number; lose: number; flat: number; total: number; score: number };
  const all_results: Result[] = [];

  let i = 0;
  for (const s of real) {
    i++;
    const sym = s.symbol as string;
    const name = s.display_name as string;
    const market = s.market as string;
    process.stdout.write(`[${String(i).padStart(3)}/${real.length}] ${sym.padEnd(12)} ${name.padEnd(28)}`);

    let candles: Candle[];
    try { candles = await fetchPaged(c, sym, GR, FETCH); }
    catch (e) { console.log(`  fetch fail`); continue; }
    if (candles.length < MIN_BARS_REQUIRED) { console.log(`  only ${candles.length} bars — skip`); continue; }

    // discover full-coverage months (≥350 bars)
    const monthBars = new Map<string, number>();
    for (const cn of candles) {
      const k = monthKey(cn.epoch);
      monthBars.set(k, (monthBars.get(k) ?? 0) + 1);
    }
    const fullMonths = Array.from(monthBars.keys()).filter((k) => (monthBars.get(k) ?? 0) >= 350).sort();
    if (fullMonths.length < 4) { console.log(`  only ${fullMonths.length} full months — skip`); continue; }

    let bestPerDet: { [d: string]: Result } = {};
    for (const v of screeningPack) {
      try {
        const trades = await runVariant(sym, v, candles);
        const { win, lose, flat, total } = scoreVariant(trades, fullMonths);
        const score = (win - lose) * 1000 + total; // primary: net winning months; tiebreak: $
        const cur = bestPerDet[v.det];
        if (!cur || score > cur.score) {
          bestPerDet[v.det] = { sym, name, market, det: v.det, variant: v.name, win, lose, flat, total, score };
        }
      } catch (e) {
        // skip variant errors
      }
    }
    for (const r of Object.values(bestPerDet)) all_results.push(r);

    // print compact summary for this asset
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
  console.log(`TOP CANDIDATES (sorted by net-winning-months × $1000 + total $)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  all_results.sort((a, b) => b.score - a.score);
  console.log(`  rank  asset (market)                          det           variant                          W/L/F  total`);
  for (let k = 0; k < Math.min(15, all_results.length); k++) {
    const r = all_results[k];
    console.log(`  [${String(k+1).padStart(2)}]  ${(r.sym + " " + r.name).padEnd(40)} ${r.det.padEnd(13)} ${r.variant.padEnd(32)} ${r.win}/${r.lose}/${r.flat}  ${r.total>=0?"+":""}$${r.total.toFixed(0)}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`TOP 3 RECOMMENDED FOR FULL VALIDATION`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  // pick top 3 unique (asset, detector) pairs that are 5/0/* or 4/0/*
  const top3 = all_results.filter((r) => r.lose === 0 && r.win >= 3).slice(0, 3);
  if (top3.length === 0) {
    console.log(`  No 0-loss candidates found. Top 3 by score (may have losing months):`);
    for (const r of all_results.slice(0, 3)) {
      console.log(`  → ${r.sym} ${r.name} · ${r.det} · ${r.variant} · ${r.win}/${r.lose}/${r.flat} ${r.total>=0?"+":""}$${r.total.toFixed(0)}`);
    }
  } else {
    for (const r of top3) {
      console.log(`  ✓ ${r.sym} ${r.name} · ${r.det} · ${r.variant} · ${r.win}/${r.lose}/${r.flat} +$${r.total.toFixed(0)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

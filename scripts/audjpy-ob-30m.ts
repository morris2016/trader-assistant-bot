// AUD/JPY OB on 30m — 1h had insufficient trade count per CV window.
// Anchored on raw obParams() defaults; variant axes chosen for AUD/JPY's high-vol yen-cross
// nature, with TF-aware adjustments (lookback in bars; 30m bar = ½ hour; lookback=48 ≈ 1 day).

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxAUDJPY";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const GR = 1800; // 30m
const FETCH = 7000;
const MIN_TRADES_PER_MONTH = 3;

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

function obParams(over: any = {}) {
  return { lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0, ...over };
}

type Variant = { name: string; params: any; filters: any };

// 30m exploration: anchor on raw defaults; sweep axes scaled for 30m bars.
// 1 bar = 30 min, so lookback=24 = 12h, lookback=48 = 24h.
const variants: Variant[] = [
  // baseline anchor (30m raw)
  { name: "raw default·3:1",                       params: obParams(),                                                              filters: {} },
  // R:R sweep
  { name: "raw·4:1",                               params: obParams({ targetRMult: 4 }),                                            filters: {} },
  { name: "raw·5:1",                               params: obParams({ targetRMult: 5 }),                                            filters: {} },
  // displacement (high-vol pair)
  { name: "disp=1.0·3:1",                          params: obParams({ displacementAtrMultiplier: 1.0 }),                            filters: {} },
  { name: "disp=1.2·3:1",                          params: obParams({ displacementAtrMultiplier: 1.2 }),                            filters: {} },
  { name: "disp=1.5·3:1",                          params: obParams({ displacementAtrMultiplier: 1.5 }),                            filters: {} },
  // lookback scaled for 30m (1d ≈ 48 bars)
  { name: "lookback=24·3:1 (12h)",                 params: obParams({ lookback: 24 }),                                              filters: {} },
  { name: "lookback=36·3:1 (18h)",                 params: obParams({ lookback: 36 }),                                              filters: {} },
  { name: "lookback=48·3:1 (24h)",                 params: obParams({ lookback: 48 }),                                              filters: {} },
  // obSearchMaxBack
  { name: "obSearch=5·3:1",                        params: obParams({ obSearchMaxBack: 5 }),                                        filters: {} },
  { name: "obSearch=7·3:1",                        params: obParams({ obSearchMaxBack: 7 }),                                        filters: {} },
  // ADX bands
  { name: "minAdx=22·3:1",                         params: obParams(),                                                              filters: { minAdx: 22 } },
  { name: "minAdx=25·3:1",                         params: obParams(),                                                              filters: { minAdx: 25 } },
  { name: "minAdx=28·3:1",                         params: obParams(),                                                              filters: { minAdx: 28 } },
  // side bias
  { name: "BUY·3:1",                               params: obParams(),                                                              filters: { buyOnly: true } },
  { name: "BUY·4:1",                               params: obParams({ targetRMult: 4 }),                                            filters: { buyOnly: true } },
  { name: "SELL·3:1",                              params: obParams(),                                                              filters: { sellOnly: true } },
  // 4-candle validation
  { name: "4candleValid·3:1",                      params: obParams({ fourCandleValidation: 1 }),                                   filters: {} },
  // retestConfirmationBars
  { name: "retestBars=1·3:1",                      params: obParams({ retestConfirmationBars: 1 }),                                 filters: {} },
  { name: "retestBars=3·3:1",                      params: obParams({ retestConfirmationBars: 3 }),                                 filters: {} },
  // pair compounds (best-of plateau test)
  { name: "BUY+minAdx=25·4:1",                     params: obParams({ targetRMult: 4 }),                                            filters: { buyOnly: true, minAdx: 25 } },
  { name: "BUY+lookback=48·4:1",                   params: obParams({ lookback: 48, targetRMult: 4 }),                              filters: { buyOnly: true } },
  { name: "minAdx=25+lookback=48·4:1",             params: obParams({ lookback: 48, targetRMult: 4 }),                              filters: { minAdx: 25 } },
  { name: "BUY+minAdx=25+lookback=48·4:1",         params: obParams({ lookback: 48, targetRMult: 4 }),                              filters: { buyOnly: true, minAdx: 25 } },
];

function monthKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function runVariant(v: Variant, candles: Candle[], gr: number) {
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
  return r.trades.map((t) => ({
    epoch: candles[t.openedAtIndex].epoch,
    pnlUsd: STAKE * Math.max(-1, t.pnlPct * MULT),
  }));
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`AUD/JPY OB month-by-month walk-forward · ${variants.length} variants · 30m\n`);
  process.stdout.write("");

  const candles = await fetchPaged(c, SYMBOL, GR, FETCH);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars`); return; }

  const fromDate = new Date(candles[0].epoch * 1000).toISOString().slice(0, 10);
  const toDate = new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 10);
  console.log(`${candles.length} bars · ${fromDate} → ${toDate}\n`);
  process.stdout.write("");

  // discover months in data, only count months with ≥80% bar coverage (skip partial first/last)
  const monthBars = new Map<string, number>();
  for (const cn of candles) {
    const k = monthKey(cn.epoch);
    monthBars.set(k, (monthBars.get(k) ?? 0) + 1);
  }
  const allMonths = Array.from(monthBars.keys()).sort();
  // expected bars per month at 1h ≈ 24 × 22 trading days = ~528 (FX runs Sun open → Fri close)
  const fullMonths = allMonths.filter((k) => (monthBars.get(k) ?? 0) >= 350);
  console.log(`Months in data: ${allMonths.join(", ")}`);
  console.log(`Full-coverage months tested: ${fullMonths.join(", ")}\n`);
  process.stdout.write("");

  type Row = { name: string; perMonth: Map<string, { pnl: number; trades: number }>; total: number; winningMonths: number; losingMonths: number; flatMonths: number };
  const rows: Row[] = [];
  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const trades = await runVariant(v, candles, GR);
    const perMonth = new Map<string, { pnl: number; trades: number }>();
    for (const m of fullMonths) perMonth.set(m, { pnl: 0, trades: 0 });
    for (const t of trades) {
      const k = monthKey(t.epoch);
      const cur = perMonth.get(k);
      if (cur) { cur.pnl += t.pnlUsd; cur.trades += 1; }
    }
    let total = 0, win = 0, lose = 0, flat = 0;
    for (const m of fullMonths) {
      const cur = perMonth.get(m)!;
      total += cur.pnl;
      if (cur.trades < MIN_TRADES_PER_MONTH) flat += 1;
      else if (cur.pnl > 0) win += 1;
      else if (cur.pnl < 0) lose += 1;
      else flat += 1;
    }
    rows.push({ name: v.name, perMonth, total, winningMonths: win, losingMonths: lose, flatMonths: flat });
    process.stdout.write(`  [${String(i+1).padStart(2)}/${variants.length}] ${v.name.padEnd(30)} W:${win} L:${lose} F:${flat} total $${total.toFixed(0)}\n`);
  }

  // Print matrix
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`MONTHLY MATRIX (per-month $)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  const hdr = "  variant".padEnd(32) + fullMonths.map((m) => m.padStart(9)).join("") + "    total   W/L/F";
  console.log(hdr);
  rows.sort((a, b) => (b.winningMonths - b.losingMonths) - (a.winningMonths - a.losingMonths) || b.total - a.total);
  for (const r of rows) {
    const cells = fullMonths.map((m) => {
      const c = r.perMonth.get(m)!;
      if (c.trades < MIN_TRADES_PER_MONTH) return "    -    ";
      return `${c.pnl >= 0 ? "+" : ""}${c.pnl.toFixed(0)}`.padStart(9);
    });
    console.log(`  ${r.name.padEnd(30)}${cells.join("")}  ${r.total >= 0 ? "+" : ""}$${r.total.toFixed(0).padStart(5)}  ${r.winningMonths}/${r.losingMonths}/${r.flatMonths}`);
  }

  // Find "only winning" variants
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`ONLY-WINNING VARIANTS (positive in every full-coverage month)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  const purewinners = rows.filter((r) => r.losingMonths === 0 && r.winningMonths >= 2);
  if (purewinners.length === 0) {
    console.log(`  ❌ None. Closest: ${rows[0].name} (W:${rows[0].winningMonths} L:${rows[0].losingMonths})`);
    // Identify which month is the worst killer
    const monthLosers = new Map<string, number>();
    for (const m of fullMonths) {
      let count = 0;
      for (const r of rows) {
        const c = r.perMonth.get(m)!;
        if (c.trades >= MIN_TRADES_PER_MONTH && c.pnl < 0) count++;
      }
      monthLosers.set(m, count);
    }
    console.log(`\n  Month-by-month variant-loss counts (out of ${variants.length}):`);
    for (const m of fullMonths) {
      console.log(`    ${m}: ${monthLosers.get(m)} losing variants`);
    }
  } else {
    for (const r of purewinners) {
      console.log(`  ✓ ${r.name.padEnd(30)} W:${r.winningMonths} total +$${r.total.toFixed(0)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

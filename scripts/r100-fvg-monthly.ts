// R_100 FVG iter 2 — plateau check around iter 1 best: adx[18,38]·3:1 +$812 (5/1, Mar -$1).
// Test ADX band perturbations and small param tweaks to see if the result is robust.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "R_100";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const GR = 3600; // 1h
const FETCH = 4000;
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

function fvgParams(over: any = {}) {
  return { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12,
    targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0, ...over };
}

type Variant = { name: string; params: any; filters: any };

const variants: Variant[] = [
  // baseline carry-overs
  { name: "iter1: adx[18,38]·3:1",                 params: fvgParams(),                                                             filters: { minAdx: 18, maxAdx: 38 } },
  { name: "iter1: minGap=0.70·3:1",                params: fvgParams({ minGapAtrMul: 0.70 }),                                       filters: {} },
  { name: "iter1: maxAdx=35·3:1",                  params: fvgParams(),                                                             filters: { maxAdx: 35 } },
  // adx band perturbations
  { name: "adx[16,38]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 16, maxAdx: 38 } },
  { name: "adx[20,38]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 20, maxAdx: 38 } },
  { name: "adx[18,36]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 18, maxAdx: 36 } },
  { name: "adx[18,40]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 18, maxAdx: 40 } },
  { name: "adx[18,42]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 18, maxAdx: 42 } },
  { name: "adx[20,40]·3:1",                        params: fvgParams(),                                                             filters: { minAdx: 20, maxAdx: 40 } },
  // base + R:R variations
  { name: "adx[18,38]·2:1",                        params: fvgParams({ targetRMult: 2 }),                                           filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]·2.5:1",                      params: fvgParams({ targetRMult: 2.5 }),                                         filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]·4:1",                        params: fvgParams({ targetRMult: 4 }),                                           filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]·5:1",                        params: fvgParams({ targetRMult: 5 }),                                           filters: { minAdx: 18, maxAdx: 38 } },
  // base + minGap variations
  { name: "adx[18,38]+minGap=0.10",                params: fvgParams({ minGapAtrMul: 0.10 }),                                       filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]+minGap=0.20",                params: fvgParams({ minGapAtrMul: 0.20 }),                                       filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]+minGap=0.30",                params: fvgParams({ minGapAtrMul: 0.30 }),                                       filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]+minGap=0.50",                params: fvgParams({ minGapAtrMul: 0.50 }),                                       filters: { minAdx: 18, maxAdx: 38 } },
  // base + stopBuf variations
  { name: "adx[18,38]+sb=0.05",                    params: fvgParams({ stopBufferAtrMul: 0.05 }),                                   filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]+sb=0.20",                    params: fvgParams({ stopBufferAtrMul: 0.20 }),                                   filters: { minAdx: 18, maxAdx: 38 } },
  // base + ce
  { name: "adx[18,38]+ce·3:1",                     params: fvgParams({ entryDepth: 1 }),                                            filters: { minAdx: 18, maxAdx: 38 } },
  // base + requireRej
  { name: "adx[18,38]+rej·3:1",                    params: fvgParams({ requireRejection: 1 }),                                      filters: { minAdx: 18, maxAdx: 38 } },
  // base + atr
  { name: "adx[18,38]+atr=10",                     params: fvgParams({ atrPeriod: 10 }),                                            filters: { minAdx: 18, maxAdx: 38 } },
  { name: "adx[18,38]+atr=21",                     params: fvgParams({ atrPeriod: 21 }),                                            filters: { minAdx: 18, maxAdx: 38 } },
  // try minGap=0.70 + adx (combine 2 winners)
  { name: "minGap=0.70+adx[18,38]",                params: fvgParams({ minGapAtrMul: 0.70 }),                                       filters: { minAdx: 18, maxAdx: 38 } },
];

function monthKey(epoch: number): string {
  const d = new Date(epoch * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function runVariant(v: Variant, candles: Candle[], gr: number) {
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
  return r.trades.map((t) => ({
    epoch: candles[t.openedAtIndex].epoch,
    pnlUsd: STAKE * Math.max(-1, t.pnlPct * MULT),
  }));
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`R_100 FVG month-by-month walk-forward · ${variants.length} variants · 1h\n`);
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

// ETH OB at 15m TF — never tested before. Run candidate sweep at 15m to see
// if a different TF gives better edge than the validated 1h config.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryETHUSD";
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res, rej) => { this.ws.on("open", () => res()); this.ws.on("error", rej); });
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: string = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of collected) if (!seen.has(c.epoch)) { seen.add(c.epoch); out.push(c); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
    ...over,
  };
}

type Variant = { name: string; params: Record<string, number>; filters: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }> };
const variants: Variant[] = [
  // Apply our 1h winner config to 15m
  { name: "with-trend@20 · 6:1 (1h winner config)",       params: basePs({ targetRMult: 6.0 }),                              filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 4:1",                          params: basePs({ targetRMult: 4.0 }),                              filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 ce · 4:1",                       params: basePs({ entryDepth: 1, targetRMult: 4.0 }),               filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 3:1",                          params: basePs(),                                                  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 5:1",                          params: basePs({ targetRMult: 5.0 }),                              filters: { withTrendOnlyAboveAdx: 20 } },
  // Try Silver-OB style at 15m on ETH (maxAdx<22, edge entry)
  { name: "Silver-style: maxAdx<22 · 3:1",                params: basePs(),                                                  filters: { maxAdx: 22 } },
  { name: "Silver-style: maxAdx<22 · 4:1",                params: basePs({ targetRMult: 4.0 }),                              filters: { maxAdx: 22 } },
  // No filter
  { name: "no filter · 3:1",                              params: basePs(),                                                  filters: {} },
  { name: "no filter · 4:1",                              params: basePs({ targetRMult: 4.0 }),                              filters: {} },
  { name: "no filter · 6:1",                              params: basePs({ targetRMult: 6.0 }),                              filters: {} },
  // FVG-required at 15m
  { name: "+FVG · 3:1 + with-trend@20",                   params: basePs({ requireFVG: 1 }),                                 filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "+FVG · 4:1 + with-trend@20",                   params: basePs({ requireFVG: 1, targetRMult: 4.0 }),               filters: { withTrendOnlyAboveAdx: 20 } },
  // Stricter displacement
  { name: "disp1.2 + with-trend@20 · 4:1",                params: basePs({ displacementAtrMultiplier: 1.2, targetRMult: 4.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "disp1.5 + with-trend@20 · 4:1",                params: basePs({ displacementAtrMultiplier: 1.5, targetRMult: 4.0 }), filters: { withTrendOnlyAboveAdx: 20 } },
];

async function main() {
  const c = new C(); await c.ready;
  console.log(`[eth-ob-15m] ETH / 15m TF — never tested. Trying max history.\n`);
  const candles = await fetchPaged(c, SYMBOL, 900, 9500);
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars; abort`); return; }

  const days = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
  console.log(`fetched ${candles.length} 15m bars (~${Math.round(days)} days)\n`);
  console.log(`  ${"variant".padEnd(48)}  trades  WR    expR    P&L $    qualifies?`);

  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === "orderBlock",
      params: d.id === "orderBlock" ? v.params : d.params,
    }));
    const r = await runBacktest({
      symbol: SYMBOL, granularity: 900 as any, count: candles.length,
      atrSlMult: 1.0, atrTpMult: v.params.targetRMult ?? 3.0, costBps: COST_BPS,
      ...v.filters,
      detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, candles);
    const wins = r.trades.filter((t) => t.pnlPct > 0).length;
    let totalR = 0, pnlUsd = 0;
    for (const t of r.trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totalR += t.pnlPct / risk;
      pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
    }
    const expR = r.trades.length ? totalR / r.trades.length : 0;
    rows.push({ name: v.name, trades: r.trades.length, wins, expR, pnlUsd });
    const wr = r.trades.length ? `${(100*wins/r.trades.length).toFixed(0)}%` : "—";
    const qualifies = r.trades.length >= 30 && pnlUsd >= 200;
    console.log(`  ${v.name.padEnd(48)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}    ${qualifies ? "  ✓" : ""}`);
  }

  console.log(`\nTOP 5 by P&L $ (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(48)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );

  // Compare to current 1h saved config
  console.log(`\n— Comparison —`);
  console.log(`  Current 1h saved: 71 trades / 24% WR / +0.23R / +$552 over 333 days`);
}
main().catch((e) => { console.error(e); process.exit(1); });

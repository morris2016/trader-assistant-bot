// Test ETH OB tweak combinations identified by feature analysis:
// - maxAdx=40 cap (kills the ADX>40 cliff)
// - skip Saturdays (0% WR weekend trades)
// - BUY-only (BUYs +0.38R vs SELLs +0.05R)

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

const obParams: Record<string, number> = {
  lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
  requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
  fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
  rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 6.0,
};

type Variant = {
  name: string;
  filters: {
    withTrendOnlyAboveAdx?: number;
    maxAdx?: number;
    skipDaysOfWeekUtc?: number[];
    buyOnly?: boolean;
  };
};

const variants: Variant[] = [
  { name: "BASELINE: with-trend@20 · 6:1 (saved)",       filters: { withTrendOnlyAboveAdx: 20 } },
  // Single-knob tweaks
  { name: "+ maxAdx=40 (cap)",                           filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40 } },
  { name: "+ maxAdx=35",                                 filters: { withTrendOnlyAboveAdx: 20, maxAdx: 35 } },
  { name: "+ skip Saturday",                             filters: { withTrendOnlyAboveAdx: 20, skipDaysOfWeekUtc: [6] } },
  { name: "+ skip Sat + Sun",                            filters: { withTrendOnlyAboveAdx: 20, skipDaysOfWeekUtc: [0, 6] } },
  { name: "+ BUY-only",                                  filters: { withTrendOnlyAboveAdx: 20, buyOnly: true } },
  // Two-knob combos
  { name: "+ maxAdx=40 + skip Sat",                      filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40, skipDaysOfWeekUtc: [6] } },
  { name: "+ maxAdx=40 + BUY-only",                      filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40, buyOnly: true } },
  { name: "+ skip Sat + BUY-only",                       filters: { withTrendOnlyAboveAdx: 20, skipDaysOfWeekUtc: [6], buyOnly: true } },
  // Three-knob
  { name: "+ maxAdx=40 + skip Sat + BUY-only (★)",       filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40, skipDaysOfWeekUtc: [6], buyOnly: true } },
  { name: "+ maxAdx=35 + skip Sat + BUY-only",           filters: { withTrendOnlyAboveAdx: 20, maxAdx: 35, skipDaysOfWeekUtc: [6], buyOnly: true } },
  // Aggressive: skip both weekend days + cap
  { name: "+ maxAdx=40 + skip Sat+Sun + BUY-only",       filters: { withTrendOnlyAboveAdx: 20, maxAdx: 40, skipDaysOfWeekUtc: [0, 6], buyOnly: true } },
];

async function main() {
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYMBOL, 3600, 8000);
  c.close();
  console.log(`[eth-ob-tweaks] ${candles.length} bars (~333d). Testing tweaks vs baseline.\n`);
  console.log(`  ${"variant".padEnd(54)}  trades  WR    expR     P&L $`);

  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === "orderBlock",
      params: d.id === "orderBlock" ? obParams : d.params,
    }));
    const r = await runBacktest({
      symbol: SYMBOL, granularity: 3600 as any, count: candles.length,
      atrSlMult: 1.0, atrTpMult: 6.0, costBps: COST_BPS,
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
    console.log(`  ${v.name.padEnd(54)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}`);
  }
  console.log(`\nTOP 5 by P&L $ (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(54)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
  console.log(`\nTOP 5 by Expectancy R (≥30 trades):`);
  rows.filter((r) => r.trades >= 30).sort((a, b) => b.expR - a.expR).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(54)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/r.trades).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
}
main().catch((e) => { console.error(e); process.exit(1); });

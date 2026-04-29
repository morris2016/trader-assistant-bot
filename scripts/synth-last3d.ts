// Last-3-days fire test for the 3 iter-1 winners. Per-day breakdown so we can
// see actual recent frequency + per-day P&L. No new parameters — use the
// validated iter-1 configs verbatim.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30; const COST_BPS = 5.0;
const WINDOW_DAYS = 3;
const FETCH_BARS_BY_GR: Record<number, number> = { 900: 8000, 3600: 6000 };

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} });
  }
  send(p: any): Promise<any> { const id = this.reqId++; return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...p, req_id: id })); setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
  close() { this.ws.close(); }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

type Cfg = {
  label: string;
  symbol: string;
  granularity: number;
  detector: "fvg" | "liquiditySweep" | "orderBlock";
  params: Record<string, number>;
  filters: Record<string, any>;
};

// HIGH-FREQUENCY top 3 — switched to 15m for daily/hourly fire cadence.
// One variant per asset (no doubling on JD100).
const winners: Cfg[] = [
  {
    label: "JD100 FVG 15m raw·3:1 (10.6/day, +$682 sum)",
    symbol: "JD100",
    granularity: 900,
    detector: "fvg",
    params: { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12, targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0 },
    filters: {},
  },
  {
    label: "RDBULL FVG 15m raw·3:1 (9.5/day, +$889 sum)",
    symbol: "RDBULL",
    granularity: 900,
    detector: "fvg",
    params: { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12, targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0 },
    filters: {},
  },
  {
    label: "BOOM300N OB 15m raw·3:1 (2.1/day, +$301 sum)",
    symbol: "BOOM300N",
    granularity: 900,
    detector: "orderBlock",
    params: { lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3, requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30, fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0, rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0 },
    filters: {},
  },
];

function dayKey(epoch: number): string { return new Date(epoch * 1000).toISOString().slice(0, 10); }

async function main() {
  const c = new C(); await c.ready;
  console.log(`Synth high-freq winners — last ${WINDOW_DAYS} days fire test\n`);

  for (const w of winners) {
    process.stdout.write(`${w.label}\n`);
    let candles: Candle[];
    try { candles = await fetchPaged(c, w.symbol, w.granularity, FETCH_BARS_BY_GR[w.granularity] ?? 6000); }
    catch (e) { console.log(`  fetch fail: ${(e as Error).message}\n`); continue; }
    if (candles.length < 1000) { console.log(`  only ${candles.length} bars\n`); continue; }

    const lastEpoch = candles[candles.length - 1].epoch;
    const startEpoch = lastEpoch - WINDOW_DAYS * 86400;

    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === w.detector,
      params: d.id === w.detector ? w.params : d.params,
    }));
    const r = await runBacktest({
      symbol: w.symbol as any, granularity: w.granularity as any, count: candles.length,
      atrSlMult: 1.0, atrTpMult: w.params.targetRMult ?? 3.0, costBps: COST_BPS,
      ...w.filters,
      detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    } as any, candles);

    const inWin = r.trades
      .map((t) => ({ ...t, epoch: candles[t.openedAtIndex].epoch }))
      .filter((t) => t.epoch >= startEpoch);

    const perDay = new Map<string, { trades: number; pnl: number; wins: number; losses: number }>();
    let totalPnl = 0;
    for (const t of inWin) {
      const k = dayKey(t.epoch);
      const cur = perDay.get(k) ?? { trades: 0, pnl: 0, wins: 0, losses: 0 };
      const pnl = STAKE * Math.max(-1, t.pnlPct * MULT);
      cur.trades += 1; cur.pnl += pnl; totalPnl += pnl;
      if (t.pnlPct > 0) cur.wins += 1; else if (t.pnlPct < 0) cur.losses += 1;
      perDay.set(k, cur);
    }

    const days = Array.from(perDay.keys()).sort();
    if (days.length === 0) {
      console.log(`  No trades in last ${WINDOW_DAYS} days.\n`);
      continue;
    }
    for (const d of days) {
      const s = perDay.get(d)!;
      console.log(`    ${d}  ${String(s.trades).padStart(2)}t  ${s.wins}W/${s.losses}L  ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`);
    }
    console.log(`    TOTAL    ${String(inWin.length).padStart(2)}t  →  ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)} · ${(inWin.length / WINDOW_DAYS).toFixed(2)} trades/day\n`);
  }

  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

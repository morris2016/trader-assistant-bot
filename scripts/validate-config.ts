// Validate the Silver-derived config across all real-history symbols.
// Same setup: 15m, OB-only, ADX<22, structural stops, 5 bps cost.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { SYMBOLS } from "../src/shared/symbols";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const GRANULARITY = 900;
const COUNT = 8000;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => { this.ws.on("open", () => resolve()); this.ws.on("error", reject); });
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

async function main() {
  const real = SYMBOLS.filter((s) => s.group !== "Synthetic");
  const c = new C();
  await c.ready;
  console.log(`[validate] Silver-derived config: 15m × OB-only × ADX<22 × structural stops × 5bps cost\n`);

  const obParams: Record<string, number> = {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
  };
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? obParams : d.params,
  }));

  type Row = { sym: string; lbl: string; group: string; bars: number; trades: number; wins: number; expR: number; pnlPct: number; pnlUsd: number; qualifies: boolean };
  const rows: Row[] = [];

  for (const def of real) {
    process.stdout.write(`  ${def.label.padEnd(22)} `);
    let cs: Candle[]; try { cs = await fetchPaged(c, def.code, GRANULARITY, COUNT); }
    catch (e) { console.log(`SKIP (${(e as Error).message})`); continue; }
    if (cs.length < 200) { console.log(`SKIP (${cs.length} bars)`); continue; }

    const r = await runBacktest({
      symbol: def.code, granularity: GRANULARITY as any, count: cs.length,
      atrSlMult: 1.0, atrTpMult: 2.0, costBps: 5.0, maxAdx: 22,
      detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, cs);
    const wins = r.trades.filter((t) => t.pnlPct > 0).length;
    let totalR = 0, pnlUsd = 0;
    for (const t of r.trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totalR += t.pnlPct / risk;
      pnlUsd += 50 * Math.max(-1, t.pnlPct * 30);
    }
    const expR = r.trades.length ? totalR / r.trades.length : 0;
    const qualifies = r.trades.length >= 20 && expR >= 0.20;
    rows.push({ sym: def.code, lbl: def.label, group: def.group, bars: cs.length, trades: r.trades.length, wins, expR, pnlPct: r.stats.totalPnlPct, pnlUsd, qualifies });
    console.log(`${cs.length} bars · ${r.trades.length} trades · ${wins}W · expR=${expR >= 0 ? "+" : ""}${expR.toFixed(2)} · ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)} ${qualifies ? "✓" : ""}`);
  }
  c.close();

  rows.sort((a, b) => b.expR - a.expR);
  console.log(`\n=== LEADERBOARD (sorted by Expectancy R) ===`);
  console.log(`Symbol                 Group        Bars  Trades   Wins   Exp R    P&L $   Qualifies`);
  for (const r of rows) {
    console.log(
      `${r.lbl.padEnd(22)} ${r.group.padEnd(12)} ${String(r.bars).padStart(5)} ${String(r.trades).padStart(7)} ${String(r.wins).padStart(6)} ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2) + "R"} ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)} ${r.qualifies ? "  ✓" : ""}`,
    );
  }

  const qualified = rows.filter((r) => r.qualifies);
  console.log(`\n=== ${qualified.length} symbol(s) clear ≥ +0.20R on ≥ 20 trades ===`);
  for (const q of qualified) {
    console.log(`  ${q.lbl} — ${q.trades} trades, ${(100*q.wins/q.trades).toFixed(0)}% WR, ${q.expR >= 0 ? "+" : ""}${q.expR.toFixed(2)}R, ${q.pnlUsd >= 0 ? "+" : ""}$${q.pnlUsd.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

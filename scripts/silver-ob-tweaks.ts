// Silver OB tweaks — exploration only. NO permanent changes.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = silverOb.symbols[0];
const STAKE = silverOb.validation.stake;
const MULT = silverOb.validation.multiplier;

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

type Variant = {
  name: string;
  filters: { maxAdx?: number; minAdx?: number; skipDaysOfWeekUtc?: number[]; buyOnly?: boolean };
};

const variants: Variant[] = [
  { name: "BASELINE: maxAdx=22 (saved)",                filters: { maxAdx: 22 } },
  // ADX tightening
  { name: "+ tighten maxAdx=20",                        filters: { maxAdx: 20 } },
  { name: "+ tighten maxAdx=18 (sweet spot bucket)",    filters: { maxAdx: 18 } },
  { name: "+ ADX 15-18 only (minAdx=15, max=18)",       filters: { maxAdx: 18, minAdx: 15 } },
  // Side filtering
  { name: "+ BUY-only (saved maxAdx=22)",               filters: { maxAdx: 22, buyOnly: true } },
  { name: "+ BUY-only + maxAdx=18",                     filters: { maxAdx: 18, buyOnly: true } },
  // Day filtering
  { name: "+ skip Tuesday",                             filters: { maxAdx: 22, skipDaysOfWeekUtc: [2] } },
  { name: "+ skip Tue + Fri",                           filters: { maxAdx: 22, skipDaysOfWeekUtc: [2, 5] } },
  // Combos
  { name: "+ maxAdx=20 + skip Tue",                     filters: { maxAdx: 20, skipDaysOfWeekUtc: [2] } },
  { name: "+ maxAdx=18 + skip Tue",                     filters: { maxAdx: 18, skipDaysOfWeekUtc: [2] } },
  { name: "+ maxAdx=18 + BUY-only + skip Tue",          filters: { maxAdx: 18, buyOnly: true, skipDaysOfWeekUtc: [2] } },
];

async function main() {
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYMBOL, silverOb.granularity, 9500);
  c.close();
  console.log(`[silver-ob-tweaks] ${candles.length} 15m bars (~52d). Saved baseline: 22 trades, 41% WR, +0.49R, +$227.\n`);
  console.log(`  ${"variant".padEnd(50)}  trades  WR    expR    P&L $`);

  type Row = { name: string; trades: number; wins: number; expR: number; pnlUsd: number };
  const rows: Row[] = [];
  for (const v of variants) {
    const r = await runBacktest({
      symbol: SYMBOL, granularity: silverOb.granularity as any, count: candles.length,
      atrSlMult: silverOb.atrSlMult, atrTpMult: silverOb.atrTpMult, costBps: silverOb.costBps,
      ...v.filters,
      detectors: silverOb.detectors,
      strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
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
    console.log(`  ${v.name.padEnd(50)}  ${String(r.trades.length).padStart(3)}    ${wr.padStart(3)}   ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R   ${(pnlUsd >= 0 ? "+" : "") + "$" + pnlUsd.toFixed(2)}`);
  }
  console.log(`\nTOP 5 by P&L $:`);
  rows.sort((a, b) => b.pnlUsd - a.pnlUsd).slice(0, 5).forEach((r) =>
    console.log(`  ${r.name.padEnd(50)}  ${String(r.trades).padStart(3)}t · WR ${(100*r.wins/Math.max(1,r.trades)).toFixed(0)}% · expR ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R · ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}`),
  );
}
main().catch((e) => { console.error(e); process.exit(1); });

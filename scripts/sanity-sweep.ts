import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryLTCUSD";

class C { ws: WebSocket; reqId = 1; pending = new Map<number, any>(); ready: Promise<void>;
  constructor() { this.ws = new WebSocket(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); const id = m.req_id;
      if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(p: any): Promise<any> { const id = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id })); setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
  close() { this.ws.close(); } }

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) { const want = Math.min(5000, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<any>; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break; }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out; }

async function main() {
  const c = new C(); await c.ready;
  const all = await fetchPaged(c, SYMBOL, 3600, 5500); c.close();
  console.log(`fetched ${all.length} bars: ${new Date(all[0].epoch*1000).toISOString().slice(0,10)} → ${new Date(all[all.length-1].epoch*1000).toISOString().slice(0,10)}`);
  // Test 1: DEFAULT params, no sellOnly
  const det1 = defaultDetectorConfigs().map((d) => ({ ...d, enabled: d.id === "liquiditySweep" }));
  const r1 = await runBacktest({ symbol: SYMBOL, granularity: 3600 as any, count: all.length, atrSlMult: 1.0, atrTpMult: 3.0, costBps: 5.0,
    detectors: det1, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 } } as any, all);
  console.log(`Test 1 (default, no filter): ${r1.trades.length} trades`);
  if (r1.trades.length > 0) {
    console.log(`  first: ${new Date(all[r1.trades[0].openedAtIndex].epoch*1000).toISOString().slice(0,10)}`);
    console.log(`  last:  ${new Date(all[r1.trades[r1.trades.length-1].openedAtIndex].epoch*1000).toISOString().slice(0,10)}`);
  }
  // Test 2: TUNED params, no sellOnly
  const det2 = defaultDetectorConfigs().map((d) => ({ ...d, enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep" ? { atrPeriod: 14, equalToleranceAtrMul: 0.15, minEqualCount: 2, lookbackBars: 45,
      confirmationWindow: 6, poolRetentionBarsAfterSweep: 20, swingLeft: 1, swingRight: 1, targetRMult: 4.0, entryOnSweep: 0, stopBufferAtrMul: 0.25 } : d.params }));
  const r2 = await runBacktest({ symbol: SYMBOL, granularity: 3600 as any, count: all.length, atrSlMult: 1.0, atrTpMult: 4.0, costBps: 5.0,
    detectors: det2, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 } } as any, all);
  console.log(`Test 2 (tuned, no filter): ${r2.trades.length} trades`);
  if (r2.trades.length > 0) {
    console.log(`  first: ${new Date(all[r2.trades[0].openedAtIndex].epoch*1000).toISOString().slice(0,10)}`);
    console.log(`  last:  ${new Date(all[r2.trades[r2.trades.length-1].openedAtIndex].epoch*1000).toISOString().slice(0,10)}`);
  }
  // Test 3: TUNED params + sellOnly
  const r = await runBacktest({ symbol: SYMBOL, granularity: 3600 as any, count: all.length, atrSlMult: 1.0, atrTpMult: 4.0, costBps: 5.0,
    sellOnly: true, detectors: det2, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 } } as any, all);
  console.log(`Test 3 (tuned + SELL-only): ${r.trades.length} trades`);
  if (r.trades.length > 0) {
    const first = r.trades[0]; const last = r.trades[r.trades.length - 1];
    console.log(`First trade idx=${first.openedAtIndex} epoch=${all[first.openedAtIndex].epoch} (${new Date(all[first.openedAtIndex].epoch*1000).toISOString().slice(0,10)}) side=${first.side}`);
    console.log(`Last trade idx=${last.openedAtIndex} epoch=${all[last.openedAtIndex].epoch} (${new Date(all[last.openedAtIndex].epoch*1000).toISOString().slice(0,10)}) side=${last.side}`);
    const inDecFeb = r.trades.filter((t) => all[t.openedAtIndex].epoch >= 1764547200 && all[t.openedAtIndex].epoch < 1772582400).length;
    console.log(`Trades in Dec 1, 2025 - Feb 28, 2026: ${inDecFeb}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

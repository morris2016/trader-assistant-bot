// Verify production-logged bars vs Deriv historical at the same epochs.
// Production logged 2 new bars after fix-deploy (12:35 and 12:40 UTC May 3).
// Compare them to historical fetch — if matching, post-fix data flow is clean.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const LOOKBACK = 15, MOM_RATIO = 0.7;

// Production-logged bars from latest log (post-deploy at 12:31 UTC May 3)
const PROD = {
  RDBEAR: [
    { epoch: 1777811700, close: 974.68 },     // 12:35 UTC
    { epoch: 1777812000, close: 976.8182 },   // 12:40 UTC
  ],
  RDBULL: [
    { epoch: 1777811700, close: 1046.1598 },
    { epoch: 1777812000, close: 1046.2777 },
  ],
};

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchLatest(c: C, sym: string, count: number): Promise<Candle[]> {
  const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count, end: "latest", style: "candles", granularity: 300 });
  const raw = (r.candles ?? []) as any[];
  return raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
    .sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

async function main() {
  const c = new C(); await c.ready;
  const [bear, bull] = await Promise.all([fetchLatest(c, "RDBEAR", 200), fetchLatest(c, "RDBULL", 200)]);
  c.close();

  console.log(`${"".padEnd(90, "═")}`);
  console.log(`POST-DEPLOY BAR-BY-BAR COMPARISON (production log vs Deriv historical)`);
  console.log(`${"".padEnd(90, "═")}`);

  for (const [sym, prodBars, candles] of [["RDBEAR", PROD.RDBEAR, bear], ["RDBULL", PROD.RDBULL, bull]] as const) {
    console.log(`\n--- ${sym} ---`);
    console.log(`  epoch       UTC time         prod close    hist close    diff      pierce-eval`);
    for (const pb of prodBars) {
      const idx = candles.findIndex((c) => c.epoch === pb.epoch);
      if (idx < 0) { console.log(`  ${pb.epoch}  MISSING in hist`); continue; }
      const hist = candles[idx];
      const diff = Math.abs(pb.close - hist.close);
      const match = diff < 0.001 ? "✓ MATCH" : `✗ DIFF ${diff.toFixed(4)}`;
      // Detector eval on hist data (15-bar lookback)
      let evalStr = "—";
      if (idx >= LOOKBACK + 14) {
        const a = atr(candles, idx, 14);
        let hi = -Infinity, lo = Infinity;
        for (let m = idx - LOOKBACK; m < idx; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
        const r = hist.high - hist.low;
        const cpu = r > 0 ? (hist.close - hist.low) / r : 0;
        const cpd = r > 0 ? (hist.high - hist.close) / r : 0;
        const upPierce = hist.close > hi && cpu >= MOM_RATIO;
        const dnPierce = hist.close < lo && cpd >= MOM_RATIO;
        if (upPierce) evalStr = `UP-pierce (close>${hi.toFixed(2)}, cpu=${cpu.toFixed(2)})`;
        else if (dnPierce) evalStr = `DN-pierce (close<${lo.toFixed(2)}, cpd=${cpd.toFixed(2)})`;
        else evalStr = `no-pierce (close=${hist.close.toFixed(2)} vs hi=${hi.toFixed(2)} lo=${lo.toFixed(2)} cpu=${cpu.toFixed(2)} cpd=${cpd.toFixed(2)})`;
      }
      const tsStr = new Date(pb.epoch * 1000).toISOString().slice(11, 19);
      console.log(`  ${pb.epoch}  ${tsStr}        ${pb.close.toFixed(4)}     ${hist.close.toFixed(4)}    ${match}    ${evalStr}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

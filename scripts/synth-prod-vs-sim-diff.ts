// Compare production bot's logged bars vs Deriv historical fetch for the
// same epochs. Run the EXACT detector logic from production on those bars
// and report what should have fired. Find the discrepancy.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7, GR = 300;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

// Bars logged by production from trader-bot-logs-2026-05-02T23-57-37-624Z.ndjson
const PROD_BARS_RDBEAR: Array<{ epoch: number; close: number }> = [
  { epoch: 1777792200, close: 942.3365 }, // 07:10
  { epoch: 1777792500, close: 940.7504 }, // 07:15
  { epoch: 1777792800, close: 936.9167 }, // 07:20
  { epoch: 1777793100, close: 935.8223 }, // 07:25
  { epoch: 1777793400, close: 930.4103 }, // 07:30
  { epoch: 1777793700, close: 933.7682 }, // 07:35
  { epoch: 1777794000, close: 937.1756 }, // 07:40
  { epoch: 1777794300, close: 943.9238 }, // 07:45
  { epoch: 1777794600, close: 949.5552 }, // 07:50
];
const PROD_BARS_RDBULL: Array<{ epoch: number; close: number }> = [
  { epoch: 1777792200, close: 991.4985 },
  { epoch: 1777792500, close: 994.2604 },
  { epoch: 1777792800, close: 1005.0454 },
  { epoch: 1777793100, close: 1017.9543 },
  { epoch: 1777793400, close: 1007.4087 },
  { epoch: 1777793700, close: 995.8395 },
  { epoch: 1777794000, close: 996.055 },
  { epoch: 1777794300, close: 999.5351 },
  { epoch: 1777794600, close: 998.3156 },
];

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = []; let cursor = end;
  while (candles.length < count) { const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch); cursor = ch[0].epoch - 1; if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

async function main() {
  const c = new C(); await c.ready;
  // Fetch enough bars to cover the production range PLUS 50 bars before for lookback
  const earliestProd = 1777792200; // 07:10 UTC May 3
  const latestProd = 1777794600; // 07:50 UTC May 3
  const fetchEnd = latestProd + 600;
  const fetchCount = 100; // ~8 hrs of 5m bars

  console.log(`Fetching RDBEAR + RDBULL via ticks_history ending ${new Date(fetchEnd * 1000).toISOString()}\n`);
  const [bear, bull] = await Promise.all([
    fetchPaged(c, "RDBEAR", GR, fetchCount, fetchEnd),
    fetchPaged(c, "RDBULL", GR, fetchCount, fetchEnd),
  ]);
  c.close();

  // Find the bars at PROD_BARS epochs and compare closes
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`PRODUCTION vs HISTORICAL — bar-by-bar close comparison`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  epoch       UTC time         RDBEAR  prod    hist    diff      RDBULL  prod    hist    diff`);

  let allMatch = true;
  for (let i = 0; i < PROD_BARS_RDBEAR.length; i++) {
    const pb = PROD_BARS_RDBEAR[i];
    const pl = PROD_BARS_RDBULL[i];
    const hb = bear.find((c) => c.epoch === pb.epoch);
    const hl = bull.find((c) => c.epoch === pl.epoch);
    const tsStr = new Date(pb.epoch * 1000).toISOString().slice(11, 19);
    const bDiff = hb ? Math.abs(pb.close - hb.close) : -1;
    const lDiff = hl ? Math.abs(pl.close - hl.close) : -1;
    const bMatch = hb && bDiff < 0.001;
    const lMatch = hl && lDiff < 0.001;
    if (!bMatch || !lMatch) allMatch = false;
    console.log(`  ${pb.epoch}  ${tsStr}        ${pb.close.toFixed(4)}  ${hb?.close.toFixed(4) ?? "MISSING"}  ${bDiff < 0 ? "  N/A " : bDiff.toFixed(4)}  ${bMatch ? "✓" : "✗"}    ${pl.close.toFixed(4)}  ${hl?.close.toFixed(4) ?? "MISSING"}  ${lDiff < 0 ? "  N/A " : lDiff.toFixed(4)}  ${lMatch ? "✓" : "✗"}`);
  }
  console.log(`\nAll bars match: ${allMatch ? "YES — production sees same data as historical" : "NO — there is a data feed discrepancy"}`);

  // Run detector on RDBEAR and RDBULL — would any signals have fired?
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`DETECTOR EVAL on the 9 production bars (lookback=15 prior bars from historical fetch)`);
  console.log(`${"".padEnd(110, "═")}`);

  for (const [name, candles, prodBars, fadeSide, driftSide] of [
    ["RDBEAR", bear, PROD_BARS_RDBEAR, "SELL", "SELL"],
    ["RDBULL", bull, PROD_BARS_RDBULL, "BUY",  "BUY"],
  ] as const) {
    console.log(`\n--- ${name} ---`);
    console.log(`  bar epoch    UTC      close      15-bar hi   15-bar lo   bar-range   closePosUp   closePosDn   ATR14    fired?`);
    for (const pb of prodBars) {
      const idx = candles.findIndex((c) => c.epoch === pb.epoch);
      if (idx < 0) { console.log(`  ${pb.epoch}  MISSING in historical fetch`); continue; }
      if (idx < LOOKBACK + 14) { console.log(`  ${pb.epoch}  insufficient lookback (only ${idx} prior bars)`); continue; }
      const a = atr(candles, idx, 14);
      let hi = -Infinity, lo = Infinity;
      for (let m = idx - LOOKBACK; m < idx; m++) {
        if (candles[m].high > hi) hi = candles[m].high;
        if (candles[m].low < lo) lo = candles[m].low;
      }
      const cur = candles[idx];
      const r = cur.high - cur.low;
      const cpu = r > 0 ? (cur.close - cur.low) / r : 0;
      const cpd = r > 0 ? (cur.high - cur.close) / r : 0;
      const upPierce = cur.close > hi && cpu >= MOM_RATIO;
      const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
      let signal = "—";
      if (upPierce && fadeSide === "SELL") signal = `${name}_FADE SELL ★`;
      else if (dnPierce && fadeSide === "BUY") signal = `${name}_FADE BUY ★`;
      if (upPierce && driftSide === "BUY") signal = (signal === "—" ? "" : signal + " + ") + `${name}_DRIFT BUY ★`;
      else if (dnPierce && driftSide === "SELL") signal = (signal === "—" ? "" : signal + " + ") + `${name}_DRIFT SELL ★`;
      const tsStr = new Date(pb.epoch * 1000).toISOString().slice(11, 19);
      console.log(`  ${pb.epoch}  ${tsStr}  ${cur.close.toFixed(4)}    ${hi.toFixed(4)}    ${lo.toFixed(4)}    ${r.toFixed(4)}    ${cpu.toFixed(2)}         ${cpd.toFixed(2)}         ${a.toFixed(2)}    ${signal}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

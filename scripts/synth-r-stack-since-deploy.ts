// Simulate the EXACT post-deploy window — from bot's actual start time
// (20:55 UTC May 2 per uptime in trader-bot-logs-2026-05-02T23-57-37-624Z) to now.
// Use real Deriv historical 5m candles. Should match production's 0-signal reality.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const ACCT_INIT = 20, STAKE = 3, MULT = 100;
const COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const LOOKBACK = 15, MOM_RATIO = 0.7, GR = 300;
const FADE_KATR = 4.0, DRIFT_KATR = 2.5;

// Bot deployed at 20:55 UTC May 2 2026 per log uptime trace
const DEPLOY_TS = Math.floor(Date.UTC(2026, 4, 2, 20, 55, 0) / 1000);
const NOW = Math.floor(Date.now() / 1000);

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

type Sig = { idx: number; epoch: number; sym: string; strat: string; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detectAll(candles: Candle[], sym: string, fadeSide: "BUY" | "SELL", driftSide: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14); if (a <= 0) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) { if (candles[m].high > hi) hi = candles[m].high; if (candles[m].low < lo) lo = candles[m].low; }
    const cur = candles[i]; const r = cur.high - cur.low; if (r <= 0) continue;
    const cpu = (cur.close - cur.low) / r, cpd = (cur.high - cur.close) / r;
    const upPierce = cur.close > hi && cpu >= MOM_RATIO;
    const dnPierce = cur.close < lo && cpd >= MOM_RATIO;
    if (upPierce && fadeSide === "SELL") { const dist = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist }); }
    if (dnPierce && fadeSide === "BUY")  { const dist = FADE_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "BUY",  entry: cur.close, stop: cur.close - dist, target: cur.close + dist }); }
    if (upPierce && driftSide === "BUY") { const dist = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "BUY",  entry: cur.close, stop: cur.close - dist, target: cur.close + dist }); }
    if (dnPierce && driftSide === "SELL"){ const dist = DRIFT_KATR * a; out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist }); }
  }
  return out;
}

async function main() {
  const fromTs = new Date(DEPLOY_TS * 1000).toISOString().slice(0, 16).replace("T", " ");
  const toTs = new Date(NOW * 1000).toISOString().slice(0, 16).replace("T", " ");
  const hours = (NOW - DEPLOY_TS) / 3600;
  console.log(`R-stack post-deploy simulation`);
  console.log(`Deploy:  ${fromTs} UTC`);
  console.log(`Now:     ${toTs} UTC`);
  console.log(`Window:  ${hours.toFixed(1)}h\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil(hours * 12) + 250;
  const [bear, bull] = await Promise.all([
    fetchPaged(c, "RDBEAR", GR, need, NOW),
    fetchPaged(c, "RDBULL", GR, need, NOW),
  ]);
  c.close();

  const sigs = [
    ...detectAll(bear, "RDBEAR", "SELL", "SELL"),
    ...detectAll(bull, "RDBULL", "BUY",  "BUY"),
  ].filter((s) => s.epoch >= DEPLOY_TS).sort((a, b) => a.epoch - b.epoch);

  console.log(`Total RDBEAR bars in window: ${bear.filter((b) => b.epoch >= DEPLOY_TS).length}`);
  console.log(`Total RDBULL bars in window: ${bull.filter((b) => b.epoch >= DEPLOY_TS).length}`);
  console.log(`Pierce-signals detected:     ${sigs.length}\n`);

  if (sigs.length === 0) {
    console.log(`✓ MATCHES PRODUCTION: zero signals fired post-deploy.`);
    console.log(`  The market hasn't pierced a 15-bar high/low with momentum on either asset.`);
    console.log(`  This is normal — averaged over 9 months, signals fire ~10-25/day per asset,`);
    console.log(`  but individual ${hours.toFixed(0)}h windows can have 0 signals if the market stays inside its range.`);
    return;
  }

  console.log(`SIGNALS FIRED (would have traded if production were correct):`);
  for (const s of sigs) {
    const ts = new Date(s.epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`  ${ts}  ${s.strat.padEnd(13)}  ${s.side}`);
  }
  console.log(`\n⚠ Production fired 0 signals in this window despite ${sigs.length} detectable. Either:`);
  console.log(`  • Detector params in deployed code differ from script (unlikely — IDs match)`);
  console.log(`  • Engine merge isn't enabling both breakoutMeanRev + breakoutContinuation`);
  console.log(`  • Bar data in production differs (unlikely — same WebSocket feed)`);
}
main().catch((e) => { console.error(e); process.exit(1); });

// Verify the bar-close-eval fix is producing signals in production.
// Uses the user's API token to pull profit_table since the fix commit time.
// Also fetches recent RDBEAR/RDBULL 5m candles and runs the FIXED detector
// logic on them to show what signals SHOULD have fired.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const FIX_COMMIT_TS = Math.floor(Date.UTC(2026, 4, 3, 4, 33, 39) / 1000); // 3fcdd33 commit time UTC

const LOOKBACK = 15, MOM_RATIO = 0.7, FADE_KATR = 4.0, DRIFT_KATR = 2.5;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchLatest(c: C, sym: string, gr: number, count: number): Promise<Candle[]> {
  // Use end: "latest" to bypass system-clock drift on this dev machine.
  // Deriv returns the most recent `count` candles regardless of local clock.
  const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count, end: "latest", style: "candles", granularity: gr });
  const raw = (r.candles ?? []) as any[];
  return raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle))
    .sort((a, b) => a.epoch - b.epoch);
}

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0; let s = 0;
  for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; }
  return s / period;
}

type Sig = { idx: number; epoch: number; sym: string; strat: string; side: "BUY" | "SELL" };

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
    if (upPierce && fadeSide === "SELL") out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "SELL" });
    if (dnPierce && fadeSide === "BUY")  out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_FADE`, side: "BUY" });
    if (upPierce && driftSide === "BUY") out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "BUY" });
    if (dnPierce && driftSide === "SELL") out.push({ idx: i, epoch: cur.epoch, sym, strat: `${sym}_DRIFT`, side: "SELL" });
  }
  return out;
}

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  console.log(`Auth: ${auth.authorize?.loginid} (balance=${auth.authorize?.balance} ${auth.authorize?.currency})`);
  console.log(`Fix committed: ${new Date(FIX_COMMIT_TS * 1000).toISOString()}\n`);

  // 1. Pull profit_table for trades since fix
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`PRODUCTION TRADES SINCE FIX (last 200 contracts)`);
  console.log(`${"".padEnd(80, "═")}`);
  const pt = await c.send({ profit_table: 1, limit: 200, description: 1 });
  const rows = (pt.profit_table?.transactions ?? []) as any[];
  const sinceFix = rows.filter((r) => (r.purchase_time ?? 0) >= FIX_COMMIT_TS);
  console.log(`Total contracts pulled: ${rows.length}`);
  console.log(`Contracts since fix:     ${sinceFix.length}`);
  if (sinceFix.length > 0) {
    console.log(`\n  buy_time             sym         side  stake    sell_price  pnl`);
    for (const r of sinceFix.slice(0, 30)) {
      const sym = (r.shortcode || "").includes("RDBULL") ? "RDBULL" : (r.shortcode || "").includes("RDBEAR") ? "RDBEAR" : (r.shortcode || "").includes("BOOM") ? "BOOM" : (r.shortcode || "").includes("CRASH") ? "CRASH" : "?";
      const side = (r.shortcode || "").includes("MULTUP") ? "BUY" : (r.shortcode || "").includes("MULTDOWN") ? "SELL" : "?";
      const pnl = (r.sell_price ?? 0) - (r.buy_price ?? 0);
      console.log(`  ${new Date((r.purchase_time ?? 0) * 1000).toISOString().slice(0, 19)}  ${sym.padEnd(10)}  ${side.padEnd(4)}  $${(r.buy_price ?? 0).toFixed(2)}    $${(r.sell_price ?? 0).toFixed(2)}      ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
    }
    const total = sinceFix.reduce((s, r) => s + ((r.sell_price ?? 0) - (r.buy_price ?? 0)), 0);
    console.log(`  ──────────`);
    console.log(`  Total: ${sinceFix.length} trades, net ${total >= 0 ? "+" : ""}$${total.toFixed(2)}`);
  } else {
    console.log(`  No trades yet since fix commit. Bot may not have redeployed yet, OR no pierces have fired.`);
  }

  // 2. Pull recent candles and check what signals SHOULD have fired since fix
  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`SIMULATED SIGNALS POST-FIX (recent ~6h of RDBEAR/RDBULL 5m candles)`);
  console.log(`${"".padEnd(80, "═")}`);
  const need = 200; // ~16h of 5m bars — covers the post-fix window comfortably
  const [bear, bull] = await Promise.all([
    fetchLatest(c, "RDBEAR", 300, need),
    fetchLatest(c, "RDBULL", 300, need),
  ]);
  c.close();

  const latestBearEpoch = bear[bear.length - 1]?.epoch ?? 0;
  const latestBullEpoch = bull[bull.length - 1]?.epoch ?? 0;
  const realNow = Math.max(latestBearEpoch, latestBullEpoch);
  const rangeStart = FIX_COMMIT_TS;
  console.log(`  RDBEAR bars: ${bear.length}, latest=${new Date(latestBearEpoch * 1000).toISOString()}`);
  console.log(`  RDBULL bars: ${bull.length}, latest=${new Date(latestBullEpoch * 1000).toISOString()}`);
  console.log(`  Real "now" per Deriv API: ${new Date(realNow * 1000).toISOString()} (${new Date((realNow + 3*3600) * 1000).toISOString().slice(11,19)} EAT)`);
  console.log(`  Detector eval window: ${new Date(rangeStart * 1000).toISOString()} → ${new Date(realNow * 1000).toISOString()}`);
  console.log(`  Window length: ${((realNow - rangeStart) / 3600).toFixed(1)}h\n`);

  const sigs = [
    ...detectAll(bear, "RDBEAR", "SELL", "SELL"),
    ...detectAll(bull, "RDBULL", "BUY", "BUY"),
  ].filter((s) => s.epoch >= rangeStart).sort((a, b) => a.epoch - b.epoch);

  if (sigs.length === 0) {
    console.log(`  Zero pierces detected in this window — market hasn't broken 15-bar high/low recently.`);
  } else {
    console.log(`  ${sigs.length} pierces detected:`);
    for (const s of sigs) {
      console.log(`    ${new Date(s.epoch * 1000).toISOString().slice(0, 19)}  ${s.strat.padEnd(13)}  ${s.side}`);
    }
  }

  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`VERIFICATION RESULT`);
  console.log(`${"".padEnd(80, "═")}`);
  if (sinceFix.length > 0) {
    console.log(`  ✓ Bot fired ${sinceFix.length} trades since fix commit. Live engine is detecting signals.`);
  } else if (sigs.length > 0) {
    console.log(`  ⚠ Sim shows ${sigs.length} pierces should have fired but production has 0 trades since fix.`);
    console.log(`    → Either bot hasn't redeployed yet, OR there's a different bug.`);
  } else {
    console.log(`  - Sim and production both show 0 pierces in the post-fix window.`);
    console.log(`    → Market is quiet. Wait for a pierce to confirm — should fire within ~30-60min on average.`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Live one-shot HF strategy validator.
//
// Polls 15m klines on the 15-asset basket. On the FIRST HF signal that
// fires (BB_UP_SHORT or BB_LOW_LONG), opens a real
// $1 market order on Binance Futures. Tracks mark price for trail
// triggering. On trail or 4h timeout, closes MARKET reduce-only.
//
// At the end: reports actual fees, slippage, funding, hold time, and
// the prediction-vs-reality gap so we can calibrate the sim's cost model.
//
// Usage: BINANCE_KEY=... BINANCE_SECRET=... npx ts-node scripts/hf-live-validate.ts
//
// Or load creds from disk (state dir):
//   STATE_DIR=/path npx ts-node scripts/hf-live-validate.ts

import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const HOST = "https://fapi.binance.com";
const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LDOUSDT", "ADAUSDT", "LINKUSDT", "UNIUSDT", "AAVEUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT"];
const STAKE = 1, LEVERAGE = 30, TF_SEC = 900;
const TRAIL_ARM_ATR = 1.0, TRAIL_RETRACE_ATR = 0.3;
const HORIZON_SEC = 48 * TF_SEC;  // 12h max hold
const ATR_PERIOD = 14, BB_PERIOD = 20, BB_K = 2.0, SMA_PERIOD = 50;

// ─── Creds loader ────────────────────────────────────────────────────────
function loadCreds(): { apiKey: string; apiSecret: string } {
  if (process.env.BINANCE_KEY && process.env.BINANCE_SECRET) {
    return { apiKey: process.env.BINANCE_KEY, apiSecret: process.env.BINANCE_SECRET };
  }
  // Try disk
  const stateDir = process.env.STATE_DIR ?? "./state";
  const credsFile = path.join(stateDir, "binance-creds.json");
  if (!existsSync(credsFile)) throw new Error(`No creds in env or ${credsFile}`);
  // The on-disk format is encrypted. Easiest: require env vars.
  throw new Error("On-disk creds are encrypted. Please set BINANCE_KEY + BINANCE_SECRET env vars.");
}
const CREDS = loadCreds();

// ─── HTTP helpers ────────────────────────────────────────────────────────
async function publicGet(path: string, params: Record<string, string | number> = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const r = await fetch(`${HOST}${path}${qs ? "?" + qs : ""}`);
  if (!r.ok) throw new Error(`${path} HTTP ${r.status}: ${await r.text()}`);
  return r.json() as any;
}
async function signed(method: "GET" | "POST" | "DELETE" | "PUT", path: string, params: Record<string, string | number | boolean> = {}) {
  const timestamp = Date.now();
  const merged: Record<string, string | number | boolean> = { ...params, timestamp, recvWindow: 5000 };
  const query = Object.entries(merged).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const sig = createHmac("sha256", CREDS.apiSecret).update(query).digest("hex");
  const url = `${HOST}${path}?${query}&signature=${sig}`;
  const r = await fetch(url, { method, headers: { "X-MBX-APIKEY": CREDS.apiKey } });
  if (!r.ok) throw new Error(`${method} ${path} HTTP ${r.status}: ${await r.text()}`);
  return r.json() as any;
}
function roundStep(v: number, step: number): number { return step > 0 ? Math.floor(v / step) * step : v; }
function fmt(v: number, prec: number): string { return v.toFixed(Math.max(0, prec)); }
function pause(ms: number) { return new Promise<void>((res) => setTimeout(res, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }
function log(msg: string) { console.log(`[${ts()}] ${msg}`); }

// ─── Indicator helpers ───────────────────────────────────────────────────
type Bar = { epoch: number; o: number; h: number; l: number; c: number };
function computeATR(bars: Bar[], i: number): number {
  if (i < ATR_PERIOD) return NaN;
  let s = 0;
  for (let j = i - ATR_PERIOD + 1; j <= i; j++) s += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
  return s / ATR_PERIOD;
}
function computeBB(bars: Bar[], i: number) {
  if (i < BB_PERIOD - 1) return null;
  let sum = 0, sq = 0;
  for (let j = i - BB_PERIOD + 1; j <= i; j++) { sum += bars[j].c; sq += bars[j].c ** 2; }
  const mid = sum / BB_PERIOD;
  const sd = Math.sqrt(Math.max(0, sq / BB_PERIOD - mid * mid));
  return { mid, upper: mid + BB_K * sd, lower: mid - BB_K * sd };
}
function smaSign(bars: Bar[], i: number): "UP" | "DOWN" | "FLAT" {
  if (i < SMA_PERIOD + 5) return "FLAT";
  let now = 0, prev = 0;
  for (let j = i - SMA_PERIOD + 1; j <= i; j++) now += bars[j].c;
  for (let j = i - SMA_PERIOD - 4; j <= i - 5; j++) prev += bars[j].c;
  const a = now / SMA_PERIOD, b = prev / SMA_PERIOD;
  if (a > b * 1.0005) return "UP";
  if (a < b * 0.9995) return "DOWN";
  return "FLAT";
}

// ─── Pattern detectors (same as backtest) ────────────────────────────────
type Signal = { pattern: string; side: 1 | -1; entryRef: number; atr: number };
function detect(bars: Bar[], i: number): Signal | null {
  const atr = computeATR(bars, i);
  if (!isFinite(atr) || atr <= 0) return null;
  const bb = computeBB(bars, i);
  const b = bars[i];
  // BB_UP_SHORT
  if (bb && b.h >= bb.upper && b.c < bb.upper) return { pattern: "BB_UP_SHORT", side: -1, entryRef: b.c, atr };
  // BB_LOW_LONG
  if (bb && b.l <= bb.lower && b.c > bb.lower) return { pattern: "BB_LOW_LONG", side: 1, entryRef: b.c, atr };
  // SWEEP_HIGH_SHORT dropped 2026-05-22 — regime-dependent, −$866 on Feb OOS.
  return null;
}

// ─── Main loop ───────────────────────────────────────────────────────────
let openQty = 0, openSym = "", openSide: "LONG" | "SHORT" = "LONG";
process.on("SIGINT", async () => {
  if (openQty > 0) {
    log(`SIGINT received — closing orphan position ${openSym} ${openSide} qty=${openQty}`);
    try {
      const closeSide = openSide === "LONG" ? "SELL" : "BUY";
      await signed("POST", "/fapi/v1/order", { symbol: openSym, side: closeSide, type: "MARKET", positionSide: openSide, quantity: String(openQty) });
    } catch (e: any) { log(`Cleanup failed: ${e.message}`); }
  }
  process.exit(1);
});

async function main() {
  log(`══ HF LIVE VALIDATE: $${STAKE} stake × ${LEVERAGE}x ══`);
  log(`Watching ${ASSETS.length} assets for BB_UP_SHORT, BB_LOW_LONG signals`);

  // Hedge mode + per-asset setup
  try { await signed("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" }); }
  catch (e: any) { if (!/4059/.test(e.message)) throw e; }
  log("✓ Hedge mode confirmed");

  // exchangeInfo for precision
  const info = await publicGet("/fapi/v1/exchangeInfo");
  const filters: Record<string, { stepSize: number; tickSize: number; qP: number; pP: number; minNotional: number }> = {};
  for (const s of info.symbols) {
    const lot = s.filters.find((f: any) => f.filterType === "LOT_SIZE");
    const price = s.filters.find((f: any) => f.filterType === "PRICE_FILTER");
    const minN = s.filters.find((f: any) => f.filterType === "MIN_NOTIONAL");
    if (!ASSETS.includes(s.symbol)) continue;
    filters[s.symbol] = {
      stepSize: +lot.stepSize, tickSize: +price.tickSize,
      minNotional: minN ? +minN.notional : 5,
      qP: s.quantityPrecision, pP: s.pricePrecision,
    };
  }

  // Set leverage + CROSSED margin on all assets (Multi-Assets mode)
  for (const sym of ASSETS) {
    try { await signed("POST", "/fapi/v1/marginType", { symbol: sym, marginType: "CROSSED" }); }
    catch (e: any) { if (!/4046/.test(e.message)) throw e; }
    await signed("POST", "/fapi/v1/leverage", { symbol: sym, leverage: LEVERAGE });
  }
  log(`✓ Leverage ${LEVERAGE}x set on all ${ASSETS.length} assets`);

  // Seed bars per asset
  const bars: Record<string, Bar[]> = {};
  for (const sym of ASSETS) {
    const k = await publicGet("/fapi/v1/klines", { symbol: sym, interval: "15m", limit: 200 });
    bars[sym] = k.map((x: any[]) => ({ epoch: Math.floor(+x[0] / 1000), o: +x[1], h: +x[2], l: +x[3], c: +x[4] }));
  }
  log(`✓ Seeded 200 15m bars per asset`);

  // Poll loop — every 30s check for new bars + signal
  log(`Waiting for first signal... (polling every 30s)`);
  const detectStart = Date.now();
  while (true) {
    for (const sym of ASSETS) {
      try {
        const latest = await publicGet("/fapi/v1/klines", { symbol: sym, interval: "15m", limit: 2 });
        if (!latest || latest.length < 2) continue;
        const closed = { epoch: Math.floor(+latest[0][0] / 1000), o: +latest[0][1], h: +latest[0][2], l: +latest[0][3], c: +latest[0][4] };
        const buf = bars[sym];
        const tail = buf[buf.length - 1];
        if (closed.epoch > tail.epoch) {
          buf.push(closed);
          if (buf.length > 200) buf.shift();
          const sig = detect(buf, buf.length - 1);
          if (sig) {
            const sign = smaSign(buf, buf.length - 1);
            const tradedSide: 1 | -1 = sig.side;
            // (sma sign still computed in case we re-introduce a direction-trained pattern)
            void sign;
            log(`★ SIGNAL: ${sym} ${sig.pattern} side=${tradedSide === 1 ? "LONG" : "SHORT"} entryRef=$${sig.entryRef} atr=${sig.atr.toFixed(4)}`);
            await executeTrade(sym, sig, tradedSide, filters[sym], detectStart);
            return;
          }
        }
      } catch (e: any) { log(`poll ${sym} err: ${e.message}`); }
    }
    await pause(30000);
  }
}

async function executeTrade(sym: string, sig: Signal, side: 1 | -1, f: { stepSize: number; tickSize: number; qP: number; pP: number; minNotional: number }, detectStart: number) {
  const notional = STAKE * LEVERAGE;
  const ticker = await publicGet("/fapi/v1/ticker/price", { symbol: sym });
  const markAtSignal = +ticker.price;
  const qtyRaw = notional / markAtSignal;
  const qty = roundStep(qtyRaw, f.stepSize);
  if (qty * markAtSignal < f.minNotional) { log(`✗ qty too small (${(qty*markAtSignal).toFixed(2)} < ${f.minNotional})`); return; }
  log(`→ Placing MARKET ${side === 1 ? "BUY" : "SELL"} qty=${qty} on ${sym} (mark=$${markAtSignal})`);

  const orderSide = side === 1 ? "BUY" : "SELL";
  const positionSide = side === 1 ? "LONG" : "SHORT";
  openQty = qty; openSym = sym; openSide = positionSide;

  const orderSentAt = Date.now();
  const entry = await signed("POST", "/fapi/v1/order", {
    symbol: sym, side: orderSide, type: "MARKET", positionSide,
    quantity: fmt(qty, f.qP), newClientOrderId: `hflive-${Date.now()}`,
  });
  const orderAckAt = Date.now();
  log(`✓ Order placed (orderId=${entry.orderId}) ack ${orderAckAt - orderSentAt}ms`);

  await pause(2000);
  const positions = await signed("GET", "/fapi/v2/positionRisk", { symbol: sym });
  const pos = positions.find((p: any) => p.positionSide === positionSide);
  const entryPrice = +pos.entryPrice;
  const entrySlippageBps = Math.abs((entryPrice - markAtSignal) / markAtSignal) * 10000 * (side === 1 ? (entryPrice > markAtSignal ? 1 : -1) : (entryPrice < markAtSignal ? 1 : -1));
  log(`  Entry fill: $${entryPrice} (vs mark $${markAtSignal}, slip ${entrySlippageBps.toFixed(2)}bps)`);

  // Trail tracking
  const armDist = TRAIL_ARM_ATR * sig.atr;
  const retraceDist = TRAIL_RETRACE_ATR * sig.atr;
  let peak = entryPrice;
  let armed = false;
  const entryTime = Date.now();
  log(`Trail params: arm@${(side === 1 ? entryPrice + armDist : entryPrice - armDist).toFixed(5)} retrace=${retraceDist.toFixed(5)}`);

  while (true) {
    await pause(5000);
    if (Date.now() - entryTime > HORIZON_SEC * 1000) { log(`⏰ HORIZON reached, closing`); break; }
    try {
      const t = await publicGet("/fapi/v1/premiumIndex", { symbol: sym });
      const mark = +t.markPrice;
      let trailTriggered = false;
      if (side === 1) {
        if (mark > peak) peak = mark;
        if (!armed && peak >= entryPrice + armDist) { armed = true; log(`  ✓ Armed at peak=$${peak.toFixed(5)} (+${((peak-entryPrice)/entryPrice*100).toFixed(2)}%)`); }
        if (armed && mark <= peak - retraceDist) trailTriggered = true;
      } else {
        if (mark < peak) peak = mark;
        if (!armed && peak <= entryPrice - armDist) { armed = true; log(`  ✓ Armed at peak=$${peak.toFixed(5)} (${((peak-entryPrice)/entryPrice*100).toFixed(2)}%)`); }
        if (armed && mark >= peak + retraceDist) trailTriggered = true;
      }
      if (!armed) {
        const dist = side === 1 ? ((mark - entryPrice) / entryPrice * 100) : ((entryPrice - mark) / entryPrice * 100);
        process.stdout.write(`\r  Mark=$${mark.toFixed(5)} Δ${dist >= 0 ? "+" : ""}${dist.toFixed(3)}%  (need ${(TRAIL_ARM_ATR * sig.atr / entryPrice * 100).toFixed(2)}% to arm)    `);
      } else {
        const dist = side === 1 ? ((peak - mark) / entryPrice * 100) : ((mark - peak) / entryPrice * 100);
        process.stdout.write(`\r  Mark=$${mark.toFixed(5)}  Retrace ${dist.toFixed(3)}% (trail at ${(TRAIL_RETRACE_ATR * sig.atr / entryPrice * 100).toFixed(2)}%)    `);
      }
      if (trailTriggered) { console.log(""); log(`★ TRAIL TRIGGERED at mark=$${mark.toFixed(5)} (peak=$${peak.toFixed(5)})`); break; }
    } catch (e: any) { log(`mark poll err: ${e.message}`); }
  }
  console.log("");

  // MARKET close
  const closeOrderSent = Date.now();
  const closeOrder = await signed("POST", "/fapi/v1/order", {
    symbol: sym, side: side === 1 ? "SELL" : "BUY", type: "MARKET", positionSide,
    quantity: fmt(qty, f.qP), newClientOrderId: `hflive-close-${Date.now()}`,
  });
  const closeOrderAck = Date.now();
  openQty = 0;
  log(`✓ Close order placed (orderId=${closeOrder.orderId}) ack ${closeOrderAck - closeOrderSent}ms`);

  await pause(2000);
  // ─── Report ─────────────────────────────────────────────────────
  const trades = await signed("GET", "/fapi/v1/userTrades", { symbol: sym, limit: 5 });
  const recent = trades.slice(-2);
  let entryActual = 0, exitActual = 0, fees = 0, realized = 0;
  for (const t of recent) {
    if (+t.orderId === entry.orderId) entryActual = +t.price;
    if (+t.orderId === closeOrder.orderId) { exitActual = +t.price; realized = +t.realizedPnl; }
    fees += +t.commission;
  }
  // Funding income
  const incomeStart = Math.floor(entryTime / 1000) * 1000;
  let funding = 0;
  try {
    const income = await signed("GET", "/fapi/v1/income", { symbol: sym, incomeType: "FUNDING_FEE", startTime: incomeStart, limit: 10 });
    for (const i of income) funding += +i.income;
  } catch {}

  const holdSec = (Date.now() - entryTime) / 1000;
  const grossPct = side === 1 ? (exitActual - entryActual) / entryActual : (entryActual - exitActual) / entryActual;
  const grossDollars = grossPct * notional;

  console.log("\n══ ACTUAL EXECUTION REPORT ══");
  console.log(`Symbol            ${sym}`);
  console.log(`Pattern           ${sig.pattern}`);
  console.log(`Side              ${side === 1 ? "LONG" : "SHORT"}`);
  console.log(`Stake             $${STAKE}`);
  console.log(`Leverage          ${LEVERAGE}x`);
  console.log(`Notional          $${notional.toFixed(2)}`);
  console.log(`Quantity          ${qty}`);
  console.log(`Hold time         ${holdSec.toFixed(0)}s (${(holdSec/60).toFixed(1)}min)`);
  console.log(``);
  console.log(`Mark at signal    $${markAtSignal}`);
  console.log(`Entry fill        $${entryActual}`);
  console.log(`Exit fill         $${exitActual}`);
  console.log(`Peak reached      $${peak}`);
  console.log(``);
  console.log(`Gross PnL %       ${(grossPct * 100).toFixed(3)}%`);
  console.log(`Gross PnL $       $${grossDollars.toFixed(4)}`);
  console.log(`Realized PnL $    $${realized.toFixed(4)} (Binance figure, after on-chain math)`);
  console.log(`Fees paid         $${fees.toFixed(4)} (${(fees/notional*10000).toFixed(2)}bps of notional)`);
  console.log(`Funding           $${funding.toFixed(4)}`);
  console.log(`NET PnL           $${(realized - fees + funding).toFixed(4)}`);
  console.log(``);
  console.log("─── Sim cost-model comparison ───");
  console.log(`Sim assumed fee per RT       $0.45 → actual $${fees.toFixed(4)} (${fees > 0.45 ? "HIGHER" : "lower"})`);
  console.log(`Sim assumed slippage RT      $0.27 → entry slip ${entrySlippageBps.toFixed(2)}bps × 2 ≈ $${(entrySlippageBps * 2 / 10000 * notional).toFixed(4)}`);
  console.log(`Sim assumed funding per trd  $0.02 → actual $${funding.toFixed(4)}`);
  console.log(`Sim assumed trail timing     $0.14 → measured via exit vs trail-level (not auto-tracked here)`);
  console.log(`\nUse these numbers to calibrate hf-hourly-daily.ts.`);
}

main().catch(async (e) => {
  console.error("FATAL:", e?.message ?? e);
  if (openQty > 0) {
    try { await signed("POST", "/fapi/v1/order", { symbol: openSym, side: openSide === "LONG" ? "SELL" : "BUY", type: "MARKET", positionSide: openSide, quantity: String(openQty) }); } catch {}
  }
  process.exit(1);
});

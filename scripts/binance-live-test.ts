// LIVE $1 test on Binance Futures.
// Exercises the FINAL exit strategy (MARKET-close-on-trigger, no STOP_MARKET):
//   1. Set hedge mode + CROSSED margin + leverage 30x
//   2. MARKET BUY (open LONG) on DOGEUSDT
//   3. Poll mark price every 1s — track peak
//   4. Simulate trail-arm (we'll fake it by closing after 10s regardless)
//   5. MARKET SELL reduce-only to close
//   6. Report fills, fees, realized PnL
//
// Multi-Assets mode accounts can't use STOP_MARKET via /fapi/v1/order,
// so the bot's exit logic moves to in-process MARKET close.

import { createHmac } from "node:crypto";

const HOST = "https://fapi.binance.com";
const SYMBOL = "DOGEUSDT";
const LEVERAGE = 30;
const STAKE_USD = 1;

const apiKey = process.env.BINANCE_KEY!;
const apiSecret = process.env.BINANCE_SECRET!;
if (!apiKey || !apiSecret) { console.error("Set BINANCE_KEY and BINANCE_SECRET"); process.exit(1); }

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
  const sig = createHmac("sha256", apiSecret).update(query).digest("hex");
  const url = `${HOST}${path}?${query}&signature=${sig}`;
  const r = await fetch(url, { method, headers: { "X-MBX-APIKEY": apiKey } });
  if (!r.ok) throw new Error(`${method} ${path} HTTP ${r.status}: ${await r.text()}`);
  return r.json() as any;
}
function roundStep(v: number, step: number): number { return step > 0 ? Math.floor(v / step) * step : v; }
function fmt(v: number, prec: number): string { return v.toFixed(Math.max(0, prec)); }
function pause(ms: number) { return new Promise<void>((res) => setTimeout(res, ms)); }

let openQty = 0;
async function cleanup() {
  if (openQty > 0) {
    try {
      console.log("\n[CLEANUP] Closing orphan position...");
      await signed("POST", "/fapi/v1/order", {
        symbol: SYMBOL, side: "SELL", type: "MARKET", positionSide: "LONG", quantity: String(openQty),
      });
      console.log("    ✓ Cleanup close sent");
    } catch (e: any) { console.log("    Cleanup failed:", e.message); }
  }
}
process.on("SIGINT", async () => { await cleanup(); process.exit(1); });

async function main() {
  console.log(`\n══ LIVE TEST (MARKET-close exit): ${SYMBOL} $${STAKE_USD} × ${LEVERAGE}x ══\n`);

  console.log("[1] Loading filters + price...");
  const info = await publicGet("/fapi/v1/exchangeInfo");
  const sd = info.symbols.find((s: any) => s.symbol === SYMBOL);
  const lot = sd.filters.find((f: any) => f.filterType === "LOT_SIZE");
  const price = sd.filters.find((f: any) => f.filterType === "PRICE_FILTER");
  const filters = { stepSize: +lot.stepSize, tickSize: +price.tickSize, qP: sd.quantityPrecision, pP: sd.pricePrecision };
  const t0 = await publicGet("/fapi/v1/ticker/price", { symbol: SYMBOL });
  const markStart = +t0.price;
  console.log(`    Price: $${markStart} | step=${filters.stepSize} qP=${filters.qP}`);

  console.log("\n[2] Hedge mode + CROSSED margin + leverage...");
  try { await signed("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" }); console.log("    ✓ Hedge mode set"); }
  catch (e: any) { if (/4059/.test(e.message)) console.log("    ✓ Already hedge"); else throw e; }
  try { await signed("POST", "/fapi/v1/marginType", { symbol: SYMBOL, marginType: "CROSSED" }); }
  catch (e: any) { if (!/4046/.test(e.message)) throw e; }
  await signed("POST", "/fapi/v1/leverage", { symbol: SYMBOL, leverage: LEVERAGE });
  console.log(`    ✓ Leverage ${LEVERAGE}x`);

  const notional = STAKE_USD * LEVERAGE;
  const qty = roundStep(notional / markStart, filters.stepSize);
  console.log(`\n[3] Order qty: ${qty} (notional $${(qty*markStart).toFixed(2)})`);

  console.log("\n[4] MARKET BUY (open LONG)...");
  const entry = await signed("POST", "/fapi/v1/order", {
    symbol: SYMBOL, side: "BUY", type: "MARKET", positionSide: "LONG",
    quantity: fmt(qty, filters.qP), newClientOrderId: `test-entry-${Date.now()}`,
  });
  openQty = qty;
  await pause(1500);
  const positions = await signed("GET", "/fapi/v2/positionRisk", { symbol: SYMBOL });
  const longPos = positions.find((p: any) => p.positionSide === "LONG");
  const entryPrice = +longPos.entryPrice;
  console.log(`    ✓ Entered @ $${entryPrice} | orderId=${entry.orderId}`);

  // 5. Poll mark price for 10s — simulate the bot's tracking loop
  console.log("\n[5] Polling mark price for 10s (simulating bot's trail-tracking loop)...");
  let peak = entryPrice;
  for (let i = 0; i < 10; i++) {
    const t = await publicGet("/fapi/v1/premiumIndex", { symbol: SYMBOL });
    const mark = +t.markPrice;
    if (mark > peak) peak = mark;
    const upnl = ((mark - entryPrice) / entryPrice) * STAKE_USD * LEVERAGE;
    process.stdout.write(`\r    t+${i}s: mark=$${mark.toFixed(5)} peak=$${peak.toFixed(5)} uPnL=$${upnl.toFixed(4)}    `);
    await pause(1000);
  }
  console.log("");

  // 6. MARKET close (this is what bot does when trail trigger fires)
  console.log("\n[6] Closing with MARKET SELL reduce-only (bot's exit method)...");
  const close = await signed("POST", "/fapi/v1/order", {
    symbol: SYMBOL, side: "SELL", type: "MARKET", positionSide: "LONG",
    quantity: fmt(qty, filters.qP), newClientOrderId: `test-close-${Date.now()}`,
  });
  openQty = 0;
  await pause(2000);
  console.log(`    ✓ Close order: ${close.orderId}`);

  // 7. Verify position flat
  const posCheck = await signed("GET", "/fapi/v2/positionRisk", { symbol: SYMBOL });
  const finalLong = posCheck.find((p: any) => p.positionSide === "LONG");
  console.log(`    Position size now: ${finalLong?.positionAmt ?? "0"}`);

  // 8. Fees + PnL from trade history
  console.log("\n[7] Trade history + final balance...");
  const trades = await signed("GET", "/fapi/v1/userTrades", { symbol: SYMBOL, limit: 5 });
  const recent = trades.slice(-2);
  let realizedPnl = 0, fees = 0;
  for (const t of recent) {
    realizedPnl += +t.realizedPnl;
    fees += +t.commission;
    console.log(`    ${t.side} ${t.qty} @ $${t.price} | realizedPnl=$${t.realizedPnl} fee=${t.commission} ${t.commissionAsset}`);
  }
  const bals = await signed("GET", "/fapi/v2/balance");
  const usdt = bals.find((b: any) => b.asset === "USDT");
  console.log(`\n    Total realized PnL: $${realizedPnl.toFixed(4)}`);
  console.log(`    Total fees: $${fees.toFixed(6)}`);
  console.log(`    USDT balance: $${(+usdt.balance).toFixed(4)} (available: $${(+usdt.availableBalance).toFixed(4)})`);

  console.log("\n══ TEST COMPLETE ══\n");
}

main().catch(async (e) => { console.error("\nFATAL:", e?.message ?? e); await cleanup(); process.exit(1); });

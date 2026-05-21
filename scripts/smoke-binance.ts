// Smoke test — public endpoints only (no auth). Inlined to avoid module
// resolution issues running cross-tsconfig.
//
// Usage:  npx ts-node scripts/smoke-binance.ts
// With auth:  BINANCE_KEY=<key> BINANCE_SECRET=<secret> npx ts-node scripts/smoke-binance.ts

import { createHmac } from "node:crypto";

const HOST = "https://fapi.binance.com";

async function publicGet(path: string, params: Record<string, string | number> = {}) {
  const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const url = `${HOST}${path}${qs ? "?" + qs : ""}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json() as any;
}

async function signedGet(path: string, apiKey: string, apiSecret: string, params: Record<string, string | number> = {}) {
  const timestamp = Date.now();
  const merged: Record<string, string | number> = { ...params, timestamp, recvWindow: 5000 };
  const query = Object.entries(merged).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const sig = createHmac("sha256", apiSecret).update(query).digest("hex");
  const url = `${HOST}${path}?${query}&signature=${sig}`;
  const r = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  return r.json() as any;
}

async function main() {
  console.log("\n══ Binance Smoke Test ══\n");

  console.log("[1] Server time...");
  const t = await publicGet("/fapi/v1/time");
  const offset = (t.serverTime - Date.now()) / 1000;
  console.log(`    serverTime=${t.serverTime}, offset=${offset.toFixed(2)}s\n`);

  console.log("[2] BTCUSDT 1h klines (last 5)...");
  const klines = await publicGet("/fapi/v1/klines", { symbol: "BTCUSDT", interval: "1h", limit: 5 });
  for (const k of klines) {
    console.log(`    ${new Date(+k[0]).toISOString().slice(0, 16)} O=${k[1]} H=${k[2]} L=${k[3]} C=${k[4]}`);
  }

  console.log("\n[3] Exchange info precision filters (5 sample symbols)...");
  const info = await publicGet("/fapi/v1/exchangeInfo");
  const sample = ["BTCUSDT", "ETHUSDT", "LDOUSDT", "DOGEUSDT", "POLUSDT"];
  for (const s of sample) {
    const sd = info.symbols?.find((x: any) => x.symbol === s);
    if (!sd) { console.log(`    ${s} not found`); continue; }
    const lot = sd.filters.find((f: any) => f.filterType === "LOT_SIZE");
    const price = sd.filters.find((f: any) => f.filterType === "PRICE_FILTER");
    const minN = sd.filters.find((f: any) => f.filterType === "MIN_NOTIONAL");
    console.log(`    ${s}: step=${lot?.stepSize} tick=${price?.tickSize} minQty=${lot?.minQty} minNotional=${minN?.notional} qPrec=${sd.quantityPrecision} pPrec=${sd.pricePrecision}`);
  }

  const apiKey = process.env.BINANCE_KEY;
  const apiSecret = process.env.BINANCE_SECRET;
  if (apiKey && apiSecret) {
    console.log("\n[4] Authenticated read — balances...");
    const bals = await signedGet("/fapi/v2/balance", apiKey, apiSecret);
    const usdt = bals.find((b: any) => b.asset === "USDT");
    console.log(`    ✓ USDT balance=$${(Number(usdt?.balance) || 0).toFixed(2)} available=$${(Number(usdt?.availableBalance) || 0).toFixed(2)}`);
    console.log(`    (${bals.length} balance entries total)`);

    console.log("\n[5] Authenticated read — positions...");
    const pos = await signedGet("/fapi/v2/positionRisk", apiKey, apiSecret);
    const open = pos.filter((p: any) => Math.abs(+p.positionAmt) > 1e-9);
    console.log(`    ✓ ${open.length} open positions of ${pos.length} tracked`);
    for (const p of open.slice(0, 10)) console.log(`      ${p.symbol} ${p.positionSide} amt=${p.positionAmt} entry=${p.entryPrice} uPnL=${p.unRealizedProfit}`);
  } else {
    console.log("\n[4/5] SKIPPED auth tests (no BINANCE_KEY / BINANCE_SECRET env vars).");
  }

  console.log("\n══ Smoke test complete ══\n");
}

main().catch((e) => { console.error("\nFATAL:", e?.message ?? e); process.exit(1); });

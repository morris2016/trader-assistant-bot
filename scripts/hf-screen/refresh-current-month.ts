// Refresh current-month (May 2026) klines for all 15 assets up to now.
// Deletes old file, re-fetches.

import * as fs from "fs";
import * as path from "path";

const CACHE_DIR = "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop/kline-cache";
const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LDOUSDT", "ADAUSDT", "LINKUSDT", "UNIUSDT", "AAVEUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT"];
const FROM = "2026-05-01";
const TO = "2026-05-31";

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchMonth(sym: string) {
  const fname = path.join(CACHE_DIR, `ticks-${sym}-1m-${FROM}-${TO}.json`);
  if (fs.existsSync(fname)) fs.unlinkSync(fname);  // force refresh
  const start = new Date(FROM + "T00:00:00Z").getTime();
  const end = Math.min(new Date(TO + "T23:59:59Z").getTime(), Date.now() - 60000);
  const out: any[] = [];
  let cursor = start;
  while (cursor < end) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${cursor}&endTime=${end}&limit=1500`;
    let resp: Response;
    try { resp = await fetch(url); } catch (e) { console.log(`  ${sym} err ${e}`); break; }
    if (!resp.ok) { console.log(`  ${sym} HTTP ${resp.status}`); break; }
    const raw = await resp.json();
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw) {
      out.push({
        epoch: Math.floor(k[0] / 1000),
        open: k[1], high: k[2], low: k[3], close: k[4],
        volume: k[5], quoteVolume: k[7], trades: k[8],
        takerBuyVolume: k[9], takerBuyQuote: k[10],
      });
    }
    const lastEpoch = raw[raw.length - 1][0];
    if (lastEpoch >= end) break;
    cursor = lastEpoch + 60_000;
    await sleep(300);
  }
  fs.writeFileSync(fname, JSON.stringify(out));
  const lastTs = out.length ? new Date(out[out.length - 1].epoch * 1000).toISOString() : "n/a";
  console.log(`  ${sym.padEnd(10)} ${out.length} bars  (last: ${lastTs})`);
}

async function main() {
  console.log(`Refreshing ${FROM} → now for ${ASSETS.length} symbols...`);
  for (const sym of ASSETS) await fetchMonth(sym);
  console.log(`\nDone.`);
}
main().catch(e => { console.error(e); process.exit(1); });

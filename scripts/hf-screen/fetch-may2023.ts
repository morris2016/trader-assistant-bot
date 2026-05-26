// One-off fetch: pull May 2023 1m klines for all 15 USDT-perps into kline-cache.
// Skips assets that didn't exist on Binance Futures yet.

import * as fs from "fs";
import * as path from "path";

const HOST = "https://fapi.binance.com";
const CACHE_DIR = "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop/kline-cache";
const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LDOUSDT", "ADAUSDT", "LINKUSDT", "UNIUSDT", "AAVEUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT"];
const REQ_LIMIT = 1500;
const REQ_GAP_MS = 300;
const FROM = "2023-05-01";
const TO = "2023-05-31";

const startMs = new Date(FROM + "T00:00:00Z").getTime();
const endMs = new Date(TO + "T23:59:59Z").getTime();

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function fetchMonth(sym: string) {
  const fname = path.join(CACHE_DIR, `ticks-${sym}-1m-${FROM}-${TO}.json`);
  if (fs.existsSync(fname) && fs.statSync(fname).size > 1024) {
    console.log(`  ${sym} already cached, skip`);
    return;
  }
  const out: any[] = [];
  let cursor = startMs;
  let failed = false;
  while (cursor < endMs) {
    const url = `${HOST}/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${cursor}&endTime=${endMs}&limit=${REQ_LIMIT}`;
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (e) {
      console.log(`  ${sym} fetch error ${e}`);
      failed = true; break;
    }
    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 400 && (text.includes("Invalid symbol") || text.includes("Invalid time"))) {
        console.log(`  ${sym} not yet listed in May 2023, skip`);
        return;
      }
      console.log(`  ${sym} HTTP ${resp.status} ${text.slice(0, 80)}`);
      failed = true; break;
    }
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
    if (lastEpoch >= endMs) break;
    cursor = lastEpoch + 60_000;
    process.stdout.write(`\r  ${sym} fetched ${out.length} bars, cursor=${new Date(cursor).toISOString().slice(0, 10)}        `);
    await sleep(REQ_GAP_MS);
  }
  if (failed && out.length < 100) return;
  fs.writeFileSync(fname, JSON.stringify(out));
  console.log(`\r  ${sym} → ${out.length} bars saved                                  `);
}

async function main() {
  console.log(`Fetching ${FROM} → ${TO} for ${ASSETS.length} symbols...`);
  for (const sym of ASSETS) await fetchMonth(sym);
  console.log(`\nDone.`);
}
main().catch(e => { console.error(e); process.exit(1); });

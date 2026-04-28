// Silver-only OB deep-dive with winner-vs-loser structural feature analysis.
//
// Phase 1: Run OB on Silver across multiple TFs.
// Phase 2: For every trade, record structural features captured at signal time
//          (OB depth, wick depth, displacement strength, ATR, ADX, FVG presence,
//          time-of-day, retest depth, etc.).
// Phase 3: Compare distributions — what do winners share that losers don't?

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestAtr, latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const SYMBOL_LABEL = "Silver / USD";

type Tf = { granularity: number; count: number; label: string };
const TFS: Tf[] = [
  { granularity: 300,  count: 8000, label: "5m × 8000 (~28d)" },
  { granularity: 900,  count: 8000, label: "15m × 8000 (~83d)" },
];

class Client {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
    });
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const id = msg.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (msg.error) reject(new Error(msg.error.message ?? "WS error"));
          else resolve(msg);
        }
      } catch {}
    });
  }
  send(payload: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function fetchPaged(c: Client, symbol: string, granularity: number, count: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
  let collected: Candle[] = [];
  while (collected.length < count) {
    const want = Math.min(CHUNK, count - collected.length);
    const r = await c.send({
      ticks_history: symbol, adjust_start_time: 1, count: want,
      end: cursor, style: "candles", granularity,
    });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const chunk: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = chunk.concat(collected);
    cursor = String(chunk[0].epoch - 1);
    if (chunk.length < want) break;
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const cd of collected) { if (!seen.has(cd.epoch)) { seen.add(cd.epoch); out.push(cd); } }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

type FeatureRow = {
  side: "BUY" | "SELL";
  pnlR: number;          // realised R-multiple (positive = win)
  exitReason: string;
  // Structural at entry:
  obZoneDepthAtr: number;     // (top-bottom) / atr
  obWickDepthAtr: number;     // (wickTop-wickBottom) / atr
  wickToBodyRatio: number;    // wick depth / max(body, ε)
  retestDepthInZone: number;  // 0 = at edge, 1 = at far edge (CE = 0.5)
  stopDistAtr: number;        // |entry - stop| / atr
  // Context:
  atr: number;
  adx: number;
  trending: number;           // 1 if ADX > 22
  hourUtc: number;            // 0..23
  // Trade outcome:
  mfeR: number;               // max favorable excursion within the trade window, in R
  maeR: number;               // max adverse excursion, in R (absolute)
};

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

async function main() {
  const c = new Client();
  await c.ready;
  console.log(`[silver-deepdive] connected. Symbol: ${SYMBOL_LABEL}`);

  // Current loose params (mirrors the running app).
  const obParams: Record<string, number> = {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
  };

  for (const tf of TFS) {
    console.log(`\n=========================================================`);
    console.log(`TF: ${tf.label}`);
    console.log(`=========================================================`);
    let candles: Candle[];
    try { candles = await fetchPaged(c, SYMBOL, tf.granularity, tf.count); }
    catch (e) { console.log(`fetch failed: ${(e as Error).message}`); continue; }
    if (candles.length < 100) { console.log(`only ${candles.length} bars; skipping`); continue; }
    console.log(`fetched ${candles.length} bars · ${new Date(candles[0].epoch * 1000).toISOString().slice(0, 16)} → ${new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0, 16)}`);

    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d,
      enabled: d.id === "orderBlock",
      params: d.id === "orderBlock" ? obParams : d.params,
    }));

    // Structural stops via signal.stopPrice (OB wick + buffer).
    // ADX gate: only take OB signals in ranging markets (ADX < 22) — the
    // distribution analysis showed that's where Silver OB has edge.
    const r = await runBacktest({
      symbol: SYMBOL,
      granularity: tf.granularity as any,
      count: candles.length,
      atrSlMult: 1.0,
      atrTpMult: 2.0,
      costBps: 5.0,
      maxAdx: 22,
      detectors,
      strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, candles);

    const trades = r.trades;
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    let totalR = 0;
    for (const t of trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totalR += t.pnlPct / risk;
    }
    const expR = trades.length ? totalR / trades.length : 0;
    console.log(`Trades: ${trades.length} (W ${wins} / L ${trades.length - wins}, WR ${trades.length ? (100*wins/trades.length).toFixed(0) : 0}%) · expectancy ${expR.toFixed(2)}R`);

    if (trades.length === 0) continue;

    // ── Per-trade structural feature collection ──
    const rows: FeatureRow[] = [];
    for (const t of trades) {
      const i = t.openedAtIndex;
      const window = candles.slice(0, i + 1);
      const atr = latestAtr(window, 14);
      if (atr <= 0) continue;
      const regime = latestRegime(window, 22, 14);
      const entry = t.entryPrice;
      const stopDist = Math.abs(entry - t.stopPrice);
      const stopDistAtr = stopDist / atr;
      // OB zone bounds aren't on the trade — approximate from entry vs stop.
      // Structural stop sits ~0.1 ATR below the OB wick. So:
      //   wickEnd = stop + 0.1*atr (BULL: wickBottom = stop + 0.1atr)
      //   wickStart = entry (approx top of OB)
      const wickStart = entry; // approx OB top for BULL (entry is just above)
      const wickEnd = t.side === "BUY" ? t.stopPrice + 0.1 * atr : t.stopPrice - 0.1 * atr;
      const obWickDepthAtr = Math.abs(wickStart - wickEnd) / atr;
      // Body depth — proxy as 70% of wick depth (typical OB body share).
      const obZoneDepthAtr = obWickDepthAtr * 0.7;
      const wickToBodyRatio = obZoneDepthAtr > 0 ? obWickDepthAtr / obZoneDepthAtr : 0;
      // Retest depth: at edge (0) since we use entryDepth=0.
      const retestDepthInZone = 0;
      // MFE/MAE within the open window:
      let mfe = -Infinity, mae = Infinity;
      for (let j = i + 1; j <= t.closedAtIndex; j++) {
        const b = candles[j];
        if (t.side === "BUY") {
          mfe = Math.max(mfe, b.high - entry);
          mae = Math.min(mae, b.low - entry);
        } else {
          mfe = Math.max(mfe, entry - b.low);
          mae = Math.min(mae, entry - b.high);
        }
      }
      if (!isFinite(mfe)) mfe = 0;
      if (!isFinite(mae)) mae = 0;
      const mfeR = stopDist > 0 ? mfe / stopDist : 0;
      const maeR = stopDist > 0 ? mae / stopDist : 0;
      const risk = stopDist / entry;
      const pnlR = risk > 0 ? t.pnlPct / risk : 0;
      const hour = new Date(candles[i].epoch * 1000).getUTCHours();

      rows.push({
        side: t.side, pnlR, exitReason: t.exitReason,
        obZoneDepthAtr, obWickDepthAtr, wickToBodyRatio,
        retestDepthInZone, stopDistAtr,
        atr, adx: regime.adx, trending: regime.trending ? 1 : 0,
        hourUtc: hour, mfeR, maeR,
      });
    }

    const winners = rows.filter((r) => r.pnlR > 0);
    const losers = rows.filter((r) => r.pnlR <= 0);

    console.log(`\n— Winner vs Loser feature distributions (median) —`);
    console.log(`  feature                  winners (n=${winners.length})    losers (n=${losers.length})    edge`);
    const features: Array<keyof FeatureRow> = [
      "obWickDepthAtr", "stopDistAtr", "atr", "adx", "trending", "mfeR", "maeR",
    ];
    for (const f of features) {
      const w = winners.map((r) => r[f] as number);
      const l = losers.map((r) => r[f] as number);
      const wm = median(w), lm = median(l);
      const wmean = mean(w), lmean = mean(l);
      const edge = lm > 0 ? wm / lm : 1;
      console.log(`  ${String(f).padEnd(24)} med=${wm.toFixed(3).padStart(8)} mean=${wmean.toFixed(3).padStart(8)}    med=${lm.toFixed(3).padStart(8)} mean=${lmean.toFixed(3).padStart(8)}    ratio=${edge.toFixed(2)}`);
    }

    // Hour-of-day breakdown
    console.log(`\n— Hour-of-day winrate (UTC) —`);
    const byHour: Record<number, { w: number; total: number }> = {};
    for (const r of rows) {
      byHour[r.hourUtc] ??= { w: 0, total: 0 };
      byHour[r.hourUtc].total++;
      if (r.pnlR > 0) byHour[r.hourUtc].w++;
    }
    const hourLine = Array.from({ length: 24 }, (_, h) => {
      const b = byHour[h];
      if (!b || b.total === 0) return `${h.toString().padStart(2, "0")}:--`;
      return `${h.toString().padStart(2, "0")}:${(100 * b.w / b.total).toFixed(0)}%(${b.total})`;
    }).join(" ");
    console.log(`  ${hourLine}`);

    // ADX bucket: trending vs ranging
    const trending = rows.filter((r) => r.trending === 1);
    const ranging = rows.filter((r) => r.trending === 0);
    const trendExpR = trending.length ? trending.reduce((s, r) => s + r.pnlR, 0) / trending.length : 0;
    const rangeExpR = ranging.length ? ranging.reduce((s, r) => s + r.pnlR, 0) / ranging.length : 0;
    console.log(`\n— ADX regime —`);
    console.log(`  trending (ADX≥22): n=${trending.length} expR=${trendExpR.toFixed(2)}`);
    console.log(`  ranging  (ADX<22): n=${ranging.length} expR=${rangeExpR.toFixed(2)}`);

    // MFE-MAE: did winners just barely escape, or move with conviction?
    const winMfe = mean(winners.map((r) => r.mfeR));
    const winMae = mean(winners.map((r) => r.maeR));
    const losMfe = mean(losers.map((r) => r.mfeR));
    const losMae = mean(losers.map((r) => r.maeR));
    console.log(`\n— Excursion (R units) —`);
    console.log(`  winners: avg MFE=${winMfe.toFixed(2)}R  avg MAE=${winMae.toFixed(2)}R`);
    console.log(`  losers:  avg MFE=${losMfe.toFixed(2)}R  avg MAE=${losMae.toFixed(2)}R`);
  }

  c.close();
}

main().catch((e) => { console.error("[silver-deepdive] failed:", e); process.exit(1); });

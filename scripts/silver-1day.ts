// Silver, 15m, 1 day = 96 bars. Apply the validated config and report.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const GRANULARITY = 900;   // 15m
const COUNT = 288;         // 288 × 15m = 72h (3 days)

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => { this.ws.on("open", () => resolve()); this.ws.on("error", reject); });
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function main() {
  const c = new C(); await c.ready;
  const r = await c.send({ ticks_history: SYMBOL, adjust_start_time: 1, count: COUNT, end: "latest", style: "candles", granularity: GRANULARITY });
  const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  const candles: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
  c.close();

  if (candles.length < 30) { console.log(`only ${candles.length} bars; cannot warm up`); return; }
  console.log(`Silver / USD · 15m × ${candles.length} bars (~24h)`);
  console.log(`window: ${new Date(candles[0].epoch * 1000).toISOString()} → ${new Date(candles[candles.length-1].epoch * 1000).toISOString()}`);

  // Same validated config as the cross-symbol validation: OB-only, ADX<22, structural stops.
  const obParams: Record<string, number> = {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
  };
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? obParams : d.params,
  }));

  const result = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 2.0, costBps: 5.0, maxAdx: 22,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  // Also run WITHOUT the ADX filter to see how many signals are being gated.
  const noFilter = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 2.0, costBps: 5.0,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  // Sample ADX over the window to see the regime.
  const adxSamples: number[] = [];
  for (let i = 30; i < candles.length; i += 4) {
    const reg = latestRegime(candles.slice(0, i + 1), 22, 14);
    adxSamples.push(reg.adx);
  }
  const minA = Math.min(...adxSamples), maxA = Math.max(...adxSamples);
  const meanA = adxSamples.reduce((s, x) => s + x, 0) / adxSamples.length;
  const rangingPct = (adxSamples.filter((a) => a < 22).length / adxSamples.length) * 100;

  console.log(`\nADX summary across window:`);
  console.log(`  min=${minA.toFixed(1)} · mean=${meanA.toFixed(1)} · max=${maxA.toFixed(1)}`);
  console.log(`  bars in ranging regime (ADX<22): ${rangingPct.toFixed(0)}%`);
  console.log(`\nSignals (no ADX gate):       ${noFilter.trades.length}`);
  console.log(`Signals (ADX<26 gate):       ${result.trades.length}`);

  // Compare four signal-source modes on the 52-day Silver sample.
  console.log(`\n— Comparing modes on 52-day Silver sample (15m × 5000 bars) —`);
  const c2 = new C(); await c2.ready;
  const r2 = await c2.send({ ticks_history: SYMBOL, adjust_start_time: 1, count: 5000, end: "latest", style: "candles", granularity: GRANULARITY });
  const raw2 = (r2.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  const deepCandles: Candle[] = raw2.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
  c2.close();

  type Mode = { name: string; detectorIds: string[]; req: Partial<{ maxAdx: number; minAdx: number; withTrendOnlyAboveAdx: number }> };
  const modes: Mode[] = [
    { name: "OB ranging only (current)",            detectorIds: ["orderBlock"],     req: { maxAdx: 22 } },
    { name: "FVG only — no filter",                 detectorIds: ["fvg"],            req: {} },
    { name: "FVG only — trending (minAdx=22)",      detectorIds: ["fvg"],            req: { minAdx: 22 } },
    { name: "FVG only — trending with-trend",       detectorIds: ["fvg"],            req: { minAdx: 22, withTrendOnlyAboveAdx: 22 } },
    { name: "LiqSweep only — no filter",            detectorIds: ["liquiditySweep"], req: {} },
    { name: "LiqSweep only — trending with-trend",  detectorIds: ["liquiditySweep"], req: { minAdx: 22, withTrendOnlyAboveAdx: 22 } },
    { name: "OB ranging + FVG trending with-trend", detectorIds: ["orderBlock", "fvg"], req: { withTrendOnlyAboveAdx: 22 } },
  ];

  for (const m of modes) {
    const dets: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: m.detectorIds.includes(d.id),
      params: d.id === "orderBlock" ? obParams : d.params,
    }));
    const r = await runBacktest({
      symbol: SYMBOL, granularity: GRANULARITY as any, count: deepCandles.length,
      atrSlMult: 1.0, atrTpMult: 2.0, costBps: 5.0,
      ...m.req,
      detectors: dets, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, deepCandles);
    const w = r.trades.filter((t) => t.pnlPct > 0).length;
    let totR = 0, usdT = 0;
    for (const t of r.trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totR += t.pnlPct / risk;
      usdT += 50 * Math.max(-1, t.pnlPct * 30);
    }
    const ex = r.trades.length ? totR / r.trades.length : 0;
    const wr = r.trades.length ? (100 * w / r.trades.length).toFixed(0) : "0";
    console.log(`  ${m.name.padEnd(48)} trades=${String(r.trades.length).padStart(3)} · WR=${wr.padStart(3)}% · expR=${(ex >= 0 ? "+" : "") + ex.toFixed(2)} · pnl=${(usdT >= 0 ? "+" : "") + "$" + usdT.toFixed(2)}`);
  }

  const trades = result.trades;
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of trades) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += 50 * Math.max(-1, t.pnlPct * 30);
  }
  const expR = trades.length ? totalR / trades.length : 0;

  console.log(`\nTrades: ${trades.length} (${wins}W / ${trades.length - wins}L · WR ${trades.length ? (100 * wins / trades.length).toFixed(0) : 0}%)`);
  console.log(`Expectancy: ${expR >= 0 ? "+" : ""}${expR.toFixed(2)}R`);
  console.log(`Total P&L %: ${(result.stats.totalPnlPct * 100).toFixed(2)}%`);
  console.log(`Total P&L USD ($50 × 30× MULT): ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`);

  if (trades.length > 0) {
    console.log(`\nTrade-by-trade:`);
    console.log(`  ${"#".padStart(2)} ${"opened (UTC)".padEnd(20)} ${"side".padEnd(4)} ${"entry".padStart(9)} ${"stop".padStart(9)} ${"target".padStart(9)} ${"exit".padStart(9)} ${"R".padStart(7)} ${"$".padStart(8)} reason`);
    for (let i = 0; i < trades.length; i++) {
      const t = trades[i];
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      const r = risk > 0 ? t.pnlPct / risk : 0;
      const usd = 50 * Math.max(-1, t.pnlPct * 30);
      const opened = new Date(candles[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(
        `  ${String(i + 1).padStart(2)} ${opened.padEnd(20)} ${t.side.padEnd(4)} ${t.entryPrice.toFixed(4).padStart(9)} ${t.stopPrice.toFixed(4).padStart(9)} ${t.targetPrice.toFixed(4).padStart(9)} ${t.exitPrice.toFixed(4).padStart(9)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"} ${(usd >= 0 ? "+" : "") + "$" + usd.toFixed(2)} ${t.exitReason}`,
      );
    }
  } else {
    console.log(`\n(no signals fired in this 24h window — typical for low-volatility/quiet days; ADX gate may have rejected all candidates)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

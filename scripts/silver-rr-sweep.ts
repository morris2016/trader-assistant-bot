// Sweep target R-multiple for Silver-OB-ranging on 52d × 15m.
// Same setup, just widen the TP. Find the R:R that maximises both
// expectancy R and total $ — they may differ.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const GRANULARITY = 900;
const COUNT = 5000;

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

  console.log(`Silver / USD · 15m × ${candles.length} bars · OB ranging only · R:R sweep\n`);
  console.log(`R:R     trades  WR    ExpR     PnL %     PnL $    avgWinR  avgLossR  TPhits  SLhits  RunEnd`);

  for (const rMult of [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0]) {
    const obParams: Record<string, number> = {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
      requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: rMult,
    };
    const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d, enabled: d.id === "orderBlock",
      params: d.id === "orderBlock" ? obParams : d.params,
    }));

    const result = await runBacktest({
      symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
      atrSlMult: 1.0, atrTpMult: rMult, costBps: 5.0, maxAdx: 22,
      detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, candles);

    const trades = result.trades;
    const wins = trades.filter((t) => t.pnlPct > 0).length;
    let totR = 0, usdT = 0;
    let winRSum = 0, lossRSum = 0;
    let tpCount = 0, slCount = 0, runEndCount = 0, oppCount = 0;
    for (const t of trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      const r = risk > 0 ? t.pnlPct / risk : 0;
      if (risk > 0) totR += r;
      usdT += 50 * Math.max(-1, t.pnlPct * 30);
      if (t.pnlPct > 0) winRSum += r; else lossRSum += r;
      if (t.exitReason === "tp") tpCount++;
      else if (t.exitReason === "sl") slCount++;
      else if (t.exitReason === "run_end") runEndCount++;
      else if (t.exitReason === "opposite_signal") oppCount++;
    }
    const avgWinR = wins ? winRSum / wins : 0;
    const losses = trades.length - wins;
    const avgLossR = losses ? lossRSum / losses : 0;
    const exp = trades.length ? totR / trades.length : 0;
    const wr = trades.length ? (100 * wins / trades.length).toFixed(0) : "0";

    console.log(
      `${rMult.toFixed(1).padStart(4)}:1   ${String(trades.length).padStart(3)}    ${wr.padStart(3)}%  ` +
      `${(exp >= 0 ? "+" : "") + exp.toFixed(2)}R  ` +
      `${(result.stats.totalPnlPct * 100).toFixed(2).padStart(7)}%  ` +
      `${(usdT >= 0 ? "+" : "") + "$" + usdT.toFixed(2)}   ` +
      `${(avgWinR >= 0 ? "+" : "") + avgWinR.toFixed(2)}R   ` +
      `${avgLossR.toFixed(2)}R    ` +
      `${String(tpCount).padStart(3)}    ${String(slCount).padStart(3)}     ${String(runEndCount).padStart(2)}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

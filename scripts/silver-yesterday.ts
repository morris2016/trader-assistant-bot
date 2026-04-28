// Replay the validated Silver bot config across the last 6 trading days,
// reporting per-day P&L as if we'd been live each day.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { latestRegime } from "../src/main/engine/indicators";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const GRANULARITY = 900;
const STAKE = 50;
const MULT = 30;
const DAYS = 6;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res, rej) => { this.ws.on("open", () => res()); this.ws.on("error", rej); });
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
  // 6 days × ~96 + warmup + weekend gap. Fetch ~10 days.
  const r = await c.send({ ticks_history: SYMBOL, adjust_start_time: 1, count: 1200, end: "latest", style: "candles", granularity: GRANULARITY });
  const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  const candles: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
  c.close();
  if (candles.length < 200) { console.log(`only ${candles.length} bars`); return; }

  // Bucket by UTC day, keep only days with ≥ 60 bars.
  const byDay: Record<string, number[]> = {};
  for (let i = 0; i < candles.length; i++) {
    const day = new Date(candles[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay)
    .filter(([, idx]) => idx.length >= 60)
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (fullDays.length === 0) { console.log("no full trading days in window"); return; }

  const lastN = fullDays.slice(-DAYS);
  console.log(`Silver / USD · last ${lastN.length} trading days · 15m`);
  console.log(`Config: OB-only, ADX<22, structural stops, 3:1 R:R, 5 bps cost, $${STAKE} × ${MULT}× MULTIPLIER\n`);

  const obParams: Record<string, number> = {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
  };
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d, enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? obParams : d.params,
  }));

  const result = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 3.0, costBps: 5.0, maxAdx: 22,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  const noGate = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 3.0, costBps: 5.0,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  let cumUsd = 0, cumR = 0, cumTrades = 0, cumWins = 0;

  for (const [day, idx] of lastN) {
    const dayStart = candles[idx[0]].epoch;
    const dayEnd = candles[idx[idx.length - 1]].epoch;
    const yTrades = result.trades.filter((t) => {
      const e = candles[t.openedAtIndex].epoch;
      return e >= dayStart && e <= dayEnd;
    });
    const yRaw = noGate.trades.filter((t) => {
      const e = candles[t.openedAtIndex].epoch;
      return e >= dayStart && e <= dayEnd;
    });

    let adxBelow22 = 0;
    let adxMin = Infinity, adxMax = -Infinity, adxSum = 0, adxN = 0;
    for (const i of idx) {
      if (i < 30) continue;
      const reg = latestRegime(candles.slice(0, i + 1), 22, 14);
      adxSum += reg.adx; adxN++;
      if (reg.adx < adxMin) adxMin = reg.adx;
      if (reg.adx > adxMax) adxMax = reg.adx;
      if (reg.adx < 22) adxBelow22++;
    }
    const dayHigh = Math.max(...idx.map((i) => candles[i].high));
    const dayLow = Math.min(...idx.map((i) => candles[i].low));
    const dayOpen = candles[idx[0]].open;
    const dayClose = candles[idx[idx.length - 1]].close;
    const movePct = ((dayClose - dayOpen) / dayOpen) * 100;

    console.log(`══════════════════════════════════════════════════════════════════════════`);
    console.log(`${day} (UTC) · ${idx.length} bars · open ${dayOpen.toFixed(4)} → close ${dayClose.toFixed(4)} (${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%) · range ${dayLow.toFixed(4)} – ${dayHigh.toFixed(4)}`);
    if (adxN > 0) console.log(`  ADX: min ${adxMin.toFixed(1)} · mean ${(adxSum / adxN).toFixed(1)} · max ${adxMax.toFixed(1)} · ranging ADX<22: ${adxBelow22}/${adxN} (${(100 * adxBelow22 / adxN).toFixed(0)}%)`);
    console.log(`  raw OB signals: ${yRaw.length} · trades fired: ${yTrades.length}`);

    if (yTrades.length > 0) {
      let dayUsd = 0, dayR = 0;
      console.log(`    ${"#".padStart(2)} ${"opened (UTC)".padEnd(20)} ${"side".padEnd(4)} ${"entry".padStart(9)} ${"stop".padStart(9)} ${"target".padStart(9)} ${"exit".padStart(9)} ${"R".padStart(7)} ${"$".padStart(8)} reason`);
      for (let i = 0; i < yTrades.length; i++) {
        const t = yTrades[i];
        const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
        const r = risk > 0 ? t.pnlPct / risk : 0;
        const usd = STAKE * Math.max(-1, t.pnlPct * MULT);
        dayUsd += usd; dayR += r;
        const opened = new Date(candles[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
        console.log(`    ${String(i + 1).padStart(2)} ${opened.padEnd(20)} ${t.side.padEnd(4)} ${t.entryPrice.toFixed(4).padStart(9)} ${t.stopPrice.toFixed(4).padStart(9)} ${t.targetPrice.toFixed(4).padStart(9)} ${t.exitPrice.toFixed(4).padStart(9)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"} ${(usd >= 0 ? "+" : "") + "$" + usd.toFixed(2)} ${t.exitReason}`);
      }
      const wins = yTrades.filter((t) => t.pnlPct > 0).length;
      console.log(`  → day P&L: ${dayUsd >= 0 ? "+" : ""}$${dayUsd.toFixed(2)} · ${wins}W / ${yTrades.length - wins}L · ${dayR >= 0 ? "+" : ""}${dayR.toFixed(2)}R`);
      cumUsd += dayUsd; cumR += dayR; cumTrades += yTrades.length; cumWins += wins;
    } else {
      console.log(`  → day P&L: $0.00 (no fires)`);
    }
  }

  console.log(`══════════════════════════════════════════════════════════════════════════`);
  console.log(`${lastN.length}-DAY TOTAL`);
  console.log(`  Trades: ${cumTrades} (${cumWins}W / ${cumTrades - cumWins}L · WR ${cumTrades ? (100 * cumWins / cumTrades).toFixed(0) : 0}%)`);
  console.log(`  Total R:   ${cumR >= 0 ? "+" : ""}${cumR.toFixed(2)}R`);
  console.log(`  Total $:   ${cumUsd >= 0 ? "+" : ""}$${cumUsd.toFixed(2)}  (at $${STAKE} × ${MULT}× MULTIPLIER)`);
  if (cumTrades > 0) console.log(`  Avg per trade: ${cumUsd >= 0 ? "+" : ""}$${(cumUsd / cumTrades).toFixed(2)}`);
  if (cumTrades === 0) console.log(`  (Bot stayed flat across all ${lastN.length} days — see ADX/OB coverage above for why.)`);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Replay the validated Silver FVG strategy across the last 3 trading days.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import { latestRegime } from "../src/main/engine/indicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = silverFvg.symbols[0];
const GRANULARITY = silverFvg.granularity;
const STAKE = silverFvg.validation.stake;
const MULT = silverFvg.validation.multiplier;
const DAYS = 3;

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
  // 3 days × 24 1h bars + warmup + weekend gap. Fetch 250.
  const r = await c.send({ ticks_history: SYMBOL, adjust_start_time: 1, count: 250, end: "latest", style: "candles", granularity: GRANULARITY });
  const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  const candles: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
  c.close();
  if (candles.length < 60) { console.log(`only ${candles.length} bars`); return; }

  const byDay: Record<string, number[]> = {};
  for (let i = 0; i < candles.length; i++) {
    const day = new Date(candles[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay).filter(([, idx]) => idx.length >= 18).sort((a, b) => a[0].localeCompare(b[0]));
  if (fullDays.length === 0) { console.log("no full trading days"); return; }
  const lastN = fullDays.slice(-DAYS);

  console.log(`Silver FVG replay · last ${lastN.length} trading days · 1h`);
  console.log(`Config: fvg only · minGap=0.7×ATR · edge entry · 3:1 R:R · structural stops · 5 bps · $${STAKE} × ${MULT}× MULT\n`);

  const result = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: silverFvg.atrSlMult, atrTpMult: silverFvg.atrTpMult, costBps: silverFvg.costBps,
    detectors: silverFvg.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  let cumUsd = 0, cumR = 0, cumTrades = 0, cumWins = 0;

  for (const [day, idx] of lastN) {
    const dayStart = candles[idx[0]].epoch;
    const dayEnd = candles[idx[idx.length - 1]].epoch;
    const yTrades = result.trades.filter((t) => {
      const e = candles[t.openedAtIndex].epoch;
      return e >= dayStart && e <= dayEnd;
    });

    let adxMin = Infinity, adxMax = -Infinity, adxSum = 0, adxN = 0;
    for (const i of idx) {
      if (i < 30) continue;
      const reg = latestRegime(candles.slice(0, i + 1), 22, 14);
      adxSum += reg.adx; adxN++;
      if (reg.adx < adxMin) adxMin = reg.adx;
      if (reg.adx > adxMax) adxMax = reg.adx;
    }
    const dayHigh = Math.max(...idx.map((i) => candles[i].high));
    const dayLow = Math.min(...idx.map((i) => candles[i].low));
    const dayOpen = candles[idx[0]].open;
    const dayClose = candles[idx[idx.length - 1]].close;
    const movePct = ((dayClose - dayOpen) / dayOpen) * 100;

    console.log(`══════════════════════════════════════════════════════════════════════════`);
    console.log(`${day} (UTC) · ${idx.length} bars · open ${dayOpen.toFixed(4)} → close ${dayClose.toFixed(4)} (${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%) · range ${dayLow.toFixed(4)}–${dayHigh.toFixed(4)}`);
    if (adxN > 0) console.log(`  ADX: min ${adxMin.toFixed(1)} · mean ${(adxSum / adxN).toFixed(1)} · max ${adxMax.toFixed(1)}`);
    console.log(`  trades fired: ${yTrades.length}`);

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
}
main().catch((e) => { console.error(e); process.exit(1); });

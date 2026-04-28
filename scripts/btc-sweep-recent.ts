// BTC Sweep — last 10 days replay with $500 account simulation.
// Mirrors the Silver replay format but for the BTC Sweep strategy.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { btcSweep } from "../src/main/engine/strategies/btc-sweep";
import { latestRegime } from "../src/main/engine/indicators";
import type { Candle, BacktestTrade } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = btcSweep.symbols[0];
const GRANULARITY = btcSweep.granularity;
const STAKE = btcSweep.validation.stake;
const MULT = btcSweep.validation.multiplier;
const DAYS = 15;
const START_BALANCE = 500;
const EXIT_DD_PCT = 0.40;

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

function tradeUsd(t: BacktestTrade): number { return STAKE * Math.max(-1, t.pnlPct * MULT); }

async function main() {
  const c = new C(); await c.ready;
  // 15 days × 24 1h bars + warmup. Fetch 500 to be safe.
  const r = await c.send({ ticks_history: SYMBOL, adjust_start_time: 1, count: 500, end: "latest", style: "candles", granularity: GRANULARITY });
  const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
  const candles: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
  c.close();
  if (candles.length < 60) { console.log(`only ${candles.length} bars`); return; }

  // Bucket by UTC day. BTC trades 24/7 so most days have ~24 1h bars.
  const byDay: Record<string, number[]> = {};
  for (let i = 0; i < candles.length; i++) {
    const day = new Date(candles[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay).filter(([, idx]) => idx.length >= 18).sort((a, b) => a[0].localeCompare(b[0]));
  const lastN = fullDays.slice(-DAYS);

  console.log(`BTC Sweep replay · last ${lastN.length} trading days · 1h`);
  console.log(`Config: liquiditySweep only · confirmation-style entry · 3:1 R:R · structural stops · no ADX filter · 5 bps cost · $${STAKE} × ${MULT}× MULT\n`);

  const result = await runBacktest({
    symbol: SYMBOL, granularity: GRANULARITY as any, count: candles.length,
    atrSlMult: btcSweep.atrSlMult, atrTpMult: btcSweep.atrTpMult, costBps: btcSweep.costBps,
    detectors: btcSweep.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);

  let cumUsd = 0, cumR = 0, cumTrades = 0, cumWins = 0;

  // Per-day report.
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
    console.log(`${day} (UTC) · ${idx.length} bars · open ${dayOpen.toFixed(2)} → close ${dayClose.toFixed(2)} (${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%) · range ${dayLow.toFixed(0)}–${dayHigh.toFixed(0)}`);
    if (adxN > 0) console.log(`  ADX: min ${adxMin.toFixed(1)} · mean ${(adxSum / adxN).toFixed(1)} · max ${adxMax.toFixed(1)}`);
    console.log(`  trades fired: ${yTrades.length}`);

    if (yTrades.length > 0) {
      let dayUsd = 0, dayR = 0;
      console.log(`    ${"#".padStart(2)} ${"opened (UTC)".padEnd(20)} ${"side".padEnd(4)} ${"entry".padStart(10)} ${"stop".padStart(10)} ${"target".padStart(10)} ${"exit".padStart(10)} ${"R".padStart(7)} ${"$".padStart(8)} reason`);
      for (let i = 0; i < yTrades.length; i++) {
        const t = yTrades[i];
        const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
        const r = risk > 0 ? t.pnlPct / risk : 0;
        const usd = tradeUsd(t);
        dayUsd += usd; dayR += r;
        const opened = new Date(candles[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
        console.log(`    ${String(i + 1).padStart(2)} ${opened.padEnd(20)} ${t.side.padEnd(4)} ${t.entryPrice.toFixed(2).padStart(10)} ${t.stopPrice.toFixed(2).padStart(10)} ${t.targetPrice.toFixed(2).padStart(10)} ${t.exitPrice.toFixed(2).padStart(10)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"} ${(usd >= 0 ? "+" : "") + "$" + usd.toFixed(2)} ${t.exitReason}`);
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
  console.log(`  Total $:   ${cumUsd >= 0 ? "+" : ""}$${cumUsd.toFixed(2)}  (at $${STAKE} × ${MULT}× MULT)`);
  if (cumTrades > 0) console.log(`  Avg per trade: ${cumUsd >= 0 ? "+" : ""}$${(cumUsd / cumTrades).toFixed(2)}`);

  // Account simulation
  console.log(`\n══════════════════════════════════════════════════════════════════════════`);
  console.log(`$${START_BALANCE} ACCOUNT SIMULATION (chronological trade-by-trade walk)`);
  console.log(`══════════════════════════════════════════════════════════════════════════`);
  const winStart = candles[lastN[0][1][0]].epoch;
  const winEnd = candles[lastN[lastN.length - 1][1][lastN[lastN.length - 1][1].length - 1]].epoch + 3600;
  const trades = result.trades.filter((t) => {
    const e = candles[t.openedAtIndex].epoch;
    return e >= winStart && e <= winEnd;
  });

  let balance = START_BALANCE;
  let peak = START_BALANCE;
  let busted = false, exited = false;
  let exitHit: { trade: number; bal: number; date: string } | null = null;
  let bustHit: { trade: number; bal: number; date: string } | null = null;
  let tradesTaken = 0, wins = 0;

  console.log(`  ${"#".padStart(3)}  ${"date".padEnd(18)} ${"side".padEnd(4)} ${"R".padStart(7)} ${"trade $".padStart(9)}  ${"balance".padStart(10)} ${"peak".padStart(8)} ${"DD".padStart(6)}`);
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const opened = new Date(candles[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (busted) { console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${t.side.padEnd(4)}        skipped (busted)`); continue; }
    if (exited) { console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${t.side.padEnd(4)}        skipped (exited at −${(EXIT_DD_PCT*100).toFixed(0)}% DD)`); continue; }
    if (balance < STAKE) { console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${t.side.padEnd(4)}        skipped (balance < $${STAKE})`); continue; }

    const usd = tradeUsd(t);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;
    if (balance > peak) peak = balance;
    const ddPct = peak > 0 ? ((balance - peak) / peak) * 100 : 0;
    const r = (() => { const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice; return risk > 0 ? t.pnlPct / risk : 0; })();

    let flag = "";
    if (!exitHit && ddPct <= -EXIT_DD_PCT * 100) {
      exitHit = { trade: i + 1, bal: balance, date: opened };
      exited = true;
      flag = `  ← −${(EXIT_DD_PCT*100).toFixed(0)}% DD EXIT`;
    }
    if (balance < STAKE && !bustHit) {
      bustHit = { trade: i + 1, bal: balance, date: opened };
      busted = true;
      flag = "  ← ACCOUNT BUST";
    }

    const sign = usd >= 0 ? "+" : "";
    console.log(
      `  ${String(i + 1).padStart(3)}  ${opened.padEnd(18)} ${t.side.padEnd(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${sign}$${usd.toFixed(2).padStart(7)}  $${balance.toFixed(2).padStart(8)} $${peak.toFixed(2).padStart(7)} ${ddPct.toFixed(0).padStart(4)}%${flag}`,
    );
  }

  console.log(`\n──────────────────────────────────────────────────────────────────────────`);
  console.log(`SIMULATION RESULT`);
  console.log(`  Final balance:      $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak balance:       $${peak.toFixed(2)}`);
  console.log(`  Trades taken:       ${tradesTaken} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken ? (100*wins/tradesTaken).toFixed(0) : 0}%)`);
  console.log(`  Exit at −${(EXIT_DD_PCT*100).toFixed(0)}% DD: ${exitHit ? `trade #${exitHit.trade} on ${exitHit.date} (balance $${exitHit.bal.toFixed(2)})` : "never reached — held through"}`);
  console.log(`  Account bust:       ${bustHit ? `trade #${bustHit.trade}` : "never reached"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

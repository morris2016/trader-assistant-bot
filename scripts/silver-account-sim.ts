// $300 account simulation over the last ~30 trading days using all 3 Silver
// strategies. Walks balance trade-by-trade, flags exit triggers (drawdown
// thresholds + bust point), reports equity curve.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverSweep } from "../src/main/engine/strategies/silver-sweep";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import type { Candle, BacktestTrade } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";

const START_BALANCE = 500;
const STAKE = 50;
const MULT = 30;
const DAYS = 120;
const MIN_BALANCE_TO_TRADE = STAKE;
const EXIT_DD_PCT = 0.40; // hard exit at 40% drawdown from peak

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

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: string = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const c of collected) if (!seen.has(c.epoch)) { seen.add(c.epoch); out.push(c); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

function tradeUsd(t: BacktestTrade): number {
  return STAKE * Math.max(-1, t.pnlPct * MULT);
}

async function main() {
  const c = new C(); await c.ready;
  const c15 = await fetchCandles(c, SYMBOL, 900, 9500);
  const c60 = await fetchCandles(c, SYMBOL, 3600, 4000);
  c.close();

  const obResult = await runBacktest({
    symbol: SYMBOL, granularity: 900 as any, count: c15.length,
    atrSlMult: silverOb.atrSlMult, atrTpMult: silverOb.atrTpMult, costBps: silverOb.costBps,
    maxAdx: silverOb.maxAdx, detectors: silverOb.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, c15);
  const swResult = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: c60.length,
    atrSlMult: silverSweep.atrSlMult, atrTpMult: silverSweep.atrTpMult, costBps: silverSweep.costBps,
    withTrendOnlyAboveAdx: silverSweep.withTrendOnlyAboveAdx,
    detectors: silverSweep.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, c60);
  const fvgResult = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: c60.length,
    atrSlMult: silverFvg.atrSlMult, atrTpMult: silverFvg.atrTpMult, costBps: silverFvg.costBps,
    detectors: silverFvg.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, c60);

  // Bucket days from 1h (more history available than 15m for Silver).
  // OB days outside the 15m window simply contribute 0 trades.
  const byDay: Record<string, number[]> = {};
  for (let i = 0; i < c60.length; i++) {
    const day = new Date(c60[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay).filter(([, idx]) => idx.length >= 18).sort((a, b) => a[0].localeCompare(b[0]));
  const lastN = fullDays.slice(-DAYS);
  const winStart = c60[lastN[0][1][0]].epoch;
  const winEnd = c60[lastN[lastN.length - 1][1][lastN[lastN.length - 1][1].length - 1]].epoch + 3600;

  // Combine all trades chronologically.
  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[] };
  const allTrades: Tagged[] = [
    ...fvgResult.trades.map((t) => ({ t, tag: "FVG", cs: c60 })),
    ...swResult.trades.map((t) => ({ t, tag: "SW ", cs: c60 })),
    ...obResult.trades.map((t) => ({ t, tag: "OB ", cs: c15 })),
  ];
  const inWindow = allTrades.filter((x) => {
    const e = x.cs[x.t.openedAtIndex].epoch;
    return e >= winStart && e <= winEnd;
  });
  inWindow.sort((a, b) => a.cs[a.t.openedAtIndex].epoch - b.cs[b.t.openedAtIndex].epoch);

  console.log(`Silver — $${START_BALANCE} ACCOUNT SIMULATION · last ${lastN.length} trading days`);
  console.log(`Stake $${STAKE} × ${MULT}× MULT · all 3 strategies (FVG + Sweep + OB)`);
  console.log(`Hard exit at −${(EXIT_DD_PCT * 100).toFixed(0)}% drawdown from peak; bust at < $${MIN_BALANCE_TO_TRADE}\n`);

  let balance = START_BALANCE;
  let peak = START_BALANCE;
  let busted = false;
  let exited = false;
  let exitHit: { trade: number; bal: number; date: string } | null = null;
  let bustHit: { trade: number; bal: number; date: string } | null = null;
  let skippedNoBalance = 0;
  let tradesTaken = 0;
  let wins = 0;

  console.log(`  ${"#".padStart(3)}  ${"date".padEnd(18)} ${"strat".padEnd(4)} ${"side".padEnd(4)} ${"R".padStart(7)} ${"trade $".padStart(9)}  ${"balance".padStart(10)} ${"peak".padStart(8)} ${"DD".padStart(7)}`);
  for (let i = 0; i < inWindow.length; i++) {
    const x = inWindow[i];
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (busted) {
      console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)}        skipped (account busted)`);
      continue;
    }
    if (exited) {
      console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)}        skipped (user exited at −${(EXIT_DD_PCT * 100).toFixed(0)}% DD)`);
      continue;
    }
    if (balance < MIN_BALANCE_TO_TRADE) {
      skippedNoBalance++;
      console.log(`  ${"-".padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)}        skipped (balance $${balance.toFixed(2)} < $${MIN_BALANCE_TO_TRADE})`);
      continue;
    }

    const usd = tradeUsd(x.t);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;

    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();

    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (balance - peak) / peak : 0;
    const ddPct = dd * 100;

    let flag = "";
    if (!exitHit && ddPct <= -EXIT_DD_PCT * 100) {
      exitHit = { trade: i + 1, bal: balance, date: opened };
      exited = true;
      flag = `  ← −${(EXIT_DD_PCT * 100).toFixed(0)}% DD EXIT (stops trading)`;
    }
    if (balance < MIN_BALANCE_TO_TRADE && !bustHit) {
      bustHit = { trade: i + 1, bal: balance, date: opened };
      busted = true;
      flag = "  ← ACCOUNT BUST";
    }

    const sign = usd >= 0 ? "+" : "";
    console.log(
      `  ${String(i + 1).padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${sign}$${usd.toFixed(2).padStart(7)}  $${balance.toFixed(2).padStart(8)} $${peak.toFixed(2).padStart(7)} ${ddPct.toFixed(0).padStart(5)}%${flag}`,
    );
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════`);
  console.log(`SIMULATION RESULT (${lastN.length} days, $${START_BALANCE} starting balance)`);
  console.log(`──────────────────────────────────────────────────────────────────────────`);
  console.log(`  Final balance:      $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak balance:       $${peak.toFixed(2)}  (+$${(peak - START_BALANCE).toFixed(2)} · +${(((peak - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Max drawdown:       ${(((Math.min(...computeBalances(START_BALANCE, inWindow)) - peak) / peak) * 100).toFixed(1)}% from peak`);
  console.log(`  Trades taken:       ${tradesTaken} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken > 0 ? (100 * wins / tradesTaken).toFixed(0) : 0}%)`);
  console.log(`  Trades skipped:     ${skippedNoBalance + (busted ? inWindow.length - tradesTaken - skippedNoBalance : 0)} (insufficient balance / busted)`);
  console.log(``);
  console.log(`  Exit at −${(EXIT_DD_PCT * 100).toFixed(0)}% DD: ${exitHit ? `trade #${exitHit.trade} on ${exitHit.date} (balance $${exitHit.bal.toFixed(2)})` : "never reached — held through"}`);
  console.log(`  Account bust:       ${bustHit ? `trade #${bustHit.trade} on ${bustHit.date} (balance $${bustHit.bal.toFixed(2)})` : "never reached"}`);
}

function computeBalances(start: number, trades: Array<{ t: BacktestTrade }>): number[] {
  const out: number[] = [start];
  let bal = start;
  for (const x of trades) {
    if (bal < STAKE) { out.push(bal); continue; }
    bal += tradeUsd(x.t);
    out.push(bal);
  }
  return out;
}

// re-use fetchPaged
async function fetchCandles(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  return fetchPaged(c, sym, gr, cnt);
}

main().catch((e) => { console.error(e); process.exit(1); });

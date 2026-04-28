// 6-month walk-forward across all 9 validated strategies.
// Fetches max available history per asset/TF (Deriv caps the depth so some
// strategies will hit their data limit short of 180 days).
// Reports per-strategy + combined portfolio results.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverSweep } from "../src/main/engine/strategies/silver-sweep";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import { ethOb } from "../src/main/engine/strategies/eth-ob";
import { ethSweep } from "../src/main/engine/strategies/eth-sweep";
import { ethFvg } from "../src/main/engine/strategies/eth-fvg";
import { goldOb } from "../src/main/engine/strategies/gold-ob";
import { goldSweep } from "../src/main/engine/strategies/gold-sweep";
import { goldFvg } from "../src/main/engine/strategies/gold-fvg";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30;
const TARGET_DAYS = 180; // 6 months

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

function tradeUsd(t: BacktestTrade): number { return STAKE * Math.max(-1, t.pnlPct * MULT); }

async function runStrategyOn(s: StrategyDescriptor, candles: Candle[]) {
  return runBacktest({
    symbol: s.symbols[0],
    granularity: s.granularity as any,
    count: candles.length,
    atrSlMult: s.atrSlMult, atrTpMult: s.atrTpMult, costBps: s.costBps,
    maxAdx: (s as Sd).maxAdx, minAdx: (s as Sd).minAdx,
    withTrendOnlyAboveAdx: (s as Sd).withTrendOnlyAboveAdx,
    skipDaysOfWeekUtc: (s as Sd).skipDaysOfWeekUtc,
    buyOnly: (s as Sd).buyOnly, sellOnly: (s as Sd).sellOnly,
    detectors: s.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
}

type Row = { id: string; asset: string; tf: string; days: number; trades: number; wins: number; expR: number; usd: number; usdPerYear: number };

function summarize(s: StrategyDescriptor, trades: BacktestTrade[], cs: Candle[]): Row {
  const wins = trades.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, usd = 0;
  for (const t of trades) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    usd += tradeUsd(t);
  }
  const expR = trades.length ? totalR / trades.length : 0;
  const days = cs.length ? Math.max(1, (cs[cs.length - 1].epoch - cs[0].epoch) / 86400) : 0;
  return {
    id: s.id,
    asset: s.symbols[0],
    tf: s.granularity === 900 ? "15m" : "1h",
    days,
    trades: trades.length,
    wins, expR, usd,
    usdPerYear: days > 0 ? (usd / days) * 365 : 0,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`[portfolio-6mo] All 9 strategies · ${TARGET_DAYS}d target window`);
  console.log(`Fetching max history per asset/TF (Deriv may cap shorter)...\n`);

  // Fetch max we can per asset+TF. TARGET_DAYS at 1h = 4320 bars; at 15m = 17280 bars.
  // Deriv typically caps Silver at ~1300 1h / ~3500 15m, ETH 1h at ~8000, Gold 1h at ~3300.
  const candles = {
    silver15: await fetchPaged(c, "frxXAGUSD", 900, 8000),
    silver60: await fetchPaged(c, "frxXAGUSD", 3600, 6000),
    eth60:    await fetchPaged(c, "cryETHUSD", 3600, 8000),
    gold60:   await fetchPaged(c, "frxXAUUSD", 3600, 6000),
  };
  c.close();

  const fmt = (n: number) => Math.round(n / (n > 24 ? 24 : 1));
  console.log(`Silver 15m: ${candles.silver15.length} bars (~${(candles.silver15.length/96).toFixed(0)}d)`);
  console.log(`Silver 1h:  ${candles.silver60.length} bars (~${(candles.silver60.length/24).toFixed(0)}d)`);
  console.log(`ETH 1h:     ${candles.eth60.length} bars (~${(candles.eth60.length/24).toFixed(0)}d)`);
  console.log(`Gold 1h:    ${candles.gold60.length} bars (~${(candles.gold60.length/24).toFixed(0)}d)`);

  const stratList: Array<{ s: StrategyDescriptor; cs: Candle[] }> = [
    { s: silverOb,     cs: candles.silver15 },
    { s: silverSweep,  cs: candles.silver60 },
    { s: silverFvg,    cs: candles.silver60 },
    { s: ethOb,        cs: candles.eth60 },
    { s: ethSweep,     cs: candles.eth60 },
    { s: ethFvg,       cs: candles.eth60 },
    { s: goldOb,       cs: candles.gold60 },
    { s: goldSweep,    cs: candles.gold60 },
    { s: goldFvg,      cs: candles.gold60 },
  ];

  console.log(`\nRunning all 9 strategies...`);
  const rows: Row[] = [];
  for (const { s, cs } of stratList) {
    const r = await runStrategyOn(s, cs);
    rows.push(summarize(s, r.trades, cs));
  }

  // Per-strategy table
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-STRATEGY (max available history, walk-forward backtest)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${"id".padEnd(14)} ${"asset".padEnd(6)} ${"TF".padEnd(4)} ${"days".padStart(5)}  ${"trades".padStart(6)}  ${"WR".padStart(4)}  ${"expR".padStart(7)}  ${"$ (period)".padStart(11)}  ${"$/yr".padStart(9)}`);
  for (const r of rows) {
    const wr = r.trades ? `${(100*r.wins/r.trades).toFixed(0)}%` : "—";
    const sa = r.asset.replace("fr", "").replace("cry", "").replace("USD", "");
    console.log(`  ${r.id.padEnd(14)} ${sa.padEnd(6)} ${r.tf.padEnd(4)} ${String(Math.round(r.days)).padStart(5)}  ${String(r.trades).padStart(6)}  ${wr.padStart(4)}  ${(r.expR>=0?"+":"")+r.expR.toFixed(2)+"R"}  ${(r.usd>=0?"+":"")+"$"+r.usd.toFixed(2).padStart(9)}  ${(r.usdPerYear>=0?"+":"")+"$"+r.usdPerYear.toFixed(0).padStart(7)}`);
  }

  // Combined annualized
  const totalUsd = rows.reduce((s, r) => s + r.usd, 0);
  const totalPerYear = rows.reduce((s, r) => s + r.usdPerYear, 0);
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  console.log(`  ${"".padEnd(14)} ${"".padEnd(6)} ${"".padEnd(4)} ${"".padStart(5)}  ${"".padStart(6)}  ${"".padStart(4)}  ${"".padStart(7)}  ${(totalUsd>=0?"+":"")+"$"+totalUsd.toFixed(2).padStart(9)}  ${(totalPerYear>=0?"+":"")+"$"+totalPerYear.toFixed(0).padStart(7)}`);

  // Walk-forward 180-day window equity for the strategies that have ≥180d data.
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`STRATEGIES WITH ≥${TARGET_DAYS}d DATA — last-${TARGET_DAYS}d slice`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  for (const { s, cs } of stratList) {
    if (cs.length === 0) continue;
    const totalDays = (cs[cs.length - 1].epoch - cs[0].epoch) / 86400;
    if (totalDays < TARGET_DAYS) continue;
    const cutoff = cs[cs.length - 1].epoch - TARGET_DAYS * 86400;
    const cutIdx = cs.findIndex((c) => c.epoch >= cutoff);
    const slice = cs.slice(cutIdx);
    const r = await runStrategyOn(s, slice);
    const row = summarize(s, r.trades, slice);
    const wr = row.trades ? `${(100*row.wins/row.trades).toFixed(0)}%` : "—";
    const sa = row.asset.replace("fr", "").replace("cry", "").replace("USD", "");
    console.log(`  ${row.id.padEnd(14)} ${sa.padEnd(6)} ${row.tf.padEnd(4)} ${String(Math.round(row.days)).padStart(5)}d  ${String(row.trades).padStart(4)}t  WR ${wr.padStart(4)}  expR ${(row.expR>=0?"+":"")+row.expR.toFixed(2)+"R"}  ${(row.usd>=0?"+":"")+"$"+row.usd.toFixed(2)}`);
  }

  console.log(`\nSummary: 9 strategies / 3 assets · max-depth backtest with warm-up baked in.`);
  console.log(`Total trades: ${totalTrades} · combined annualized $/yr: ${(totalPerYear>=0?"+":"")+"$"+totalPerYear.toFixed(0)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

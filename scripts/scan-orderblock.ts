// Headless orderBlock-only scan across all real-history symbols.
// Bundled by esbuild and run with Node. Mirrors the in-app Backtest scan but
// runs as a CLI so we can iterate without touching the UI.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { SYMBOLS } from "../src/shared/symbols";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089"; // public app_id; sufficient for ticks_history
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const GRANULARITY = 3600; // 1h
const COUNT = 5000;
const SL_MULT = 1.0;
const TP_MULT = 2.0;
const COST_BPS = 2.0;
const STAKE_USD = 50;
const MULTIPLIER = 30;

function tradeUsd(pnlPct: number, stake: number, mult: number): number {
  const ret = Math.max(-1, pnlPct * mult);
  return stake * ret;
}

class Client {
  ws: WebSocket;
  reqId = 1;
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
      } catch (e) { /* ignore */ }
    });
  }
  send(payload: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${JSON.stringify(payload).slice(0, 80)}`));
        }
      }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function fetchCandlesPaged(c: Client, symbol: string, granularity: number, count: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
  let collected: Candle[] = [];
  while (collected.length < count) {
    const want = Math.min(CHUNK, count - collected.length);
    const r = await c.send({
      ticks_history: symbol,
      adjust_start_time: 1,
      count: want,
      end: cursor,
      style: "candles",
      granularity,
    });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const chunk: Candle[] = raw.map((c) => ({ epoch: c.epoch, open: +c.open, high: +c.high, low: +c.low, close: +c.close }));
    collected = chunk.concat(collected);
    cursor = String(chunk[0].epoch - 1);
    if (chunk.length < want) break;
  }
  // Dedupe by epoch
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const cd of collected) {
    if (seen.has(cd.epoch)) continue;
    seen.add(cd.epoch);
    out.push(cd);
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

async function main() {
  const realSymbols = SYMBOLS.filter((s) => s.group !== "Synthetic");
  const c = new Client();
  await c.ready;
  console.log(`[scan] connected · scanning ${realSymbols.length} symbols · ${COUNT} bars × ${GRANULARITY / 60}m · OB only`);

  // Detectors: orderBlock only.
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
  }));

  type Row = {
    symbol: string;
    label: string;
    group: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    expectancyR: number;
    pnlPct: number;
    pnlUsd: number;
    barsFetched: number;
  };
  const rows: Row[] = [];

  for (const def of realSymbols) {
    process.stdout.write(`  [${def.code.padEnd(10)}] ${def.label.padEnd(20)} fetching… `);
    let candles: Candle[] = [];
    try {
      candles = await fetchCandlesPaged(c, def.code, GRANULARITY, COUNT);
    } catch (e) {
      console.log(`SKIP (${(e as Error).message})`);
      continue;
    }
    if (candles.length < 100) {
      console.log(`SKIP (only ${candles.length} bars)`);
      continue;
    }
    const r = await runBacktest({
      symbol: def.code,
      granularity: GRANULARITY as any,
      count: candles.length,
      atrSlMult: SL_MULT,
      atrTpMult: TP_MULT,
      costBps: COST_BPS,
      detectors,
      strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
    }, candles);
    const wins = r.trades.filter((t) => t.pnlPct > 0).length;
    const losses = r.trades.length - wins;
    let totalR = 0;
    let pnlUsd = 0;
    for (const t of r.trades) {
      const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
      if (risk > 0) totalR += t.pnlPct / risk;
      pnlUsd += tradeUsd(t.pnlPct, STAKE_USD, MULTIPLIER);
    }
    const expectancyR = r.trades.length > 0 ? totalR / r.trades.length : 0;
    rows.push({
      symbol: def.code,
      label: def.label,
      group: def.group,
      trades: r.trades.length,
      wins,
      losses,
      winRate: r.trades.length > 0 ? wins / r.trades.length : 0,
      expectancyR,
      pnlPct: r.stats.totalPnlPct,
      pnlUsd,
      barsFetched: candles.length,
    });
    console.log(`OK · ${candles.length} bars · ${r.trades.length} trades · ${wins}W/${losses}L · exp ${expectancyR.toFixed(2)}R · ${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`);
  }

  c.close();

  // Sort by expectancy R (the meaningful metric), then by trades (sample size).
  rows.sort((a, b) => b.expectancyR - a.expectancyR || b.trades - a.trades);

  console.log("\n=== ORDERBLOCK-ONLY SCAN — sorted by Expectancy R ===");
  console.log("Symbol".padEnd(22) + "Group".padEnd(12) + "Bars".padStart(7) + "Trades".padStart(8) + "Wins".padStart(7) + "Loss".padStart(7) + "WR%".padStart(7) + "Exp R".padStart(9) + "P&L %".padStart(9) + "P&L $".padStart(11));
  for (const r of rows) {
    console.log(
      r.label.padEnd(22) +
      r.group.padEnd(12) +
      String(r.barsFetched).padStart(7) +
      String(r.trades).padStart(8) +
      String(r.wins).padStart(7) +
      String(r.losses).padStart(7) +
      (r.trades ? `${(r.winRate * 100).toFixed(0)}%` : "—").padStart(7) +
      `${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R`.padStart(9) +
      `${(r.pnlPct * 100).toFixed(2)}%`.padStart(9) +
      `${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`.padStart(11),
    );
  }

  // Group aggregates.
  const byGroup: Record<string, { trades: number; wins: number; pnlUsd: number; symbols: number; avgExpR: number; expRSum: number }> = {};
  for (const r of rows) {
    const g = byGroup[r.group] ??= { trades: 0, wins: 0, pnlUsd: 0, symbols: 0, avgExpR: 0, expRSum: 0 };
    g.trades += r.trades;
    g.wins += r.wins;
    g.pnlUsd += r.pnlUsd;
    g.symbols += 1;
    g.expRSum += r.expectancyR;
  }
  console.log("\n=== BY GROUP ===");
  for (const [g, s] of Object.entries(byGroup)) {
    const wr = s.trades ? (s.wins / s.trades) * 100 : 0;
    const avgExp = s.symbols ? s.expRSum / s.symbols : 0;
    console.log(`${g.padEnd(12)} symbols=${s.symbols} trades=${s.trades} wins=${s.wins} wr=${wr.toFixed(0)}% avgExpR=${avgExp >= 0 ? "+" : ""}${avgExp.toFixed(2)} pnl=${s.pnlUsd >= 0 ? "+" : ""}$${s.pnlUsd.toFixed(2)}`);
  }

  // Verdict counters.
  const totalTrades = rows.reduce((s, r) => s + r.trades, 0);
  const totalWins = rows.reduce((s, r) => s + r.wins, 0);
  const totalUsd = rows.reduce((s, r) => s + r.pnlUsd, 0);
  console.log(`\n=== TOTAL ===`);
  console.log(`symbols tested: ${rows.length} · trades: ${totalTrades} · wins: ${totalWins} (${totalTrades ? (100*totalWins/totalTrades).toFixed(0) : 0}%) · combined P&L: ${totalUsd >= 0 ? "+" : ""}$${totalUsd.toFixed(2)}`);
}

main().catch((e) => { console.error("[scan] failed:", e); process.exit(1); });

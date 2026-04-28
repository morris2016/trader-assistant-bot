// Warm-up test: does feeding the detectors prior history change outcomes
// vs a cold start from day 1 of trading?
//
// Setup: fetch 2000 1h ETH candles (~83 days). Pick a 30-day window starting
// at bar index 1500 (so we have ~62d of prior history available).
// Compare:
//   - COLD: run backtest on candles[1500..1500+30d] — detector state empty.
//   - WARM-200:  run on candles[1300..1500+30d], filter trades to start_epoch+. (200-bar warm-up)
//   - WARM-500:  run on candles[1000..1500+30d], filter trades to start_epoch+. (500-bar warm-up)
//   - WARM-FULL: run on candles[0..1500+30d], filter trades to start_epoch+.
//
// Expected if warm-up matters: more trades fire in warm runs (detectors have OBs/FVGs
// in their pool already on day 1), and $ outcomes differ.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { ethSweep } from "../src/main/engine/strategies/eth-sweep";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30;

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

function summary(name: string, trades: BacktestTrade[], cs: Candle[], windowStartEpoch: number): { n: number; w: number; r: number; usd: number } {
  const inWin = trades.filter((t) => cs[t.openedAtIndex].epoch >= windowStartEpoch);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, usd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    usd += tradeUsd(t);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  console.log(`  ${name.padEnd(26)} trades=${String(inWin.length).padStart(3)}  WR ${(inWin.length ? 100*wins/inWin.length : 0).toFixed(0)}%  expR ${(expR >= 0 ? "+" : "") + expR.toFixed(2)}R  ${(usd >= 0 ? "+" : "") + "$" + usd.toFixed(2)}`);
  return { n: inWin.length, w: wins, r: expR, usd };
}

async function main() {
  const c = new C(); await c.ready;
  console.log("[warmup-test] ETH 1h, eth_sweep strategy");
  console.log("Fetching 2000 ETH 1h bars (~83d)...");
  const all = await fetchPaged(c, "cryETHUSD", 3600, 2000);
  c.close();
  console.log(`fetched ${all.length} bars\n`);

  // Pick a 30-day window starting at index ~1500 (so ~62d of prior history available)
  const WINDOW_DAYS = 30;
  const WINDOW_BARS = WINDOW_DAYS * 24;
  const windowEndIdx = all.length - 1;
  const windowStartIdx = Math.max(0, windowEndIdx - WINDOW_BARS);
  const windowStartEpoch = all[windowStartIdx].epoch;
  const windowEndEpoch = all[windowEndIdx].epoch;

  console.log(`Window: bars ${windowStartIdx}..${windowEndIdx} (${WINDOW_DAYS}d)`);
  console.log(`        ${new Date(windowStartEpoch * 1000).toISOString().slice(0,10)} → ${new Date(windowEndEpoch * 1000).toISOString().slice(0,10)}`);
  console.log(`Strategy: ${ethSweep.id} (${ethSweep.name})\n`);

  const variants: { name: string; warmupBars: number }[] = [
    { name: "COLD (no history)",    warmupBars: 0 },
    { name: "WARM-200 (~8d prior)", warmupBars: 200 },
    { name: "WARM-500 (~21d prior)",warmupBars: 500 },
    { name: "WARM-1000 (~42d prior)",warmupBars: 1000 },
    { name: "WARM-FULL (all history)",warmupBars: windowStartIdx },
  ];

  console.log(`Variant                    Trades  WR    expR    P&L $`);
  console.log(`${"─".repeat(70)}`);
  const results: any[] = [];
  for (const v of variants) {
    const startIdx = Math.max(0, windowStartIdx - v.warmupBars);
    const slice = all.slice(startIdx);
    const r = await runStrategyOn(ethSweep, slice);
    const s = summary(v.name, r.trades, slice, windowStartEpoch);
    results.push({ ...v, ...s });
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`Comparison vs COLD baseline:`);
  const base = results[0];
  for (let i = 1; i < results.length; i++) {
    const r = results[i];
    const dn = r.n - base.n;
    const du = r.usd - base.usd;
    console.log(`  ${r.name.padEnd(28)} Δtrades ${(dn >= 0 ? "+" : "") + dn}  Δ$ ${(du >= 0 ? "+" : "") + "$" + du.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

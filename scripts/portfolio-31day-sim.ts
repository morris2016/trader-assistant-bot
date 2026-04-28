// Portfolio account simulation: $400 start, 31 days, all 6 validated strategies
// running concurrently on Silver + ETH. Walks balance trade-by-trade.
// Tracks equity curve, drawdown, exit triggers (40% DD, bust at <$50).

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverSweep } from "../src/main/engine/strategies/silver-sweep";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import { ethOb } from "../src/main/engine/strategies/eth-ob";
import { ethSweep } from "../src/main/engine/strategies/eth-sweep";
import { ethFvg } from "../src/main/engine/strategies/eth-fvg";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 30;
const START_BALANCE = 500;
const DAYS = 43;
const MIN_BAL_TO_TRADE = STAKE;
const EXIT_DD_PCT = 0.50;

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

async function runStrategy(s: StrategyDescriptor, candles: Candle[]) {
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

async function main() {
  const c = new C(); await c.ready;
  console.log(`Fetching market data for portfolio sim...`);
  const c15Silver = await fetchPaged(c, "frxXAGUSD", 900, 5500);
  const c60Silver = await fetchPaged(c, "frxXAGUSD", 3600, 1400);
  const c60Eth = await fetchPaged(c, "cryETHUSD", 3600, 1400);
  c.close();

  console.log(`Silver 15m: ${c15Silver.length} bars`);
  console.log(`Silver 1h:  ${c60Silver.length} bars`);
  console.log(`ETH 1h:     ${c60Eth.length} bars\n`);

  const TOP_N = Number(process.env.TOP_N ?? 6);
  console.log(`Running TOP ${TOP_N} strategies (ranked by 43d/$50 contribution)...`);
  const r1 = await runStrategy(silverFvg,   c60Silver);     // #1 S-FVG
  const r2 = await runStrategy(silverSweep, c60Silver);     // #2 S-SW
  const r3 = await runStrategy(silverOb,    c15Silver);     // #3 S-OB
  const r4 = await runStrategy(ethSweep,    c60Eth);        // #4 E-SW
  const r5 = TOP_N >= 5 ? await runStrategy(ethOb,  c60Eth) : null;
  const r6 = TOP_N >= 6 ? await runStrategy(ethFvg, c60Eth) : null;
  console.log(`Done.\n`);

  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[]; asset: string };
  const all: Tagged[] = [];
  if (TOP_N >= 1) all.push(...r1.trades.map((t) => ({ t, tag: "S-FVG", cs: c60Silver, asset: "Silver" })));
  if (TOP_N >= 2) all.push(...r2.trades.map((t) => ({ t, tag: "S-SW ", cs: c60Silver, asset: "Silver" })));
  if (TOP_N >= 3) all.push(...r3.trades.map((t) => ({ t, tag: "S-OB ", cs: c15Silver, asset: "Silver" })));
  if (TOP_N >= 4) all.push(...r4.trades.map((t) => ({ t, tag: "E-SW ", cs: c60Eth,    asset: "ETH" })));
  if (r5) all.push(...r5.trades.map((t) => ({ t, tag: "E-OB ", cs: c60Eth, asset: "ETH" })));
  if (r6) all.push(...r6.trades.map((t) => ({ t, tag: "E-FVG", cs: c60Eth, asset: "ETH" })));

  // Find the 31-day window — last DAYS days from the most recent epoch we have.
  const lastEpoch = Math.max(
    c15Silver[c15Silver.length - 1].epoch,
    c60Silver[c60Silver.length - 1].epoch,
    c60Eth[c60Eth.length - 1].epoch,
  );
  const windowStart = lastEpoch - DAYS * 86400;
  const inWindow = all.filter((x) => {
    const e = x.cs[x.t.openedAtIndex].epoch;
    return e >= windowStart;
  });
  inWindow.sort((a, b) => a.cs[a.t.openedAtIndex].epoch - b.cs[b.t.openedAtIndex].epoch);

  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PORTFOLIO ACCOUNT SIMULATION`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Starting balance: $${START_BALANCE} · Stake $${STAKE} × ${MULT}× MULT`);
  console.log(`Period: ${DAYS} days · ${new Date(windowStart * 1000).toISOString().slice(0,10)} → ${new Date(lastEpoch * 1000).toISOString().slice(0,10)}`);
  console.log(`Strategies (TOP ${TOP_N}): ranked S-FVG, S-SW, S-OB, E-SW, E-OB, E-FVG`);
  console.log(`Exit triggers: −${(EXIT_DD_PCT*100).toFixed(0)}% DD from peak; bust at < $${MIN_BAL_TO_TRADE}\n`);
  console.log(`Total signals fired in window: ${inWindow.length}\n`);

  let balance = START_BALANCE;
  let peak = START_BALANCE;
  let busted = false;
  let exited = false;
  let exitHit: { trade: number; bal: number; date: string } | null = null;
  let bustHit: { trade: number; bal: number; date: string } | null = null;
  let tradesTaken = 0;
  let wins = 0;
  let maxDrawdownPct = 0;

  // Per-strategy stats
  const perStrat: Record<string, { trades: number; wins: number; usd: number }> = {};

  // Daily and weekly buckets
  const dailyPnl: Record<string, number> = {};
  const dailyTrades: Record<string, number> = {};

  console.log(`${"#".padStart(3)}  ${"date".padEnd(18)} ${"strat".padEnd(5)} ${"side".padEnd(4)} ${"R".padStart(7)} ${"$".padStart(8)}  ${"balance".padStart(9)} ${"peak".padStart(8)} ${"DD".padStart(5)}`);
  for (let i = 0; i < inWindow.length; i++) {
    const x = inWindow[i];
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (busted) {
      console.log(`${"-".padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)}        skipped (busted)`);
      continue;
    }
    if (exited) continue;
    if (balance < MIN_BAL_TO_TRADE) continue;

    const usd = tradeUsd(x.t);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;
    if (balance > peak) peak = balance;
    const ddPct = peak > 0 ? ((balance - peak) / peak) * 100 : 0;
    if (Math.abs(ddPct) > Math.abs(maxDrawdownPct)) maxDrawdownPct = ddPct;
    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();

    // per-strat
    perStrat[x.tag.trim()] = perStrat[x.tag.trim()] ?? { trades: 0, wins: 0, usd: 0 };
    perStrat[x.tag.trim()].trades++;
    if (usd > 0) perStrat[x.tag.trim()].wins++;
    perStrat[x.tag.trim()].usd += usd;

    // daily
    const day = opened.slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] ?? 0) + usd;
    dailyTrades[day] = (dailyTrades[day] ?? 0) + 1;

    let flag = "";
    if (!exitHit && ddPct <= -EXIT_DD_PCT * 100) {
      exitHit = { trade: i + 1, bal: balance, date: opened };
      exited = true;
      flag = `  ← −${(EXIT_DD_PCT*100).toFixed(0)}% DD EXIT`;
    }
    if (balance < MIN_BAL_TO_TRADE && !bustHit) {
      bustHit = { trade: i + 1, bal: balance, date: opened };
      busted = true;
      flag = `  ← ACCOUNT BUST`;
    }

    const sign = usd >= 0 ? "+" : "";
    console.log(
      `${String(i + 1).padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${sign}$${usd.toFixed(2).padStart(6)}  $${balance.toFixed(2).padStart(7)} $${peak.toFixed(2).padStart(6)} ${ddPct.toFixed(0).padStart(3)}%${flag}`,
    );
  }

  // Daily summary
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`DAILY P&L (only days with trades)`);
  const days = Object.keys(dailyPnl).sort();
  let cum = 0;
  for (const d of days) {
    cum += dailyPnl[d];
    const t = dailyTrades[d];
    const sign = dailyPnl[d] >= 0 ? "+" : "";
    console.log(`  ${d}  ${t}t  ${sign}$${dailyPnl[d].toFixed(2).padStart(7)}  cum $${cum.toFixed(2).padStart(8)}`);
  }

  // Per-strategy summary
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-STRATEGY CONTRIBUTION`);
  console.log(`  ${"Strategy".padEnd(8)}  ${"Trades".padStart(6)}  ${"Wins".padStart(5)}  ${"WR".padStart(4)}  ${"Total $".padStart(9)}`);
  for (const [s, v] of Object.entries(perStrat).sort((a, b) => b[1].usd - a[1].usd)) {
    const wr = v.trades ? `${(100*v.wins/v.trades).toFixed(0)}%` : "—";
    console.log(`  ${s.padEnd(8)}  ${String(v.trades).padStart(6)}  ${String(v.wins).padStart(5)}  ${wr.padStart(4)}  ${(v.usd >= 0 ? "+" : "") + "$" + v.usd.toFixed(2).padStart(8)}`);
  }

  // Final result
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SIMULATION RESULT (${DAYS} days, $${START_BALANCE} starting balance)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Final balance:      $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak balance:       $${peak.toFixed(2)}  (+$${(peak - START_BALANCE).toFixed(2)} · +${(((peak - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Worst real DD:      ${maxDrawdownPct.toFixed(1)}% from peak`);
  console.log(`  Trades taken:       ${tradesTaken} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken ? (100*wins/tradesTaken).toFixed(0) : 0}%)`);
  console.log(``);
  console.log(`  Exit at −${(EXIT_DD_PCT*100).toFixed(0)}% DD: ${exitHit ? `trade #${exitHit.trade} on ${exitHit.date} (balance $${exitHit.bal.toFixed(2)})` : "✗ never reached — held through"}`);
  console.log(`  Account bust:       ${bustHit ? `trade #${bustHit.trade}` : "✗ never reached"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

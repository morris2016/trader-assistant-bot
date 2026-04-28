// Adaptive position-sizing across all 9 validated strategies.
// Min stake $50, max pct of balance configurable via MAX_PCT env (default 10%),
// scaled by validated expR / 0.73R (Silver-FVG = 100% confidence).

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
const MIN_STAKE = 50;
const MAX_STAKE_PCT = Number(process.env.MAX_PCT ?? 0.10);
const MAX_EXPR_NORM = 0.73;
const MULT = 30;
const START_BALANCE = 500;
const DAYS = 365;
const MIN_BAL_TO_TRADE = MIN_STAKE;
const EXIT_DD_PCT = 0.50;

function adaptiveStake(balance: number, expR: number): number {
  const conf = Math.max(0, Math.min(1, expR / MAX_EXPR_NORM));
  const sized = balance * MAX_STAKE_PCT * conf;
  return Math.max(MIN_STAKE, sized);
}

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

function tradeUsdAtStake(t: BacktestTrade, stake: number): number {
  return stake * Math.max(-1, t.pnlPct * MULT);
}

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
  console.log(`Fetching market data for 9-strategy adaptive sim...`);
  const c15Silver = await fetchPaged(c, "frxXAGUSD", 900, 8000);
  const c60Silver = await fetchPaged(c, "frxXAGUSD", 3600, 6000);
  const c60Eth    = await fetchPaged(c, "cryETHUSD", 3600, 8000);
  const c60Gold   = await fetchPaged(c, "frxXAUUSD", 3600, 6000);
  c.close();
  console.log(`Silver 15m=${c15Silver.length}b · Silver 1h=${c60Silver.length}b · ETH 1h=${c60Eth.length}b · Gold 1h=${c60Gold.length}b\n`);

  console.log(`Running 9 strategies...`);
  const r1 = await runStrategy(silverOb,    c15Silver);
  const r2 = await runStrategy(silverSweep, c60Silver);
  const r3 = await runStrategy(silverFvg,   c60Silver);
  const r4 = await runStrategy(ethOb,       c60Eth);
  const r5 = await runStrategy(ethSweep,    c60Eth);
  const r6 = await runStrategy(ethFvg,      c60Eth);
  const r7 = await runStrategy(goldOb,      c60Gold);
  const r8 = await runStrategy(goldSweep,   c60Gold);
  const r9 = await runStrategy(goldFvg,     c60Gold);
  console.log(`Done.\n`);

  const expRByTag: Record<string, number> = {
    "S-OB ": silverOb.validation?.expectancyR ?? 0.49,
    "S-SW ": silverSweep.validation?.expectancyR ?? 0.54,
    "S-FVG": silverFvg.validation?.expectancyR ?? 0.73,
    "E-OB ": ethOb.validation?.expectancyR ?? 0.51,
    "E-SW ": ethSweep.validation?.expectancyR ?? 0.37,
    "E-FVG": ethFvg.validation?.expectancyR ?? 0.13,
    "G-OB ": goldOb.validation?.expectancyR ?? 0.69,
    "G-SW ": goldSweep.validation?.expectancyR ?? 0.69,
    "G-FVG": goldFvg.validation?.expectancyR ?? 0.69,
  };

  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[]; asset: string };
  const all: Tagged[] = [
    ...r1.trades.map((t) => ({ t, tag: "S-OB ", cs: c15Silver, asset: "Silver" })),
    ...r2.trades.map((t) => ({ t, tag: "S-SW ", cs: c60Silver, asset: "Silver" })),
    ...r3.trades.map((t) => ({ t, tag: "S-FVG", cs: c60Silver, asset: "Silver" })),
    ...r4.trades.map((t) => ({ t, tag: "E-OB ", cs: c60Eth,    asset: "ETH" })),
    ...r5.trades.map((t) => ({ t, tag: "E-SW ", cs: c60Eth,    asset: "ETH" })),
    ...r6.trades.map((t) => ({ t, tag: "E-FVG", cs: c60Eth,    asset: "ETH" })),
    ...r7.trades.map((t) => ({ t, tag: "G-OB ", cs: c60Gold,   asset: "Gold" })),
    ...r8.trades.map((t) => ({ t, tag: "G-SW ", cs: c60Gold,   asset: "Gold" })),
    ...r9.trades.map((t) => ({ t, tag: "G-FVG", cs: c60Gold,   asset: "Gold" })),
  ];

  const lastEpoch = Math.max(
    c15Silver[c15Silver.length - 1].epoch,
    c60Silver[c60Silver.length - 1].epoch,
    c60Eth[c60Eth.length - 1].epoch,
    c60Gold[c60Gold.length - 1].epoch,
  );
  const windowStart = lastEpoch - DAYS * 86400;
  const inWindow = all.filter((x) => x.cs[x.t.openedAtIndex].epoch >= windowStart);
  inWindow.sort((a, b) => a.cs[a.t.openedAtIndex].epoch - b.cs[b.t.openedAtIndex].epoch);

  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`9-STRATEGY ADAPTIVE PORTFOLIO SIM`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Start: $${START_BALANCE} · Adaptive (min $${MIN_STAKE}, max ${(MAX_STAKE_PCT*100).toFixed(0)}% of balance × expR/${MAX_EXPR_NORM}R) · ${MULT}× MULT`);
  console.log(`Period: ${DAYS}d (or available history) · ${new Date(windowStart * 1000).toISOString().slice(0,10)} → ${new Date(lastEpoch * 1000).toISOString().slice(0,10)}`);
  console.log(`Confidence map (% of max position):`);
  for (const [tag, expR] of Object.entries(expRByTag)) {
    console.log(`  ${tag.trim().padEnd(6)} expR=${expR.toFixed(2)}R → ${(expR/MAX_EXPR_NORM*100).toFixed(0)}% of cap (${(MAX_STAKE_PCT*expR/MAX_EXPR_NORM*100).toFixed(1)}% of balance)`);
  }
  console.log(`Exit triggers: −${(EXIT_DD_PCT*100).toFixed(0)}% DD; bust at <$${MIN_BAL_TO_TRADE}\n`);
  console.log(`Total signals fired in window: ${inWindow.length}\n`);

  let balance = START_BALANCE, peak = START_BALANCE;
  let busted = false, exited = false;
  let exitHit: { trade: number; bal: number; date: string } | null = null;
  let bustHit: { trade: number; bal: number; date: string } | null = null;
  let tradesTaken = 0, wins = 0, maxDD = 0;
  const perStrat: Record<string, { trades: number; wins: number; usd: number }> = {};
  const dailyPnl: Record<string, number> = {};
  const dailyTrades: Record<string, number> = {};

  for (let i = 0; i < inWindow.length; i++) {
    const x = inWindow[i];
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (busted || exited) continue;
    if (balance < MIN_BAL_TO_TRADE) continue;

    const stake = adaptiveStake(balance, expRByTag[x.tag] ?? 0.5);
    const usd = tradeUsdAtStake(x.t, stake);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;
    if (balance > peak) peak = balance;
    const ddPct = peak > 0 ? ((balance - peak) / peak) * 100 : 0;
    if (Math.abs(ddPct) > Math.abs(maxDD)) maxDD = ddPct;

    perStrat[x.tag.trim()] = perStrat[x.tag.trim()] ?? { trades: 0, wins: 0, usd: 0 };
    perStrat[x.tag.trim()].trades++;
    if (usd > 0) perStrat[x.tag.trim()].wins++;
    perStrat[x.tag.trim()].usd += usd;

    const day = opened.slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] ?? 0) + usd;
    dailyTrades[day] = (dailyTrades[day] ?? 0) + 1;

    if (!exitHit && ddPct <= -EXIT_DD_PCT * 100) {
      exitHit = { trade: i + 1, bal: balance, date: opened };
      exited = true;
    }
    if (balance < MIN_BAL_TO_TRADE && !bustHit) {
      bustHit = { trade: i + 1, bal: balance, date: opened };
      busted = true;
    }
  }

  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-STRATEGY CONTRIBUTION`);
  console.log(`  ${"Strat".padEnd(7)} ${"Trades".padStart(6)} ${"Wins".padStart(5)} ${"WR".padStart(4)} ${"$".padStart(11)}`);
  for (const [s, v] of Object.entries(perStrat).sort((a, b) => b[1].usd - a[1].usd)) {
    const wr = v.trades ? `${(100*v.wins/v.trades).toFixed(0)}%` : "—";
    console.log(`  ${s.padEnd(7)} ${String(v.trades).padStart(6)} ${String(v.wins).padStart(5)} ${wr.padStart(4)} ${(v.usd >= 0 ? "+" : "") + "$" + v.usd.toFixed(2).padStart(9)}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SIM RESULT (${DAYS}d cap, $${START_BALANCE} start, MAX_PCT=${(MAX_STAKE_PCT*100).toFixed(0)}%)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  Final balance:  $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak balance:   $${peak.toFixed(2)}  (+$${(peak - START_BALANCE).toFixed(2)} · +${(((peak - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Worst DD:       ${maxDD.toFixed(1)}%`);
  console.log(`  Trades taken:   ${tradesTaken}/${inWindow.length} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken ? (100*wins/tradesTaken).toFixed(0) : 0}%)`);
  console.log(``);
  console.log(`  Exit at −${(EXIT_DD_PCT*100).toFixed(0)}% DD: ${exitHit ? `trade #${exitHit.trade} on ${exitHit.date} ($${exitHit.bal.toFixed(2)})` : "✗ never reached"}`);
  console.log(`  Account bust:   ${bustHit ? `trade #${bustHit.trade}` : "✗ never reached"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

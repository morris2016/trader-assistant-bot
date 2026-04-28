// Portfolio simulation: $300 start, bot opens Feb 26, 2026, runs through Apr 27.
// 6 surviving strategies (5 STRONG + 1 WEAK gold_sweep), adaptive sizing:
//   stake = max($60, balance × 25% × confidence)
//   confidence = validated expR / 0.73R (clamped 0..1)
// All signals draw from the same balance; trades chain chronologically.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import { goldOb } from "../src/main/engine/strategies/gold-ob";
import { goldSweep } from "../src/main/engine/strategies/gold-sweep";
import { goldFvg } from "../src/main/engine/strategies/gold-fvg";
import { platFvg } from "../src/main/engine/strategies/plat-fvg";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const MIN_STAKE = 60;
const MAX_STAKE_PCT = 0.25;
const MAX_EXPR_NORM = 0.73;
const MULT = 30;
const START_BALANCE = 300;
const MIN_BAL_TO_TRADE = MIN_STAKE;
const WINDOW_START = Math.floor(new Date('2026-02-26T00:00:00Z').getTime() / 1000);

function adaptiveStake(balance: number, expR: number): number {
  const conf = Math.max(0, Math.min(1, expR / MAX_EXPR_NORM));
  const sized = balance * MAX_STAKE_PCT * conf;
  return Math.max(MIN_STAKE, sized);
}

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, any>();
  ready: Promise<void>;
  constructor() { this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); const id = m.req_id;
      if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(p: any): Promise<any> { const id = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id })); setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
  close() { this.ws.close(); } }

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(5000, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

function tradeUsdAtStake(t: BacktestTrade, stake: number): number {
  return stake * Math.max(-1, t.pnlPct * MULT);
}

async function runStrategy(s: StrategyDescriptor, candles: Candle[]) {
  const sd = s as Sd;
  return runBacktest({
    symbol: s.symbols[0], granularity: s.granularity as any, count: candles.length,
    atrSlMult: s.atrSlMult, atrTpMult: s.atrTpMult, costBps: s.costBps,
    maxAdx: sd.maxAdx, minAdx: sd.minAdx,
    withTrendOnlyAboveAdx: sd.withTrendOnlyAboveAdx,
    skipDaysOfWeekUtc: sd.skipDaysOfWeekUtc,
    buyOnly: sd.buyOnly, sellOnly: sd.sellOnly,
    detectors: s.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Fetching market data for $300 / Feb 26, 2026 sim...`);
  const c15Silver = await fetchPaged(c, "frxXAGUSD", 900, 8000);
  const c60Silver = await fetchPaged(c, "frxXAGUSD", 3600, 4000);
  const c60Gold   = await fetchPaged(c, "frxXAUUSD", 3600, 4000);
  const c60Plat   = await fetchPaged(c, "frxXPTUSD", 3600, 4000);
  c.close();
  console.log(`Silver 15m=${c15Silver.length} · Silver 1h=${c60Silver.length} · Gold 1h=${c60Gold.length} · Plat 1h=${c60Plat.length}\n`);

  console.log(`Running 6 strategies...`);
  const r1 = await runStrategy(silverOb, c15Silver);
  const r2 = await runStrategy(silverFvg, c60Silver);
  const r3 = await runStrategy(goldOb, c60Gold);
  const r4 = await runStrategy(goldSweep, c60Gold);
  const r5 = await runStrategy(goldFvg, c60Gold);
  const r6 = await runStrategy(platFvg, c60Plat);
  console.log(`Done.\n`);

  const expRByTag: Record<string, number> = {
    "S-OB ": silverOb.validation?.expectancyR ?? 0.49,
    "S-FVG": silverFvg.validation?.expectancyR ?? 0.73,
    "G-OB ": goldOb.validation?.expectancyR ?? 0.69,
    "G-SW ": goldSweep.validation?.expectancyR ?? 0.05,
    "G-FVG": goldFvg.validation?.expectancyR ?? 0.69,
    "P-FVG": platFvg.validation?.expectancyR ?? 0.71,
  };

  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[]; asset: string };
  const all: Tagged[] = [
    ...r1.trades.map((t) => ({ t, tag: "S-OB ", cs: c15Silver, asset: "Silver" })),
    ...r2.trades.map((t) => ({ t, tag: "S-FVG", cs: c60Silver, asset: "Silver" })),
    ...r3.trades.map((t) => ({ t, tag: "G-OB ", cs: c60Gold, asset: "Gold" })),
    ...r4.trades.map((t) => ({ t, tag: "G-SW ", cs: c60Gold, asset: "Gold" })),
    ...r5.trades.map((t) => ({ t, tag: "G-FVG", cs: c60Gold, asset: "Gold" })),
    ...r6.trades.map((t) => ({ t, tag: "P-FVG", cs: c60Plat, asset: "Platinum" })),
  ];

  const lastEpoch = Math.max(c15Silver[c15Silver.length-1].epoch, c60Silver[c60Silver.length-1].epoch, c60Gold[c60Gold.length-1].epoch, c60Plat[c60Plat.length-1].epoch);
  const inWindow = all.filter((x) => x.cs[x.t.openedAtIndex].epoch >= WINDOW_START);
  inWindow.sort((a, b) => a.cs[a.t.openedAtIndex].epoch - b.cs[b.t.openedAtIndex].epoch);

  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PORTFOLIO SIM: $${START_BALANCE} start, Feb 26 2026 → today (~${Math.round((lastEpoch - WINDOW_START)/86400)}d)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Stake: max($${MIN_STAKE}, balance × ${(MAX_STAKE_PCT*100).toFixed(0)}% × conf) where conf = expR/${MAX_EXPR_NORM}R · ${MULT}× MULT`);
  console.log(`Confidence by strategy:`);
  for (const [tag, expR] of Object.entries(expRByTag)) {
    const conf = Math.min(1, expR / MAX_EXPR_NORM);
    console.log(`  ${tag.trim().padEnd(6)} expR=${expR.toFixed(2)}R → conf ${(conf*100).toFixed(0)}% (max stake at $${START_BALANCE} = $${(START_BALANCE*MAX_STAKE_PCT*conf).toFixed(0)})`);
  }
  console.log(`Total signals fired in window: ${inWindow.length}\n`);

  let balance = START_BALANCE, peak = START_BALANCE, busted = false;
  let tradesTaken = 0, wins = 0, maxDD = 0;
  const perStrat: Record<string, { trades: number; wins: number; usd: number }> = {};
  const dailyPnl: Record<string, number> = {};

  console.log(`${"#".padStart(3)}  ${"date".padEnd(18)} ${"strat".padEnd(5)} ${"side".padEnd(4)} ${"stake".padStart(6)} ${"R".padStart(7)} ${"$".padStart(8)}  ${"balance".padStart(9)} ${"peak".padStart(9)} ${"DD".padStart(5)}`);
  for (let i = 0; i < inWindow.length; i++) {
    const x = inWindow[i];
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    if (busted || balance < MIN_BAL_TO_TRADE) {
      console.log(`${"-".padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)}        skipped (busted)`);
      continue;
    }
    const stake = adaptiveStake(balance, expRByTag[x.tag] ?? 0.5);
    const usd = tradeUsdAtStake(x.t, stake);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;
    if (balance > peak) peak = balance;
    const ddPct = peak > 0 ? ((balance - peak) / peak) * 100 : 0;
    if (Math.abs(ddPct) > Math.abs(maxDD)) maxDD = ddPct;
    if (balance < MIN_BAL_TO_TRADE) busted = true;

    perStrat[x.tag.trim()] = perStrat[x.tag.trim()] ?? { trades: 0, wins: 0, usd: 0 };
    perStrat[x.tag.trim()].trades++;
    if (usd > 0) perStrat[x.tag.trim()].wins++;
    perStrat[x.tag.trim()].usd += usd;
    const day = opened.slice(0, 10);
    dailyPnl[day] = (dailyPnl[day] ?? 0) + usd;

    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();
    const sign = usd >= 0 ? "+" : "";
    console.log(
      `${String(i + 1).padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} $${stake.toFixed(0).padStart(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${sign}$${usd.toFixed(2).padStart(7)}  $${balance.toFixed(2).padStart(8)} $${peak.toFixed(2).padStart(8)} ${ddPct.toFixed(0).padStart(3)}%${busted ? "  ← BUST" : ""}`,
    );
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`DAILY P&L`);
  let cum = 0;
  for (const d of Object.keys(dailyPnl).sort()) { cum += dailyPnl[d];
    console.log(`  ${d}  ${dailyPnl[d] >= 0 ? "+" : ""}$${dailyPnl[d].toFixed(2).padStart(7)}  cum $${cum.toFixed(2).padStart(8)}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-STRATEGY CONTRIBUTION`);
  for (const [s, v] of Object.entries(perStrat).sort((a, b) => b[1].usd - a[1].usd)) {
    const wr = v.trades ? `${(100*v.wins/v.trades).toFixed(0)}%` : "—";
    console.log(`  ${s.padEnd(7)}  ${String(v.trades).padStart(3)}t  ${String(v.wins).padStart(3)}W  ${wr.padStart(4)}  ${v.usd >= 0 ? "+" : ""}$${v.usd.toFixed(2).padStart(8)}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`FINAL RESULT`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  const days = Math.round((lastEpoch - WINDOW_START) / 86400);
  console.log(`  Period:        Feb 26, 2026 → ${new Date(lastEpoch * 1000).toISOString().slice(0,10)} (${days}d)`);
  console.log(`  Final:         $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak:          $${peak.toFixed(2)}  (+$${(peak - START_BALANCE).toFixed(2)} · +${(((peak - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Worst DD:      ${maxDD.toFixed(1)}%`);
  console.log(`  Trades taken:  ${tradesTaken}/${inWindow.length} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken ? (100*wins/tradesTaken).toFixed(0) : 0}%)`);
  console.log(`  Account bust:  ${busted ? "YES" : "no"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

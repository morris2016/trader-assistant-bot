// Recent forward-test: $200 start, bot opens 2026-04-27 12:00 UTC, runs through now.
// 6 currently-registered strategies (silver_ob/fvg, gold_ob/fvg, plat_fvg, pall_sweep).
// Stake: max($40, balance × 15% × confidence) where confidence = expR / 0.73R

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import { goldOb } from "../src/main/engine/strategies/gold-ob";
import { goldFvg } from "../src/main/engine/strategies/gold-fvg";
import { platFvg } from "../src/main/engine/strategies/plat-fvg";
import { pallSweep } from "../src/main/engine/strategies/pall-sweep";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
// Real-account constraints
const MIN_STAKE = 40;                // base stake $40
const MAX_STAKE_PCT = 0.15;          // 15% max
const HARD_STAKE_CAP = 2500;
const MAX_EXPR_NORM = 0.73;
const MULT = 30;
const START_BALANCE = 200;           // $200 start
const MIN_BAL_TO_TRADE = MIN_STAKE;
const EXIT_DD_PCT = 0.50;            // close shop at −50% DD from peak
const DAILY_LOSS_CAP_PCT = 0.25;     // stop for the day if daily loss ≥ 25% of day-start balance
const WINDOW_START = Math.floor(new Date('2026-03-21T20:00:00Z').getTime() / 1000); // March 21 20:00 UTC
const WINDOW_END   = Math.floor(new Date('2026-03-24T15:00:00Z').getTime() / 1000); // March 24 15:00 UTC

function adaptiveStake(balance: number, expR: number): number {
  const conf = Math.max(0, Math.min(1, expR / MAX_EXPR_NORM));
  const sized = balance * MAX_STAKE_PCT * conf;
  const stake = Math.max(MIN_STAKE, sized);
  return Math.min(stake, HARD_STAKE_CAP);  // hard cap at $2,500
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
  console.log(`Fetching market data for $200 / 2026-04-27 12:00 → now sim...`);
  const c15Silver = await fetchPaged(c, "frxXAGUSD", 900, 8000);
  const c60Silver = await fetchPaged(c, "frxXAGUSD", 3600, 4000);
  const c60Gold   = await fetchPaged(c, "frxXAUUSD", 3600, 4000);
  const c60Plat   = await fetchPaged(c, "frxXPTUSD", 3600, 4000);
  const c60Pall   = await fetchPaged(c, "frxXPDUSD", 3600, 4000);
  c.close();
  console.log(`Silver 15m=${c15Silver.length} · Silver 1h=${c60Silver.length} · Gold 1h=${c60Gold.length} · Plat 1h=${c60Plat.length} · Pall 1h=${c60Pall.length}\n`);

  console.log(`Running 6 strategies...`);
  const r1 = await runStrategy(silverOb, c15Silver);
  const r2 = await runStrategy(silverFvg, c60Silver);
  const r3 = await runStrategy(goldOb, c60Gold);
  const r5 = await runStrategy(goldFvg, c60Gold);
  const r6 = await runStrategy(platFvg, c60Plat);
  const r7 = await runStrategy(pallSweep, c60Pall);
  console.log(`Done.\n`);

  const expRByTag: Record<string, number> = {
    "S-OB ": silverOb.validation?.expectancyR ?? 0.49,
    "S-FVG": silverFvg.validation?.expectancyR ?? 0.73,
    "G-OB ": goldOb.validation?.expectancyR ?? 0.69,
    "G-FVG": goldFvg.validation?.expectancyR ?? 0.69,
    "P-FVG": platFvg.validation?.expectancyR ?? 0.71,
    "Pa-SW": pallSweep.validation?.expectancyR ?? 0.30,
  };

  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[]; asset: string };
  const all: Tagged[] = [
    ...r1.trades.map((t) => ({ t, tag: "S-OB ", cs: c15Silver, asset: "Silver" })),
    ...r2.trades.map((t) => ({ t, tag: "S-FVG", cs: c60Silver, asset: "Silver" })),
    ...r3.trades.map((t) => ({ t, tag: "G-OB ", cs: c60Gold, asset: "Gold" })),
    ...r5.trades.map((t) => ({ t, tag: "G-FVG", cs: c60Gold, asset: "Gold" })),
    ...r6.trades.map((t) => ({ t, tag: "P-FVG", cs: c60Plat, asset: "Platinum" })),
    ...r7.trades.map((t) => ({ t, tag: "Pa-SW", cs: c60Pall, asset: "Palladium" })),
  ];

  const lastEpoch = Math.max(c15Silver[c15Silver.length-1].epoch, c60Silver[c60Silver.length-1].epoch, c60Gold[c60Gold.length-1].epoch, c60Plat[c60Plat.length-1].epoch, c60Pall[c60Pall.length-1].epoch);
  const inWindow = all.filter((x) => {
    const e = x.cs[x.t.openedAtIndex].epoch;
    return e >= WINDOW_START && e <= WINDOW_END;
  });
  inWindow.sort((a, b) => a.cs[a.t.openedAtIndex].epoch - b.cs[b.t.openedAtIndex].epoch);

  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PORTFOLIO SIM: $${START_BALANCE} start, ${new Date(WINDOW_START * 1000).toISOString().slice(0,16)} UTC → ${new Date(WINDOW_END * 1000).toISOString().slice(0,16)} UTC (~${((WINDOW_END - WINDOW_START)/3600).toFixed(1)}h)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`Stake: max($${MIN_STAKE}, balance × ${(MAX_STAKE_PCT*100).toFixed(0)}% × conf) where conf = expR/${MAX_EXPR_NORM}R · ${MULT}× MULT`);
  console.log(`Confidence by strategy:`);
  for (const [tag, expR] of Object.entries(expRByTag)) {
    const conf = Math.min(1, expR / MAX_EXPR_NORM);
    console.log(`  ${tag.trim().padEnd(6)} expR=${expR.toFixed(2)}R → conf ${(conf*100).toFixed(0)}% (max stake at $${START_BALANCE} = $${(START_BALANCE*MAX_STAKE_PCT*conf).toFixed(0)})`);
  }
  console.log(`Total signals fired in window: ${inWindow.length}\n`);

  let balance = START_BALANCE, peak = START_BALANCE, busted = false, exited = false;
  let exitHit: { trade: number; bal: number; date: string } | null = null;
  let bustHit: { trade: number; bal: number; date: string } | null = null;
  let tradesTaken = 0, wins = 0, maxDD = 0;
  const perStrat: Record<string, { trades: number; wins: number; usd: number }> = {};
  const dailyPnl: Record<string, number> = {};
  // Daily loss-cap tracking
  let currentDay = ""; let dayStartBalance = balance; let dayCapped = false; let dayCappedSkips = 0;

  console.log(`MAX_PCT=${(MAX_STAKE_PCT*100).toFixed(0)}% · Hard stake cap $${HARD_STAKE_CAP} · Exit at −${(EXIT_DD_PCT*100).toFixed(0)}% DD · Daily loss cap ${(DAILY_LOSS_CAP_PCT*100).toFixed(0)}%/day · Bust at <$${MIN_BAL_TO_TRADE}\n`);
  console.log(`${"#".padStart(3)}  ${"date".padEnd(18)} ${"strat".padEnd(5)} ${"side".padEnd(4)} ${"stake".padStart(6)} ${"R".padStart(7)} ${"$".padStart(8)}  ${"balance".padStart(9)} ${"peak".padStart(9)} ${"DD".padStart(5)}`);
  for (let i = 0; i < inWindow.length; i++) {
    const x = inWindow[i];
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    const day = opened.slice(0, 10);
    // Day rollover: reset daily tracking at UTC day boundary
    if (day !== currentDay) {
      currentDay = day;
      dayStartBalance = balance;
      dayCapped = false;
    }
    if (busted || exited || balance < MIN_BAL_TO_TRADE) continue;
    if (dayCapped) { dayCappedSkips++; continue; }
    const stake = adaptiveStake(balance, expRByTag[x.tag] ?? 0.5);
    const usd = tradeUsdAtStake(x.t, stake);
    balance += usd;
    if (usd > 0) wins++;
    tradesTaken++;
    if (balance > peak) peak = balance;
    const ddPct = peak > 0 ? ((balance - peak) / peak) * 100 : 0;
    if (Math.abs(ddPct) > Math.abs(maxDD)) maxDD = ddPct;

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
    // Daily loss-cap check (only if not already busted/exited)
    if (!busted && !exited) {
      const dayLossPct = (dayStartBalance - balance) / dayStartBalance;
      if (dayLossPct >= DAILY_LOSS_CAP_PCT && !dayCapped) {
        dayCapped = true;
        flag = `  ← DAILY −${(DAILY_LOSS_CAP_PCT*100).toFixed(0)}% CAP HIT (paused for day)`;
      }
    }

    perStrat[x.tag.trim()] = perStrat[x.tag.trim()] ?? { trades: 0, wins: 0, usd: 0 };
    perStrat[x.tag.trim()].trades++;
    if (usd > 0) perStrat[x.tag.trim()].wins++;
    perStrat[x.tag.trim()].usd += usd;
    dailyPnl[day] = (dailyPnl[day] ?? 0) + usd;

    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();
    const sign = usd >= 0 ? "+" : "";
    console.log(
      `${String(i + 1).padStart(3)}  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} $${stake.toFixed(0).padStart(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${sign}$${usd.toFixed(2).padStart(7)}  $${balance.toFixed(2).padStart(8)} $${peak.toFixed(2).padStart(8)} ${ddPct.toFixed(0).padStart(3)}%${flag}`,
    );
  }
  const skipped = inWindow.length - tradesTaken;

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
  console.log(`  Period:        ${new Date(WINDOW_START * 1000).toISOString().slice(0,16)} UTC → ${new Date(WINDOW_END * 1000).toISOString().slice(0,16)} UTC (${((WINDOW_END - WINDOW_START)/3600).toFixed(1)}h)`);
  console.log(`  Final:         $${balance.toFixed(2)}  (${balance >= START_BALANCE ? "+" : ""}$${(balance - START_BALANCE).toFixed(2)} · ${(((balance - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Peak:          $${peak.toFixed(2)}  (+$${(peak - START_BALANCE).toFixed(2)} · +${(((peak - START_BALANCE) / START_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`  Worst DD:      ${maxDD.toFixed(1)}%`);
  console.log(`  Trades taken:  ${tradesTaken}/${inWindow.length} (${wins}W / ${tradesTaken - wins}L · WR ${tradesTaken ? (100*wins/tradesTaken).toFixed(0) : 0}%)`);
  console.log(`  Skipped:       ${skipped} signals (${dayCappedSkips} from daily cap, ${skipped - dayCappedSkips} from exit/bust)`);
  console.log(``);
  console.log(`  −${(EXIT_DD_PCT*100).toFixed(0)}% DD exit: ${exitHit ? `trade #${exitHit.trade} on ${exitHit.date} (balance $${exitHit.bal.toFixed(2)})` : "✗ never reached — held through"}`);
  console.log(`  Account bust:  ${bustHit ? `trade #${bustHit.trade} (balance $${bustHit.bal.toFixed(2)})` : "✗ never reached"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

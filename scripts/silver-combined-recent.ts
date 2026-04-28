// Replay both validated Silver strategies (OB + Sweep) over the last 10
// trading days and report Sweep-alone, OB-alone, and Combined per-day P&L.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverSweep } from "../src/main/engine/strategies/silver-sweep";
import type { Candle, BacktestTrade } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const STAKE = 50;
const MULT = 30;
const DAYS = 90;

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

async function fetchCandles(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
  let collected: Candle[] = [];
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
  for (const cd of collected) if (!seen.has(cd.epoch)) { seen.add(cd.epoch); out.push(cd); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

function tradeUsd(t: BacktestTrade): number {
  return STAKE * Math.max(-1, t.pnlPct * MULT);
}
function tradeR(t: BacktestTrade): number {
  const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
  return risk > 0 ? t.pnlPct / risk : 0;
}

/** ISO Monday-of-week as a YYYY-MM-DD string. Groups Mon-Fri into one bucket. */
function mondayOfWeek(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  const day = d.getUTCDay(); // 0 (Sun) – 6 (Sat)
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const c = new C(); await c.ready;
  // OB needs 15m × ~10d + warmup. Sweep needs 1h × ~10d + warmup.
  // Fetch generously to span weekends.
  const c15 = await fetchCandles(c, SYMBOL, 900, 9500);   // 15m × ~99d
  const c60 = await fetchCandles(c, SYMBOL, 3600, 2500);  // 1h × ~104d
  c.close();

  // Day buckets — find last DAYS distinct trading days using 15m data (more granular).
  const byDay15: Record<string, number[]> = {};
  for (let i = 0; i < c15.length; i++) {
    const day = new Date(c15[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay15[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay15)
    .filter(([, idx]) => idx.length >= 60)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const lastN = fullDays.slice(-DAYS);
  if (lastN.length === 0) { console.log("no full trading days"); return; }

  console.log(`Silver — combined replay · last ${lastN.length} trading days`);
  console.log(`OB:    15m / OB-only / ADX<22 / structural stops / 3:1 R:R / 5 bps · $${STAKE} × ${MULT}× MULT`);
  console.log(`Sweep: 1h  / Sweep-only / ICT-style / withTrend@ADX20 / structural stops / 3:1 R:R / 5 bps\n`);

  // Run both strategies once over the entire window.
  const obResult = await runBacktest({
    symbol: SYMBOL, granularity: 900 as any, count: c15.length,
    atrSlMult: silverOb.atrSlMult, atrTpMult: silverOb.atrTpMult, costBps: silverOb.costBps,
    maxAdx: silverOb.maxAdx,
    detectors: silverOb.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, c15);

  const swResult = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: c60.length,
    atrSlMult: silverSweep.atrSlMult, atrTpMult: silverSweep.atrTpMult, costBps: silverSweep.costBps,
    withTrendOnlyAboveAdx: silverSweep.withTrendOnlyAboveAdx,
    detectors: silverSweep.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, c60);

  // Per-day bucketing, by candle epoch.
  type DayRow = {
    day: string;
    obTrades: BacktestTrade[];
    swTrades: BacktestTrade[];
  };
  const dayRows: DayRow[] = lastN.map(([day, idx15]) => {
    const start = c15[idx15[0]].epoch;
    const end = c15[idx15[idx15.length - 1]].epoch;
    return {
      day,
      obTrades: obResult.trades.filter((t) => {
        const e = c15[t.openedAtIndex].epoch;
        return e >= start && e <= end;
      }),
      swTrades: swResult.trades.filter((t) => {
        const e = c60[t.openedAtIndex].epoch;
        return e >= start && e <= end;
      }),
    };
  });

  // Header
  const fmt = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
  console.log(`${"Day (UTC)".padEnd(12)} ${"Sweep $".padStart(10)} ${"Sweep n".padStart(8)}    ${"OB $".padStart(10)} ${"OB n".padStart(6)}    ${"Combined $".padStart(12)} ${"Combined n".padStart(11)}`);
  console.log("─".repeat(86));

  let cumSwUsd = 0, cumObUsd = 0;
  let cumSwTrades = 0, cumObTrades = 0;
  let cumSwWins = 0, cumObWins = 0;
  let allObTrades: BacktestTrade[] = [];
  let allSwTrades: BacktestTrade[] = [];

  // Group day rows by Monday-of-week.
  const weeklyBuckets: Array<{ weekStart: string; rows: typeof dayRows }> = [];
  let curWeek: string | null = null;
  for (const row of dayRows) {
    const wk = mondayOfWeek(row.day);
    if (wk !== curWeek) {
      weeklyBuckets.push({ weekStart: wk, rows: [] });
      curWeek = wk;
    }
    weeklyBuckets[weeklyBuckets.length - 1].rows.push(row);
  }

  type WeekStat = { weekStart: string; sw: number; ob: number; total: number; trades: number; wins: number };
  const weeklyStats: WeekStat[] = [];
  type MonthStat = { ym: string; sw: number; ob: number; total: number; trades: number; wins: number };
  const monthlyStats: MonthStat[] = [];

  for (const wk of weeklyBuckets) {
    let weekSwUsd = 0, weekObUsd = 0;
    let weekSwTrades = 0, weekObTrades = 0;
    let weekSwWins = 0, weekObWins = 0;
    let flatDays = 0;

    for (const row of wk.rows) {
      const swUsd = row.swTrades.reduce((s, t) => s + tradeUsd(t), 0);
      const obUsd = row.obTrades.reduce((s, t) => s + tradeUsd(t), 0);
      const swWins = row.swTrades.filter((t) => t.pnlPct > 0).length;
      const obWins = row.obTrades.filter((t) => t.pnlPct > 0).length;

      weekSwUsd += swUsd; weekObUsd += obUsd;
      weekSwTrades += row.swTrades.length; weekObTrades += row.obTrades.length;
      weekSwWins += swWins; weekObWins += obWins;

      cumSwUsd += swUsd; cumObUsd += obUsd;
      cumSwTrades += row.swTrades.length; cumObTrades += row.obTrades.length;
      cumSwWins += swWins; cumObWins += obWins;
      allObTrades.push(...row.obTrades); allSwTrades.push(...row.swTrades);

      // Add to monthly bucket
      const ym = row.day.slice(0, 7);
      let mb = monthlyStats.find((m) => m.ym === ym);
      if (!mb) { mb = { ym, sw: 0, ob: 0, total: 0, trades: 0, wins: 0 }; monthlyStats.push(mb); }
      mb.sw += swUsd; mb.ob += obUsd; mb.total += swUsd + obUsd;
      mb.trades += row.swTrades.length + row.obTrades.length;
      mb.wins += swWins + obWins;

      // Skip rows with no trades to keep output compact at 90 days.
      if (row.swTrades.length === 0 && row.obTrades.length === 0) {
        flatDays++;
        continue;
      }
      const swStr = row.swTrades.length > 0 ? `${fmt(swUsd).padStart(10)}` : "         —";
      const obStr = row.obTrades.length > 0 ? `${fmt(obUsd).padStart(10)}` : "         —";
      const totalStr = `${fmt(swUsd + obUsd).padStart(12)}`;
      console.log(
        `${row.day.padEnd(12)} ${swStr} ${String(`(${swWins}/${row.swTrades.length})`).padStart(8)}    ${obStr} ${String(`(${obWins}/${row.obTrades.length})`).padStart(6)}    ${totalStr} ${String(`(${swWins + obWins}/${row.swTrades.length + row.obTrades.length})`).padStart(11)}`,
      );
    }

    if (flatDays > 0) console.log(`(+ ${flatDays} flat day${flatDays === 1 ? "" : "s"} this week — no fires)`);

    const weekTotal = weekSwUsd + weekObUsd;
    const weekTrades = weekSwTrades + weekObTrades;
    const weekWins = weekSwWins + weekObWins;
    weeklyStats.push({ weekStart: wk.weekStart, sw: weekSwUsd, ob: weekObUsd, total: weekTotal, trades: weekTrades, wins: weekWins });
    console.log(
      `Week ${wk.weekStart} ${fmt(weekSwUsd).padStart(10)} ${String(`(${weekSwWins}/${weekSwTrades})`).padStart(8)}    ${fmt(weekObUsd).padStart(10)} ${String(`(${weekObWins}/${weekObTrades})`).padStart(6)}    ${fmt(weekTotal).padStart(12)} ${String(`(${weekWins}/${weekTrades})`).padStart(11)}`,
    );
    console.log("·".repeat(86));
  }

  // Monthly + weekly summary blocks.
  console.log(`\nMONTHLY SUMMARY`);
  console.log(`  ${"Month".padEnd(10)} ${"Sweep $".padStart(10)} ${"OB $".padStart(10)} ${"Combined $".padStart(12)} ${"Trades".padStart(8)} ${"WR".padStart(5)}`);
  for (const m of monthlyStats) {
    console.log(`  ${m.ym.padEnd(10)} ${fmt(m.sw).padStart(10)} ${fmt(m.ob).padStart(10)} ${fmt(m.total).padStart(12)} ${String(m.trades).padStart(8)} ${m.trades ? `${(100*m.wins/m.trades).toFixed(0)}%`.padStart(5) : "  —".padStart(5)}`);
  }

  // Equity curve highlights.
  const winningWeeks = weeklyStats.filter((w) => w.total > 0).length;
  const losingWeeks = weeklyStats.filter((w) => w.total < 0).length;
  const flatWeeks = weeklyStats.filter((w) => w.total === 0).length;
  const bestWeek = weeklyStats.reduce((b, w) => w.total > b.total ? w : b, weeklyStats[0]);
  const worstWeek = weeklyStats.reduce((b, w) => w.total < b.total ? w : b, weeklyStats[0]);
  console.log(`\nWEEKLY SUMMARY`);
  console.log(`  ${weeklyStats.length} weeks · ${winningWeeks} winning · ${losingWeeks} losing · ${flatWeeks} flat (no trades)`);
  console.log(`  Hit rate: ${weeklyStats.length ? (100*winningWeeks/weeklyStats.length).toFixed(0) : 0}%`);
  console.log(`  Best week:  ${bestWeek.weekStart}  ${fmt(bestWeek.total)} (${bestWeek.wins}/${bestWeek.trades})`);
  console.log(`  Worst week: ${worstWeek.weekStart}  ${fmt(worstWeek.total)} (${worstWeek.wins}/${worstWeek.trades})`);

  // Equity curve cumulative
  console.log(`\nEQUITY CURVE (cumulative $ by week-end)`);
  let running = 0;
  for (const w of weeklyStats) {
    running += w.total;
    const bar = Math.min(60, Math.max(0, Math.round((running + 200) / 10)));
    console.log(`  ${w.weekStart}  ${fmt(running).padStart(10)}   ${"█".repeat(bar)}`);
  }

  // Summary block
  const totalCombinedUsd = cumSwUsd + cumObUsd;
  const totalCombinedTrades = cumSwTrades + cumObTrades;
  const totalCombinedWins = cumSwWins + cumObWins;
  console.log(`\n${lastN.length}-DAY TOTALS`);
  console.log(`  Sweep alone:    ${fmt(cumSwUsd)}   ${cumSwTrades} trades  ${cumSwWins}W/${cumSwTrades - cumSwWins}L  WR ${cumSwTrades ? (100*cumSwWins/cumSwTrades).toFixed(0) : 0}%`);
  console.log(`  OB alone:       ${fmt(cumObUsd)}   ${cumObTrades} trades  ${cumObWins}W/${cumObTrades - cumObWins}L  WR ${cumObTrades ? (100*cumObWins/cumObTrades).toFixed(0) : 0}%`);
  console.log(`  Combined:       ${fmt(totalCombinedUsd)}   ${totalCombinedTrades} trades  ${totalCombinedWins}W/${totalCombinedTrades - totalCombinedWins}L  WR ${totalCombinedTrades ? (100*totalCombinedWins/totalCombinedTrades).toFixed(0) : 0}%`);

  // Top winners + worst losers
  function printExtremes(label: string, trades: BacktestTrade[], cs: Candle[]) {
    if (trades.length === 0) return;
    const sorted = [...trades].sort((a, b) => tradeUsd(b) - tradeUsd(a));
    const N = Math.min(5, trades.length);
    console.log(`\n— ${label} top ${N} winners —`);
    for (const t of sorted.slice(0, N)) {
      const opened = new Date(cs[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(`  ${opened.padEnd(18)} ${t.side.padEnd(4)} ${(tradeR(t) >= 0 ? "+" : "") + tradeR(t).toFixed(2) + "R"} ${fmt(tradeUsd(t))} ${t.exitReason}`);
    }
    console.log(`— ${label} worst ${N} losers —`);
    for (const t of sorted.slice(-N).reverse()) {
      const opened = new Date(cs[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(`  ${opened.padEnd(18)} ${t.side.padEnd(4)} ${(tradeR(t) >= 0 ? "+" : "") + tradeR(t).toFixed(2) + "R"} ${fmt(tradeUsd(t))} ${t.exitReason}`);
    }
  }
  printExtremes("Sweep", allSwTrades, c60);
  printExtremes("OB", allObTrades, c15);
}

main().catch((e) => { console.error(e); process.exit(1); });

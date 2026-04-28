// Replay all 3 validated Silver strategies over the last 7 trading days.
// Reports six views: FVG / Sweep / OB / FVG+OB / FVG+Sweep / FVG+OB+Sweep.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { silverOb } from "../src/main/engine/strategies/silver-ob";
import { silverSweep } from "../src/main/engine/strategies/silver-sweep";
import { silverFvg } from "../src/main/engine/strategies/silver-fvg";
import type { Candle, BacktestTrade } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "frxXAGUSD";
const STAKE = 50;
const MULT = 30;
const DAYS = 365;

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

function tradeUsd(t: BacktestTrade): number { return STAKE * Math.max(-1, t.pnlPct * MULT); }

async function main() {
  const c = new C(); await c.ready;
  // OB needs 15m; FVG and Sweep both 1h. 12-month attempt — request way more
  // than we expect Deriv to deliver. Pagination stops when history exhausts.
  const c15 = await fetchCandles(c, SYMBOL, 900, 50000);
  const c60 = await fetchCandles(c, SYMBOL, 3600, 12000);
  c.close();

  // Bucket trading days from 1h data — has deeper history than 15m on Deriv.
  // OB days outside the 15m window will simply show 0 trades.
  const byDay60: Record<string, number[]> = {};
  for (let i = 0; i < c60.length; i++) {
    const day = new Date(c60[i].epoch * 1000).toISOString().slice(0, 10);
    (byDay60[day] ??= []).push(i);
  }
  const fullDays = Object.entries(byDay60).filter(([, idx]) => idx.length >= 18).sort((a, b) => a[0].localeCompare(b[0]));
  const lastN = fullDays.slice(-DAYS);

  // Compute earliest 15m epoch to flag OB-coverage days.
  const c15Start = c15.length > 0 ? c15[0].epoch : Number.MAX_SAFE_INTEGER;

  console.log(`Silver — 6-view replay · ${lastN.length} trading days (1h) · 15m fetched ${c15.length} bars (OB available from ${new Date(c15Start * 1000).toISOString().slice(0,10)})`);
  console.log(`Stake $${STAKE} × ${MULT}× MULT · cost 5 bps · structural stops`);
  console.log(`OB:    15m / OB-only / ADX<22 / 3:1 R:R`);
  console.log(`Sweep: 1h  / Sweep-only / ICT-style / withTrend@20 / 3:1 R:R`);
  console.log(`FVG:   1h  / FVG-only / minGap=0.7×ATR / edge / 3:1 R:R\n`);

  // Run each detector once.
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

  // Per-day bucketing — boundaries from 1h data.
  type DayRow = { day: string; ob: BacktestTrade[]; sw: BacktestTrade[]; fvg: BacktestTrade[] };
  const dayRows: DayRow[] = lastN.map(([day, idx60]) => {
    const start = c60[idx60[0]].epoch;
    const end = c60[idx60[idx60.length - 1]].epoch + 3600; // include the closing 1h bar window
    return {
      day,
      ob: obResult.trades.filter((t) => { const e = c15[t.openedAtIndex].epoch; return e >= start && e <= end; }),
      sw: swResult.trades.filter((t) => { const e = c60[t.openedAtIndex].epoch; return e >= start && e <= end; }),
      fvg: fvgResult.trades.filter((t) => { const e = c60[t.openedAtIndex].epoch; return e >= start && e <= end; }),
    };
  });

  const fmt = (v: number) => `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`;
  const cell = (trades: BacktestTrade[]) => {
    if (trades.length === 0) return "         —    ";
    const u = trades.reduce((s, t) => s + tradeUsd(t), 0);
    const w = trades.filter((t) => t.pnlPct > 0).length;
    return `${fmt(u).padStart(10)} (${w}/${trades.length})`;
  };

  // Monday-of-week helper for bucketing.
  function mondayOfWeek(yyyymmdd: string): string {
    const d = new Date(yyyymmdd + "T00:00:00Z");
    const day = d.getUTCDay();
    const offset = day === 0 ? -6 : 1 - day;
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  }

  console.log(`Day        ${"FVG".padStart(15)}    ${"Sweep".padStart(15)}    ${"OB".padStart(15)}    ${"FVG+OB".padStart(15)}    ${"FVG+Sweep".padStart(15)}    ${"All 3".padStart(15)}`);
  console.log("─".repeat(125));

  type Combo = { fvg: number; sw: number; ob: number; fvgOb: number; fvgSw: number; all: number;
                 fvgT: number; swT: number; obT: number; fvgObT: number; fvgSwT: number; allT: number;
                 fvgW: number; swW: number; obW: number; fvgObW: number; fvgSwW: number; allW: number };
  const blank = (): Combo => ({
    fvg: 0, sw: 0, ob: 0, fvgOb: 0, fvgSw: 0, all: 0,
    fvgT: 0, swT: 0, obT: 0, fvgObT: 0, fvgSwT: 0, allT: 0,
    fvgW: 0, swW: 0, obW: 0, fvgObW: 0, fvgSwW: 0, allW: 0,
  });
  const totals = blank();
  const weeklyMap = new Map<string, Combo>();
  const monthlyMap = new Map<string, Combo>();

  let curWeek: string | null = null;
  let weekFlat = 0;

  for (const row of dayRows) {
    const fvgUsd = row.fvg.reduce((s, t) => s + tradeUsd(t), 0);
    const swUsd = row.sw.reduce((s, t) => s + tradeUsd(t), 0);
    const obUsd = row.ob.reduce((s, t) => s + tradeUsd(t), 0);
    const fvgW = row.fvg.filter((t) => t.pnlPct > 0).length;
    const swW = row.sw.filter((t) => t.pnlPct > 0).length;
    const obW = row.ob.filter((t) => t.pnlPct > 0).length;

    const fvgOb = [...row.fvg, ...row.ob];
    const fvgSw = [...row.fvg, ...row.sw];
    const all = [...row.fvg, ...row.ob, ...row.sw];

    // Update totals + weekly + monthly.
    const wk = mondayOfWeek(row.day);
    if (wk !== curWeek) {
      if (curWeek !== null) {
        // Flush prior week.
        const wkBucket = weeklyMap.get(curWeek)!;
        if (weekFlat > 0) console.log(`(+ ${weekFlat} flat day${weekFlat === 1 ? "" : "s"})`);
        printWeekRow(curWeek, wkBucket);
        console.log("·".repeat(125));
        weekFlat = 0;
      }
      curWeek = wk;
      if (!weeklyMap.has(wk)) weeklyMap.set(wk, blank());
    }
    const ym = row.day.slice(0, 7);
    if (!monthlyMap.has(ym)) monthlyMap.set(ym, blank());

    const accumulators: Combo[] = [totals, weeklyMap.get(wk)!, monthlyMap.get(ym)!];
    for (const acc of accumulators) {
      acc.fvg += fvgUsd; acc.sw += swUsd; acc.ob += obUsd;
      acc.fvgOb += fvgUsd + obUsd; acc.fvgSw += fvgUsd + swUsd; acc.all += fvgUsd + swUsd + obUsd;
      acc.fvgT += row.fvg.length; acc.swT += row.sw.length; acc.obT += row.ob.length;
      acc.fvgObT += row.fvg.length + row.ob.length; acc.fvgSwT += row.fvg.length + row.sw.length;
      acc.allT += row.fvg.length + row.sw.length + row.ob.length;
      acc.fvgW += fvgW; acc.swW += swW; acc.obW += obW;
      acc.fvgObW += fvgW + obW; acc.fvgSwW += fvgW + swW;
      acc.allW += fvgW + swW + obW;
    }

    if (row.fvg.length === 0 && row.sw.length === 0 && row.ob.length === 0) {
      weekFlat++;
      continue; // skip flat days from per-day output
    }

    console.log(
      `${row.day}    ${cell(row.fvg)}  ${cell(row.sw)}  ${cell(row.ob)}  ${cell(fvgOb)}  ${cell(fvgSw)}  ${cell(all)}`,
    );
  }
  // Flush final week
  if (curWeek !== null) {
    const wkBucket = weeklyMap.get(curWeek)!;
    if (weekFlat > 0) console.log(`(+ ${weekFlat} flat day${weekFlat === 1 ? "" : "s"})`);
    printWeekRow(curWeek, wkBucket);
    console.log("─".repeat(125));
  }

  function printWeekRow(weekStart: string, b: Combo) {
    const c = (u: number, t: number, w: number) => t > 0 ? `${fmt(u).padStart(10)} (${w}/${t})` : "         —    ";
    console.log(
      `Week ${weekStart} ${c(b.fvg, b.fvgT, b.fvgW)}  ${c(b.sw, b.swT, b.swW)}  ${c(b.ob, b.obT, b.obW)}  ${c(b.fvgOb, b.fvgObT, b.fvgObW)}  ${c(b.fvgSw, b.fvgSwT, b.fvgSwW)}  ${c(b.all, b.allT, b.allW)}`,
    );
  }

  console.log(`\n${lastN.length}-DAY TOTALS`);
  const summarize = (label: string, usd: number, trades: number, wins: number) => {
    const wr = trades ? `${(100 * wins / trades).toFixed(0)}%` : "—";
    console.log(`  ${label.padEnd(20)}  ${fmt(usd).padStart(10)}   ${trades} trades  ${wins}W/${trades - wins}L  WR ${wr}`);
  };
  summarize("FVG alone:", totals.fvg, totals.fvgT, totals.fvgW);
  summarize("Sweep alone:", totals.sw, totals.swT, totals.swW);
  summarize("OB alone:", totals.ob, totals.obT, totals.obW);
  summarize("FVG + OB:", totals.fvgOb, totals.fvgObT, totals.fvgObW);
  summarize("FVG + Sweep:", totals.fvgSw, totals.fvgSwT, totals.fvgSwW);
  summarize("FVG + OB + Sweep:", totals.all, totals.allT, totals.allW);

  console.log(`\nMONTHLY SUMMARY (combined All-3)`);
  for (const [ym, m] of monthlyMap) {
    const wr = m.allT ? `${(100*m.allW/m.allT).toFixed(0)}%` : "—";
    console.log(`  ${ym}  ${fmt(m.all).padStart(10)}  ${m.allT} trades · WR ${wr}  ·  FVG ${fmt(m.fvg)} | Sweep ${fmt(m.sw)} | OB ${fmt(m.ob)}`);
  }

  console.log(`\nWEEKLY SUMMARY (combined All-3)`);
  let cumAll = 0;
  for (const [wk, b] of weeklyMap) {
    cumAll += b.all;
    const bar = Math.min(60, Math.max(0, Math.round((cumAll + 100) / 20)));
    const wr = b.allT ? `${(100*b.allW/b.allT).toFixed(0)}%` : "—";
    console.log(`  ${wk}  week ${fmt(b.all).padStart(10)}  cum ${fmt(cumAll).padStart(10)}  (${b.allT}t · WR ${wr})  ${"█".repeat(bar)}`);
  }

  // Top winners + losers (for context, replaces full tape).
  type Tagged = { t: BacktestTrade; tag: string; cs: Candle[] };
  const all: Tagged[] = [
    ...obResult.trades.map((t) => ({ t, tag: "OB ", cs: c15 })),
    ...swResult.trades.map((t) => ({ t, tag: "SW ", cs: c60 })),
    ...fvgResult.trades.map((t) => ({ t, tag: "FVG", cs: c60 })),
  ];
  const winStart = c60[lastN[0][1][0]].epoch;
  const winEnd = c60[lastN[lastN.length - 1][1][lastN[lastN.length - 1][1].length - 1]].epoch;
  const inWin = all.filter((x) => {
    const e = x.cs[x.t.openedAtIndex].epoch;
    return e >= winStart && e <= winEnd;
  });
  inWin.sort((a, b) => tradeUsd(b.t) - tradeUsd(a.t));
  console.log(`\n— TOP 5 WINNERS —`);
  for (const x of inWin.slice(0, 5)) {
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();
    console.log(`  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${fmt(tradeUsd(x.t))}`);
  }
  console.log(`\n— BOTTOM 5 LOSERS —`);
  for (const x of inWin.slice(-5).reverse()) {
    const opened = new Date(x.cs[x.t.openedAtIndex].epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    const r = (() => { const risk = Math.abs(x.t.entryPrice - x.t.stopPrice) / x.t.entryPrice; return risk > 0 ? x.t.pnlPct / risk : 0; })();
    console.log(`  ${opened.padEnd(18)} ${x.tag} ${x.t.side.padEnd(4)} ${(r >= 0 ? "+" : "") + r.toFixed(2) + "R"}  ${fmt(tradeUsd(x.t))}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

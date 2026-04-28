// ETH OB top-5 candidates × 30-day and 60-day forward replays.
// Goal: confirm which config is most robust on recent data; find tweaks.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "cryETHUSD";
const STAKE = 50;
const MULT = 30;
const COST_BPS = 5.0;

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

function basePs(over: Record<string, number> = {}): Record<string, number> {
  return {
    lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
    requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
    fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
    rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0,
    ...over,
  };
}

type Candidate = { name: string; params: Record<string, number>; filters: Partial<{ withTrendOnlyAboveAdx: number }> };
const CANDIDATES: Candidate[] = [
  { name: "with-trend@20 ce · 4:1 (saved winner)",  params: basePs({ entryDepth: 1, targetRMult: 4.0 }),  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 6:1 (highest expR)",     params: basePs({ targetRMult: 6.0 }),                  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 4:1",                    params: basePs({ targetRMult: 4.0 }),                  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 · 5:1",                    params: basePs({ targetRMult: 5.0 }),                  filters: { withTrendOnlyAboveAdx: 20 } },
  { name: "with-trend@20 ce · 3:1",                 params: basePs({ entryDepth: 1, targetRMult: 3.0 }),   filters: { withTrendOnlyAboveAdx: 20 } },
];

type Result = { candidate: string; trades: number; wins: number; expR: number; pnlUsd: number; tradesByWeek: Map<string, number>; pnlByWeek: Map<string, number> };

function tradeUsd(t: { pnlPct: number }): number { return STAKE * Math.max(-1, t.pnlPct * MULT); }

function mondayOfWeek(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + "T00:00:00Z");
  const day = d.getUTCDay();
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function runCandidateOnWindow(cand: Candidate, candles: Candle[], windowStartEpoch: number, windowEndEpoch: number): Promise<Result> {
  const detectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock" ? cand.params : d.params,
  }));
  const r = await runBacktest({
    symbol: SYMBOL, granularity: 3600 as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: cand.params.targetRMult ?? 3.0, costBps: COST_BPS,
    ...cand.filters,
    detectors, strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  const inWindow = r.trades.filter((t) => {
    const e = candles[t.openedAtIndex].epoch;
    return e >= windowStartEpoch && e < windowEndEpoch;
  });
  const wins = inWindow.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  const tradesByWeek = new Map<string, number>();
  const pnlByWeek = new Map<string, number>();
  for (const t of inWindow) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    const u = tradeUsd(t);
    pnlUsd += u;
    const day = new Date(candles[t.openedAtIndex].epoch * 1000).toISOString().slice(0, 10);
    const wk = mondayOfWeek(day);
    tradesByWeek.set(wk, (tradesByWeek.get(wk) ?? 0) + 1);
    pnlByWeek.set(wk, (pnlByWeek.get(wk) ?? 0) + u);
  }
  return {
    candidate: cand.name,
    trades: inWindow.length,
    wins,
    expR: inWindow.length ? totalR / inWindow.length : 0,
    pnlUsd, tradesByWeek, pnlByWeek,
  };
}

async function main() {
  const c = new C(); await c.ready;
  // Need 60 days × 24 + warmup = ~1500 bars. Fetch 2000 to be safe.
  const candles = await fetchPaged(c, SYMBOL, 3600, 2000);
  c.close();
  console.log(`[eth-ob-trials] fetched ${candles.length} 1h bars\n`);

  const lastEpoch = candles[candles.length - 1].epoch;
  const day = 86400;
  const win30Start = lastEpoch - 30 * day;
  const win60Start = lastEpoch - 60 * day;
  const winEnd = lastEpoch + 3600;

  console.log(`Window 30-day: ${new Date(win30Start * 1000).toISOString().slice(0,10)} → ${new Date(lastEpoch * 1000).toISOString().slice(0,10)}`);
  console.log(`Window 60-day: ${new Date(win60Start * 1000).toISOString().slice(0,10)} → ${new Date(lastEpoch * 1000).toISOString().slice(0,10)}\n`);

  // 30-day trial
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`30-DAY TRIAL`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${"candidate".padEnd(46)}  trades  WR    expR     P&L $     status`);
  const r30: Result[] = [];
  for (const c of CANDIDATES) {
    const r = await runCandidateOnWindow(c, candles, win30Start, winEnd);
    r30.push(r);
    const wr = r.trades ? `${(100*r.wins/r.trades).toFixed(0)}%` : "—";
    const status = r.pnlUsd > 0 ? "✓ green" : r.pnlUsd < -50 ? "✗ red" : "≈ flat";
    console.log(`  ${r.candidate.padEnd(46)}  ${String(r.trades).padStart(3)}    ${wr.padStart(3)}   ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R   ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}    ${status}`);
  }

  // 60-day trial
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`60-DAY TRIAL`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${"candidate".padEnd(46)}  trades  WR    expR     P&L $     status`);
  const r60: Result[] = [];
  for (const c of CANDIDATES) {
    const r = await runCandidateOnWindow(c, candles, win60Start, winEnd);
    r60.push(r);
    const wr = r.trades ? `${(100*r.wins/r.trades).toFixed(0)}%` : "—";
    const status = r.pnlUsd > 0 ? "✓ green" : r.pnlUsd < -50 ? "✗ red" : "≈ flat";
    console.log(`  ${r.candidate.padEnd(46)}  ${String(r.trades).padStart(3)}    ${wr.padStart(3)}   ${(r.expR >= 0 ? "+" : "") + r.expR.toFixed(2)}R   ${(r.pnlUsd >= 0 ? "+" : "") + "$" + r.pnlUsd.toFixed(2)}    ${status}`);
  }

  // Cross-window consistency check
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`CONSISTENCY CHECK — both windows positive?`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    const a = r30[i].pnlUsd;
    const b = r60[i].pnlUsd;
    const both = a > 0 && b > 0;
    const sign = both ? "✓" : "✗";
    const note = a > 0 && b > 0 ? "consistent winner"
               : a > 0 && b <= 0 ? "30d positive but 60d negative — overfit risk"
               : a <= 0 && b > 0 ? "60d positive but recent 30d negative — losing streak"
               : "both losing";
    console.log(`  ${sign} ${c.name.padEnd(46)}  30d:${(a >= 0 ? "+" : "") + "$" + a.toFixed(2).padStart(7)}  60d:${(b >= 0 ? "+" : "") + "$" + b.toFixed(2).padStart(7)}  → ${note}`);
  }

  // Weekly breakdown for the saved winner (track regime stability)
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════`);
  console.log(`WEEKLY BREAKDOWN — saved winner (with-trend@20 ce · 4:1) over 60-day window`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════`);
  const r = r60[0];
  const weeks = Array.from(r.pnlByWeek.keys()).sort();
  let cum = 0;
  for (const wk of weeks) {
    const p = r.pnlByWeek.get(wk) ?? 0;
    const t = r.tradesByWeek.get(wk) ?? 0;
    cum += p;
    const bar = Math.min(50, Math.max(0, Math.round(Math.abs(p) / 10)));
    const sym = p >= 0 ? "█" : "▒";
    console.log(`  ${wk}  ${(p >= 0 ? "+" : "") + "$" + p.toFixed(2).padStart(7)}  cum ${(cum >= 0 ? "+" : "") + "$" + cum.toFixed(2).padStart(7)}  ${t}t  ${sym.repeat(bar)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

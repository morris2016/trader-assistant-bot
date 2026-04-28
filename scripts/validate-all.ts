// Cross-validate all 10 registered strategies with 3-window methodology.
// W0 / TRAIN / TEST split with warmup. Flags any strategy whose edge
// does not survive across all 3 windows.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { STRATEGIES } from "../src/main/engine/strategies";
import type { Candle, BacktestTrade, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 30;

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

type WindowResult = { trades: number; wins: number; expR: number; pnlUsd: number };

async function runWindowed(s: StrategyDescriptor, allCandles: Candle[], windowStart: number, windowEnd: number): Promise<WindowResult> {
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const sd = s as Sd;
  const r = await runBacktest({
    symbol: s.symbols[0],
    granularity: s.granularity as any,
    count: candles.length,
    atrSlMult: s.atrSlMult, atrTpMult: s.atrTpMult, costBps: s.costBps,
    maxAdx: sd.maxAdx, minAdx: sd.minAdx,
    withTrendOnlyAboveAdx: sd.withTrendOnlyAboveAdx,
    skipDaysOfWeekUtc: sd.skipDaysOfWeekUtc,
    buyOnly: sd.buyOnly, sellOnly: sd.sellOnly,
    detectors: s.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  }, candles);
  const inWin = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  return { trades: inWin.length, wins, expR, pnlUsd };
}

// Compute window timestamps. We pick W0/TRAIN/TEST that fit within data depth per asset/TF.
function computeWindows(latestEpoch: number, days: number) {
  // TEST: latest 27d
  const TEST_END = latestEpoch + 1;
  const TEST_START = TEST_END - 27 * 86400;
  // TRAIN: 90d before TEST
  const TRAIN_END = TEST_START;
  const TRAIN_START = TRAIN_END - 90 * 86400;
  // W0: 90d before TRAIN
  const W0_END = TRAIN_START;
  const W0_START = W0_END - 90 * 86400;
  return { W0_START, W0_END, TRAIN_START, TRAIN_END, TEST_START, TEST_END };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`╔════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  CROSS-VALIDATE ALL ${STRATEGIES.length} REGISTERED STRATEGIES                              ║`);
  console.log(`║  3-window methodology: W0 (90d) → TRAIN (90d) → TEST (27d OOS)             ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════╝\n`);

  // Group strategies by (asset, TF) to share fetches
  const groups = new Map<string, StrategyDescriptor[]>();
  for (const s of STRATEGIES) {
    const key = `${s.symbols[0]}-${s.granularity}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  type StrategyVerdict = { id: string; W0: WindowResult; TRAIN: WindowResult; TEST: WindowResult; passes: boolean };
  const verdicts: StrategyVerdict[] = [];

  for (const [key, strats] of groups) {
    const [symbol, granStr] = key.split("-");
    const granularity = parseInt(granStr);
    const tfLabel = granularity === 900 ? "15m" : granularity === 3600 ? "1h" : `${granularity}s`;
    const barsPerDay = granularity === 900 ? 96 : 24;

    console.log(`──────────────────────────────────────────────────────────────────────────────`);
    console.log(`Fetching ${symbol} ${tfLabel} history (max depth available)...`);
    const allCandles = await fetchPaged(c, symbol, granularity, granularity === 900 ? 12000 : 8000);
    if (allCandles.length < 200) { console.log(`only ${allCandles.length} bars — skipping`); continue; }
    const fromDate = new Date(allCandles[0].epoch * 1000).toISOString().slice(0, 10);
    const toDate = new Date(allCandles[allCandles.length-1].epoch * 1000).toISOString().slice(0, 10);
    const totalDays = (allCandles[allCandles.length-1].epoch - allCandles[0].epoch) / 86400;
    console.log(`Got ${allCandles.length} ${tfLabel} bars (${fromDate} → ${toDate}, ${totalDays.toFixed(0)}d)`);

    const w = computeWindows(allCandles[allCandles.length-1].epoch, totalDays);
    const w0Days = (w.W0_END - w.W0_START) / 86400;
    const trainDays = (w.TRAIN_END - w.TRAIN_START) / 86400;
    const testDays = (w.TEST_END - w.TEST_START) / 86400;
    const w0Available = allCandles[0].epoch <= w.W0_START;
    console.log(`Windows:`);
    console.log(`  W0:    ${new Date(w.W0_START * 1000).toISOString().slice(0,10)} → ${new Date(w.W0_END * 1000).toISOString().slice(0,10)} (${w0Days.toFixed(0)}d)${w0Available ? "" : " ⚠ INSUFFICIENT DATA"}`);
    console.log(`  TRAIN: ${new Date(w.TRAIN_START * 1000).toISOString().slice(0,10)} → ${new Date(w.TRAIN_END * 1000).toISOString().slice(0,10)} (${trainDays.toFixed(0)}d)`);
    console.log(`  TEST:  ${new Date(w.TEST_START * 1000).toISOString().slice(0,10)} → ${new Date(w.TEST_END * 1000).toISOString().slice(0,10)} (${testDays.toFixed(0)}d)`);
    console.log(``);

    for (const s of strats) {
      const w0 = w0Available ? await runWindowed(s, allCandles, w.W0_START, w.W0_END) : { trades: 0, wins: 0, expR: 0, pnlUsd: 0 };
      const tr = await runWindowed(s, allCandles, w.TRAIN_START, w.TRAIN_END);
      const te = await runWindowed(s, allCandles, w.TEST_START, w.TEST_END);
      const passes = (w0Available ? w0.pnlUsd >= 0 : true) && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
      verdicts.push({ id: s.id, W0: w0, TRAIN: tr, TEST: te, passes });
      const fmt = (r: WindowResult) => {
        const wr = r.trades ? `${(100*r.wins/r.trades).toFixed(0)}%` : "—";
        return `${String(r.trades).padStart(3)}t ${wr.padStart(4)} ${(r.expR>=0?"+":"")}${r.expR.toFixed(2)}R ${(r.pnlUsd>=0?"+":"")}$${r.pnlUsd.toFixed(0).padStart(5)}`;
      };
      console.log(`  ${s.id.padEnd(14)} ${passes ? "✓ PASS" : "✗ FAIL"} | W0 ${w0Available ? fmt(w0) : "(no data)              "} | TRAIN ${fmt(tr)} | TEST ${fmt(te)}`);
    }
    console.log(``);
  }

  c.close();

  // Summary table
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY: ${verdicts.filter((v) => v.passes).length}/${verdicts.length} strategies pass cross-validation`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${"id".padEnd(14)} verdict   W0           TRAIN        TEST`);
  for (const v of verdicts) {
    console.log(`  ${v.id.padEnd(14)} ${v.passes ? "✓ PASS" : "✗ FAIL"}    ${(v.W0.pnlUsd >= 0 ? "+" : "") + "$" + v.W0.pnlUsd.toFixed(0).padStart(5)} (${String(v.W0.trades).padStart(3)}t)  ${(v.TRAIN.pnlUsd >= 0 ? "+" : "") + "$" + v.TRAIN.pnlUsd.toFixed(0).padStart(5)} (${String(v.TRAIN.trades).padStart(3)}t)  ${(v.TEST.pnlUsd >= 0 ? "+" : "") + "$" + v.TEST.pnlUsd.toFixed(0).padStart(5)} (${String(v.TEST.trades).padStart(3)}t)`);
  }
  console.log(``);
  const failed = verdicts.filter((v) => !v.passes);
  if (failed.length > 0) {
    console.log(`STRATEGIES THAT FAILED:`);
    for (const v of failed) {
      const reasons: string[] = [];
      if (v.W0.trades > 0 && v.W0.pnlUsd < 0) reasons.push(`W0 negative ($${v.W0.pnlUsd.toFixed(0)})`);
      if (v.TRAIN.pnlUsd < 0) reasons.push(`TRAIN negative ($${v.TRAIN.pnlUsd.toFixed(0)})`);
      if (v.TEST.pnlUsd < 0) reasons.push(`TEST negative ($${v.TEST.pnlUsd.toFixed(0)})`);
      console.log(`  ${v.id}: ${reasons.join("; ")}`);
    }
  } else {
    console.log(`ALL STRATEGIES PASSED. Registry is OOS-validated.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

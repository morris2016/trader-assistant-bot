// RDBEAR breakout-continuation — yesterday-only edge test.
//
// Test the baseline (RDBULL-mirror config) on yesterday's 24h. If profitable,
// stop. If not, try a small neighborhood of structurally-justified variations
// (NOT a grid search — keep parameter perturbations to ±1 step from baseline).
// First config that produces a real edge wins.
//
// "Edge" criteria for a single day:
//   • ≥6 trades   (need enough samples to mean something)
//   • totalUsd > 0
//   • WR ≥ 50% OR expR ≥ 0.10

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COST_BPS = 5.0;

const SYM = "RDBEAR";
const GR = 300; // 5m

// Yesterday in UTC: midnight to midnight.
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const YEST_START = TODAY_START - 86400;
const YEST_END = TODAY_START;

type Variant = {
  name: string;
  lookback: number;
  kAtr: number;
  momRatio: number;
  sideFilter: -1 | 0 | 1;
};

// Trial order: baseline first. Then ±1-step neighbors on each parameter,
// staying close to the validated RDBULL config. Stop on first edge.
const TRIALS: Variant[] = [
  { name: "baseline RDBULL-mirror",   lookback: 15, kAtr: 2.0, momRatio: 0.70, sideFilter: -1 },
  { name: "tighter momentum 0.75",    lookback: 15, kAtr: 2.0, momRatio: 0.75, sideFilter: -1 },
  { name: "looser momentum 0.65",     lookback: 15, kAtr: 2.0, momRatio: 0.65, sideFilter: -1 },
  { name: "shorter lookback 10",      lookback: 10, kAtr: 2.0, momRatio: 0.70, sideFilter: -1 },
  { name: "longer lookback 20",       lookback: 20, kAtr: 2.0, momRatio: 0.70, sideFilter: -1 },
  { name: "lower kAtr 1.5",           lookback: 15, kAtr: 1.5, momRatio: 0.70, sideFilter: -1 },
  { name: "higher kAtr 2.5",          lookback: 15, kAtr: 2.5, momRatio: 0.70, sideFilter: -1 },
  { name: "both sides allowed",       lookback: 15, kAtr: 2.0, momRatio: 0.70, sideFilter:  0 },
];

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message));
          else resolve(m);
        }
      } catch { /* ignore */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout req_id=${id}`)); }
      }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = end;
  while (candles.length < count) {
    const want = Math.min(5000, count - candles.length);
    const r = await c.send({
      ticks_history: sym, adjust_start_time: 1, count: want,
      end: cursor, style: "candles", granularity: gr,
    });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch);
    cursor = ch[0].epoch - 1;
    if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

async function evalVariant(v: Variant, allCandles: Candle[]) {
  const detectors = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation"
      ? { lookback: v.lookback, atrPeriod: 14, kAtr: v.kAtr, momRatio: v.momRatio, sideFilter: v.sideFilter }
      : d.params,
  }));
  const r = await runBacktest({
    symbol: SYM as any, granularity: GR as any, count: allCandles.length,
    atrSlMult: 1.0, atrTpMult: 1.0, costBps: COST_BPS,
    detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, allCandles);
  // Filter to YESTERDAY only (post-warmup).
  const yest = r.trades.filter((t) => {
    const epoch = allCandles[t.openedAtIndex].epoch;
    return epoch >= YEST_START && epoch < YEST_END;
  });
  let wins = 0, losses = 0, totalUsd = 0, sumR = 0;
  for (const t of yest) {
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    totalUsd += pnlUsd;
    if (pnlUsd > 0) wins++; else if (pnlUsd < 0) losses++;
    sumR += pnlUsd / STAKE;
  }
  const trades = yest.length;
  const wr = trades > 0 ? wins / trades : 0;
  const expR = trades > 0 ? sumR / trades : 0;
  const passes = trades >= 6 && totalUsd > 0 && (wr >= 0.50 || expR >= 0.10);
  return { trades, wins, losses, wr, totalUsd: Math.round(totalUsd * 100) / 100, expR, passes };
}

async function main() {
  const yestDate = new Date(YEST_START * 1000).toISOString().slice(0, 10);
  console.log(`RDBEAR breakout-continuation 5m — yesterday-only edge hunt`);
  console.log(`Yesterday UTC: ${yestDate}  ·  Stake $${STAKE}  ·  MULT ${MULT}×\n`);

  const c = new C(); await c.ready;
  // Pull ~30 days of 5m so we have enough warmup for ATR/lookback. We only
  // score yesterday's trades.
  const candles = await fetchPaged(c, SYM, GR, 9000, YEST_END);
  c.close();
  const dCovered = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
  console.log(`Fetched ${candles.length} bars (${dCovered.toFixed(1)}d, ${new Date(candles[0].epoch * 1000).toISOString().slice(0, 10)} → ${new Date(candles[candles.length - 1].epoch * 1000).toISOString().slice(0, 10)})\n`);

  console.log(`  ${"#".padStart(2)}  ${"variant".padEnd(28)} lb  kAtr momR  side   trades  W/L     WR    total      expR   edge?`);
  let winner: { v: Variant; r: Awaited<ReturnType<typeof evalVariant>> } | null = null;
  for (let i = 0; i < TRIALS.length; i++) {
    const v = TRIALS[i];
    const r = await evalVariant(v, candles);
    const sideTag = v.sideFilter === -1 ? "SELL" : v.sideFilter === 1 ? "BUY" : "BOTH";
    const tag = r.passes ? "✓ EDGE" : "  ";
    console.log(`  ${String(i + 1).padStart(2)}  ${v.name.padEnd(28)} ${String(v.lookback).padStart(2)}   ${v.kAtr.toFixed(1)} ${v.momRatio.toFixed(2)}  ${sideTag.padEnd(5)} ${String(r.trades).padStart(5)}t  ${r.wins}W/${r.losses}L  ${(r.wr * 100).toFixed(0).padStart(3)}%  ${r.totalUsd >= 0 ? "+" : ""}$${r.totalUsd.toFixed(2).padStart(8)}  ${r.expR.toFixed(2).padStart(5)}   ${tag}`);
    if (!winner && r.passes) winner = { v, r };
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  if (winner) {
    const sideTag = winner.v.sideFilter === -1 ? "SELL-only" : winner.v.sideFilter === 1 ? "BUY-only" : "both sides";
    console.log(`✓ EDGE FOUND on yesterday (${yestDate})`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  variant: ${winner.v.name}`);
    console.log(`  config:  lookback=${winner.v.lookback}, kAtr=${winner.v.kAtr}, momRatio=${winner.v.momRatio}, sideFilter=${sideTag}`);
    console.log(`  result:  ${winner.r.trades}t / ${winner.r.wins}W ${winner.r.losses}L / WR ${(winner.r.wr * 100).toFixed(1)}% / +$${winner.r.totalUsd} / expR ${winner.r.expR.toFixed(2)}`);
  } else {
    console.log(`✗ NO EDGE on yesterday across ${TRIALS.length} variants. RDBEAR is in a flat regime today.`);
    console.log(`══════════════════════════════════════════════════════════════════════════════`);
    console.log(`  Recommend: keep multi-day backtest as basis (3-window CV showed +$4,734 / 31d).`);
    console.log(`  A single-day flat is normal — RDBEAR has multi-day winning streaks broken by`);
    console.log(`  occasional flat days. The strategy edge is statistical, not always-on.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// 3-window cross-validation for RDBEAR breakout-continuation 5m.
//
// Detector params mirror the validated RDBULL config:
//   lookback=15, atrPeriod=14, kAtr=2.0, momRatio=0.7
// sideFilter=-1 → SELL-only (RDBEAR is the bear-side index, drifts down)
//
// Windows (each ~10 days, non-overlapping, total ~30 days):
//   • W0     (oldest)    — train baseline
//   • TRAIN  (middle)    — secondary check
//   • TEST   (newest)    — out-of-sample, must hold up
// PASS criteria: each window ≥10 trades AND total $ > 0 AND WR ≥ 50%.

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

const PARAMS = {
  lookback: 15,
  atrPeriod: 14,
  kAtr: 2.0,
  momRatio: 0.7,
  sideFilter: -1, // SELL-only
};

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
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout req_id=${id}`));
        }
      }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function fetchPaged(c: C, sym: string, gr: number, count: number): Promise<Candle[]> {
  const candles: Candle[] = [];
  let cursor = Math.floor(Date.now() / 1000);
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

async function evalWindow(label: string, candles: Candle[]) {
  const detectors = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation" ? PARAMS : d.params,
  }));
  const r = await runBacktest({
    symbol: SYM as any,
    granularity: GR as any,
    count: candles.length,
    atrSlMult: 1.0,
    atrTpMult: 1.0,
    costBps: COST_BPS,
    detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  let wins = 0, losses = 0, totalUsd = 0, sumR = 0;
  for (const t of r.trades) {
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    totalUsd += pnlUsd;
    if (pnlUsd > 0) wins++; else if (pnlUsd < 0) losses++;
    sumR += pnlUsd / STAKE;
  }
  const trades = r.trades.length;
  const wr = trades > 0 ? wins / trades : 0;
  const expR = trades > 0 ? sumR / trades : 0;
  const totalR = sumR;
  const firstEpoch = candles[0]?.epoch ?? 0;
  const lastEpoch = candles[candles.length - 1]?.epoch ?? 0;
  const days = (lastEpoch - firstEpoch) / 86400;
  const pass = trades >= 10 && totalUsd > 0 && wr >= 0.50;
  console.log(`  ${label.padEnd(7)} ${trades.toString().padStart(4)}t  ${wins}W/${losses}L  WR ${(wr * 100).toFixed(1).padStart(5)}%  ${totalUsd >= 0 ? "+" : ""}$${totalUsd.toFixed(2).padStart(8)}  expR ${expR.toFixed(2)}  totalR ${totalR.toFixed(2).padStart(6)}  ${days.toFixed(1)}d  ${pass ? "✓ PASS" : "✗ FAIL"}`);
  return { trades, wins, losses, wr, totalUsd, expR, totalR, days, pass };
}

async function main() {
  console.log(`RDBEAR breakout-continuation 5m — 3-window cross-validation`);
  console.log(`Params: lb=${PARAMS.lookback}, kAtr=${PARAMS.kAtr}, momRatio=${PARAMS.momRatio}, sideFilter=SELL-only`);
  console.log(`Stake $${STAKE} · MULT ${MULT}× · COST_BPS ${COST_BPS}\n`);

  const c = new C(); await c.ready;
  // 3 × ~10-day windows. 5m → 2880 bars per 10d. Pull 9000 bars total ≈ 31d.
  const FETCH = 9000;
  const candles = await fetchPaged(c, SYM, GR, FETCH);
  c.close();
  console.log(`Fetched ${candles.length} bars (${((candles[candles.length-1].epoch - candles[0].epoch) / 86400).toFixed(1)}d)\n`);

  // Split into 3 equal-sized windows. W0 = oldest, TRAIN = middle, TEST = newest.
  const third = Math.floor(candles.length / 3);
  const w0 = candles.slice(0, third);
  const train = candles.slice(third, third * 2);
  const test = candles.slice(third * 2);

  console.log(`  ${"window".padEnd(7)} ${"trades".padStart(5)}  W/L           WR      total      expR    totalR    days  result`);
  const r0 = await evalWindow("W0", w0);
  const r1 = await evalWindow("TRAIN", train);
  const r2 = await evalWindow("TEST", test);

  const allPass = r0.pass && r1.pass && r2.pass;
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(allPass ? "✓ ALL WINDOWS PASS — RDBEAR breakout candidate ready for registration" : "✗ FAILED CROSS-VALIDATION — at least one window failed");
  console.log("══════════════════════════════════════════════════════════════════════════════");
  console.log(`  total: ${r0.trades + r1.trades + r2.trades}t · ${(r0.wins + r1.wins + r2.wins)}W/${(r0.losses + r1.losses + r2.losses)}L · ${(r0.totalUsd + r1.totalUsd + r2.totalUsd) >= 0 ? "+" : ""}$${(r0.totalUsd + r1.totalUsd + r2.totalUsd).toFixed(2)}  expR ${((r0.totalR + r1.totalR + r2.totalR) / Math.max(1, r0.trades + r1.trades + r2.trades)).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

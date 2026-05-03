// Focused synth candidate hunt — looks for the NEXT synth strategy with edge.
//
// Untested universe (current registry already has BOOM300N drift + RDBULL breakout):
//   • BOOM500/1000 spike-fade @ 1m  (BOOM300N mirror — slower spike cadence)
//   • CRASH500/1000 spike-fade @ 1m (CRASH300N mirror)
//   • RDBEAR breakout @ 5m          (RDBULL mirror — short side)
//   • BOOM500/1000 drift-pullback @ 5m  (BOOM300N drift-pullback ported up)
//   • CRASH500/1000 drift-pullback @ 5m
//
// For each candidate: backtest 30 days, compute trades / WR / total $ / R-mult.
// Pass criteria for "promising — drill down further":
//   • ≥40 trades / 30d (high-freq)
//   • ≥52% WR OR ≥+0.15R expectancy
//   • Total $ > 0
//
// This is a SCREENER — winners need 3-window cross-validation before going live.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COST_BPS = 5.0;

type Candidate = {
  sym: string;
  gr: number;
  detector: "spikeFade" | "driftPullback" | "breakoutContinuation";
  side?: "BUY" | "SELL" | "BOTH";
  params: Record<string, number>;
  atrSl: number;
  atrTp: number;
};

// Spike-fade params validated for BOOM/CRASH 300N: 3×ATR, 0.2 buffer, 50% TP, confirmation=1
const SPIKE_PARAMS = { atrPeriod: 14, spikeNAtr: 3.0, bufferAtrMul: 0.2, tpFracOfSpike: 0.5, requireConfirmation: 1 };
// Drift-pullback validated for BOOM300N: k=2, kAtr=0.7, period=14
const DRIFT_PARAMS_BOOM = { driftDirection: -1, consec: 2, atrPeriod: 14, kAtr: 0.7 }; // BOOM = down-drift
const DRIFT_PARAMS_CRASH = { driftDirection: 1, consec: 2, atrPeriod: 14, kAtr: 0.7 };  // CRASH = up-drift
// Breakout validated for RDBULL: lb=15, kAtr=2.0, momRatio=0.7, BUY-only
const BREAKOUT_PARAMS = { lookback: 15, atrPeriod: 14, kAtr: 2.0, momRatio: 0.7, sideFilter: 0 };

const CANDIDATES: Candidate[] = [
  // Spike-fade on slower BOOM/CRASH variants
  { sym: "BOOM500", gr: 60, detector: "spikeFade", params: SPIKE_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  { sym: "BOOM1000", gr: 60, detector: "spikeFade", params: SPIKE_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  { sym: "CRASH500", gr: 60, detector: "spikeFade", params: SPIKE_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  { sym: "CRASH1000", gr: 60, detector: "spikeFade", params: SPIKE_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  // Drift-pullback on slower BOOM/CRASH variants — BOOM is down-drift, CRASH is up-drift
  { sym: "BOOM500", gr: 300, detector: "driftPullback", params: DRIFT_PARAMS_BOOM, atrSl: 1.0, atrTp: 1.0 },
  { sym: "BOOM1000", gr: 300, detector: "driftPullback", params: DRIFT_PARAMS_BOOM, atrSl: 1.0, atrTp: 1.0 },
  { sym: "CRASH500", gr: 300, detector: "driftPullback", params: DRIFT_PARAMS_CRASH, atrSl: 1.0, atrTp: 1.0 },
  { sym: "CRASH1000", gr: 300, detector: "driftPullback", params: DRIFT_PARAMS_CRASH, atrSl: 1.0, atrTp: 1.0 },
  // RDBEAR breakout (mirror of RDBULL — SELL-only since RDBEAR is the bear-side index)
  { sym: "RDBEAR", gr: 300, detector: "breakoutContinuation",
    params: { lookback: 15, atrPeriod: 14, kAtr: 2.0, momRatio: 0.7, sideFilter: -1 },
    atrSl: 1.0, atrTp: 1.0 },
  // R_50 / R_75 / R_100 breakout — pure random walks, see if breakout-continuation finds anything
  { sym: "R_50", gr: 300, detector: "breakoutContinuation", params: BREAKOUT_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  { sym: "R_75", gr: 300, detector: "breakoutContinuation", params: BREAKOUT_PARAMS, atrSl: 1.0, atrTp: 1.0 },
  { sym: "R_100", gr: 300, detector: "breakoutContinuation", params: BREAKOUT_PARAMS, atrSl: 1.0, atrTp: 1.0 },
];

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  closed = false;
  constructor() { this.connect(); }
  private connect() {
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
  close() { this.closed = true; try { this.ws.close(); } catch { /* */ } }
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

async function evalCandidate(cand: Candidate, candles: Candle[]) {
  const detectors = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === cand.detector,
    params: d.id === cand.detector ? cand.params : d.params,
  }));
  const r = await runBacktest({
    symbol: cand.sym as any,
    granularity: cand.gr as any,
    count: candles.length,
    atrSlMult: cand.atrSl,
    atrTpMult: cand.atrTp,
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
  return {
    trades,
    wins, losses,
    wr: trades > 0 ? wins / trades : 0,
    totalUsd: Math.round(totalUsd * 100) / 100,
    expR: trades > 0 ? sumR / trades : 0,
  };
}

async function main() {
  // Cap fetch to ~30 days. 1m = 1440/day → 43200 bars over 30d but Deriv caps
  // ticks_history at ~5000 per request. Pull 5000 1m bars (~3.5 days) for fast
  // screening; slower-cadence detectors get 5000 5m bars (~17 days).
  const FETCH_1M = 5000;
  const FETCH_5M = 5000;

  console.log("Synth candidate hunt — find the next synth with edge");
  console.log(`Stake $${STAKE}  ·  MULT ${MULT}×  ·  COST_BPS ${COST_BPS}\n`);

  const c = new C(); await c.ready;
  type Row = Candidate & ReturnType<typeof evalCandidate> extends Promise<infer R> ? Candidate & R : never;
  type RowFlat = Candidate & { trades: number; wins: number; losses: number; wr: number; totalUsd: number; expR: number; bars: number; days: number };
  const rows: RowFlat[] = [];

  for (let i = 0; i < CANDIDATES.length; i++) {
    const cand = CANDIDATES[i];
    const fetch = cand.gr === 60 ? FETCH_1M : FETCH_5M;
    process.stdout.write(`[${i + 1}/${CANDIDATES.length}] ${cand.sym}@${cand.gr}s ${cand.detector}... `);
    try {
      const candles = await fetchPaged(c, cand.sym, cand.gr, fetch);
      if (candles.length < 500) { console.log(`skip (only ${candles.length} bars)`); continue; }
      const res = await evalCandidate(cand, candles);
      const days = (candles.length * cand.gr) / 86400;
      rows.push({ ...cand, ...res, bars: candles.length, days });
      console.log(`${res.trades}t  ${res.wins}W/${res.losses}L  WR ${(res.wr * 100).toFixed(1)}%  ${res.totalUsd >= 0 ? "+" : ""}$${res.totalUsd}  expR ${res.expR.toFixed(2)}  (${candles.length} bars / ${days.toFixed(1)}d)`);
    } catch (e) {
      console.log(`FAIL: ${(e as Error).message}`);
    }
  }
  c.close();

  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  console.log("RANKED BY TOTAL $");
  console.log("══════════════════════════════════════════════════════════════════════════════");
  rows.sort((a, b) => b.totalUsd - a.totalUsd);
  console.log(`  ${"sym".padEnd(11)}${"tf".padEnd(5)}${"detector".padEnd(22)}${"trades".padStart(7)} ${"WR".padStart(5)} ${"total".padStart(10)} ${"expR".padStart(7)}  days`);
  for (const r of rows) {
    const tag = r.totalUsd > 0 && r.wr >= 0.50 && r.trades >= 20 ? " ★" : r.totalUsd > 0 ? " ✓" : "  ";
    console.log(`${tag}${r.sym.padEnd(11)}${(r.gr === 60 ? "1m" : "5m").padEnd(5)}${r.detector.padEnd(22)}${String(r.trades).padStart(7)} ${(r.wr * 100).toFixed(0).padStart(4)}% ${(r.totalUsd >= 0 ? "+" : "") + "$" + r.totalUsd.toFixed(0).padStart(7)} ${r.expR.toFixed(2).padStart(7)}  ${r.days.toFixed(1)}d`);
  }

  console.log("\n══════════════════════════════════════════════════════════════════════════════");
  console.log("PROMISING (≥20 trades · ≥50% WR · +$ · expR ≥ 0.10) — drill down with 3-window CV");
  console.log("══════════════════════════════════════════════════════════════════════════════");
  const promising = rows.filter((r) => r.trades >= 20 && r.wr >= 0.50 && r.totalUsd > 0 && r.expR >= 0.10);
  if (promising.length === 0) console.log("  none");
  else for (const r of promising) {
    console.log(`  ★ ${r.sym}@${r.gr === 60 ? "1m" : "5m"}  ${r.detector}  ${r.trades}t  WR ${(r.wr * 100).toFixed(1)}%  +$${r.totalUsd}  expR ${r.expR.toFixed(2)}  (${r.days.toFixed(1)}d)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

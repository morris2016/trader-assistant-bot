// RDBEAR breakout 5m — 5-hour windows on 2 days ago (2026-04-29 UTC).
// Test variants 1, 2, 7 in TWO modes:
//   • WARM: fetch ~30 days, only score the 5-hour windows. Detector has full
//     ATR/lookback history before any signal counts.
//   • COLD (no warmup): fetch ONLY the 5-hour window. Detector starts blind —
//     ATR/lookback need to bootstrap from scratch. Mirrors what the live bot
//     looks like immediately after a fresh start.
//
// 5-hour buckets across 24h: 00-05, 05-10, 10-15, 15-20, 20-24 (last is 4h).

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

// 2 days ago in UTC
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const TARGET_START = TODAY_START - 2 * 86400; // 2026-04-29 00:00 UTC

// 5-hour windows
const WINDOWS = [
  { label: "00-05", startH:  0, endH:  5 },
  { label: "05-10", startH:  5, endH: 10 },
  { label: "10-15", startH: 10, endH: 15 },
  { label: "15-20", startH: 15, endH: 20 },
  { label: "20-24", startH: 20, endH: 24 },
];

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline kAtr=2.0 momR=0.70",  lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "#2 tighter   momR=0.75",           lookback: 15, kAtr: 2.0, momRatio: 0.75 },
  { name: "#7 higher kAtr=2.5",               lookback: 15, kAtr: 2.5, momRatio: 0.70 },
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
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch);
    cursor = ch[0].epoch - 1;
    if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}

async function evalVariant(v: Variant, candles: Candle[], windowStart: number, windowEnd: number) {
  const detectors = defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "breakoutContinuation",
    params: d.id === "breakoutContinuation"
      ? { lookback: v.lookback, atrPeriod: 14, kAtr: v.kAtr, momRatio: v.momRatio, sideFilter: -1 }
      : d.params,
  }));
  const r = await runBacktest({
    symbol: SYM as any, granularity: GR as any, count: candles.length,
    atrSlMult: 1.0, atrTpMult: 1.0, costBps: COST_BPS, detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  let trades = 0, wins = 0, losses = 0, totalUsd = 0, sumR = 0;
  for (const t of r.trades) {
    const epoch = candles[t.openedAtIndex].epoch;
    if (epoch < windowStart || epoch >= windowEnd) continue;
    trades++;
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    totalUsd += pnlUsd;
    sumR += pnlUsd / STAKE;
    if (pnlUsd > 0) wins++; else if (pnlUsd < 0) losses++;
  }
  return { trades, wins, losses, wr: trades > 0 ? wins / trades : 0, totalUsd, expR: trades > 0 ? sumR / trades : 0 };
}

async function runSection(label: string, candles: Candle[]) {
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`${label}  ·  ${candles.length} bars total (${((candles[candles.length-1].epoch - candles[0].epoch)/86400).toFixed(1)}d)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    console.log(`\n  ${v.name}`);
    console.log(`  ${"window".padEnd(8)} ${"trades".padStart(5)}  W/L     WR    total $    expR`);
    let dayT = 0, dayW = 0, dayL = 0, dayTotal = 0, daySumR = 0;
    for (const w of WINDOWS) {
      const start = TARGET_START + w.startH * 3600;
      const end = TARGET_START + w.endH * 3600;
      const r = await evalVariant(v, candles, start, end);
      console.log(`  ${w.label.padEnd(8)}   ${String(r.trades).padStart(2)}t  ${r.wins}W/${r.losses}L  ${(r.wr * 100).toFixed(0).padStart(3)}%  ${r.totalUsd >= 0 ? "+" : ""}$${r.totalUsd.toFixed(2).padStart(8)}  ${r.expR.toFixed(2).padStart(5)}`);
      dayT += r.trades; dayW += r.wins; dayL += r.losses; dayTotal += r.totalUsd; daySumR += r.expR * r.trades;
    }
    const dWR = dayT > 0 ? dayW / dayT : 0;
    const dExpR = dayT > 0 ? daySumR / dayT : 0;
    console.log(`  ──────────────────────────────────────────────────────────`);
    console.log(`  DAY        ${String(dayT).padStart(2)}t  ${dayW}W/${dayL}L  ${(dWR * 100).toFixed(0).padStart(3)}%  ${dayTotal >= 0 ? "+" : ""}$${dayTotal.toFixed(2).padStart(8)}  ${dExpR.toFixed(2).padStart(5)}`);
  }
}

async function main() {
  const targetDate = new Date(TARGET_START * 1000).toISOString().slice(0, 10);
  console.log(`RDBEAR breakout 5m — 5-hour windows on ${targetDate} UTC (2 days ago)\n`);

  const c = new C(); await c.ready;
  // WARM mode: full 30-day history.
  const warm = await fetchPaged(c, SYM, GR, 9000, TARGET_START + 86400);
  // COLD mode: just the target day. ATR/lookback have to bootstrap inside the
  // 24h window — the first ~14 bars produce no ATR (≈ 70min blind period).
  const cold = warm.filter((k) => k.epoch >= TARGET_START && k.epoch < TARGET_START + 86400);
  c.close();

  await runSection(`WARM (with warmup) — ${SYM}`, warm);
  console.log("");
  await runSection(`COLD (no warmup) — ${SYM}, fresh-start scenario`, cold);
}

main().catch((e) => { console.error(e); process.exit(1); });

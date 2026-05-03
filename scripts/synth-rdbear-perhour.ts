// RDBEAR breakout 5m — per-hour breakdown for a single day, variants 1/2/7.
// Highlight the LAST HOUR of the day (23:00-24:00 UTC) — the most recent
// trading window before the day flipped. Useful for deciding whether the
// strategy is currently in a productive regime hour-to-hour.
//
// Day: yesterday (2026-04-30 UTC). Override with DAY_OFFSET env var
// (e.g. DAY_OFFSET=2 for 2 days ago).

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

const DAY_OFFSET = Number(process.env.DAY_OFFSET ?? 1); // 1 = yesterday
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const TARGET_START = TODAY_START - DAY_OFFSET * 86400;
const TARGET_END = TARGET_START + 86400;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline kAtr=2.0 momR=0.70", lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "#2 tighter   momR=0.75",          lookback: 15, kAtr: 2.0, momRatio: 0.75 },
  { name: "#7 higher kAtr=2.5",              lookback: 15, kAtr: 2.5, momRatio: 0.70 },
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

type HourBucket = { hour: number; trades: number; wins: number; losses: number; totalUsd: number; sumR: number };

async function evalVariant(v: Variant, candles: Candle[]): Promise<HourBucket[]> {
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
  const hours: HourBucket[] = [];
  for (let h = 0; h < 24; h++) hours.push({ hour: h, trades: 0, wins: 0, losses: 0, totalUsd: 0, sumR: 0 });
  for (const t of r.trades) {
    const epoch = candles[t.openedAtIndex].epoch;
    if (epoch < TARGET_START || epoch >= TARGET_END) continue;
    const hour = new Date(epoch * 1000).getUTCHours();
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    const b = hours[hour];
    b.trades++; b.totalUsd += pnlUsd; b.sumR += pnlUsd / STAKE;
    if (pnlUsd > 0) b.wins++; else if (pnlUsd < 0) b.losses++;
  }
  return hours;
}

async function main() {
  const targetDate = new Date(TARGET_START * 1000).toISOString().slice(0, 10);
  console.log(`RDBEAR breakout 5m — per-hour for ${targetDate} UTC (offset=${DAY_OFFSET}d)\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, TARGET_END);
  c.close();
  console.log(`Fetched ${candles.length} bars (warmup ${(candles[candles.length-1].epoch - candles[0].epoch)/86400 | 0}d)\n`);

  const results = await Promise.all(VARIANTS.map(async (v) => ({ v, hours: await evalVariant(v, candles) })));

  // Per-hour table — only print hours where any variant fired.
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-HOUR TRADES (★ = LAST HOUR of day, 23:00-24:00 UTC)`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`  hour     #1 baseline           #2 tighter momR        #7 higher kAtr`);
  for (let h = 0; h < 24; h++) {
    const r1 = results[0].hours[h]; const r2 = results[1].hours[h]; const r7 = results[2].hours[h];
    if (r1.trades === 0 && r2.trades === 0 && r7.trades === 0) continue;
    const fmt = (x: HourBucket) => x.trades === 0 ? "  -                  " : `${String(x.trades).padStart(2)}t ${x.wins}W/${x.losses}L ${(x.totalUsd >= 0 ? "+" : "") + "$" + x.totalUsd.toFixed(0).padStart(4)}`;
    const last = h === 23 ? " ★" : "  ";
    console.log(`${last}${String(h).padStart(2)}:00    ${fmt(r1).padEnd(20)}  ${fmt(r2).padEnd(20)}  ${fmt(r7)}`);
  }

  // Last-hour focus
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`LAST HOUR OF DAY (23:00-24:00 UTC on ${targetDate})`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const { v, hours } of results) {
    const r = hours[23];
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const expR = r.trades > 0 ? r.sumR / r.trades : 0;
    if (r.trades === 0) {
      console.log(`  ${v.name.padEnd(36)} no trades signaled in this hour`);
    } else {
      console.log(`  ${v.name.padEnd(36)} ${r.trades}t · ${r.wins}W/${r.losses}L · WR ${(wr*100).toFixed(0)}% · ${r.totalUsd >= 0 ? "+" : ""}$${r.totalUsd.toFixed(2)} · expR ${expR.toFixed(2)}`);
    }
  }

  // Day totals
  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`DAY TOTALS (${targetDate})`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const { v, hours } of results) {
    const dT = hours.reduce((s, b) => s + b.trades, 0);
    const dW = hours.reduce((s, b) => s + b.wins, 0);
    const dL = hours.reduce((s, b) => s + b.losses, 0);
    const dUsd = hours.reduce((s, b) => s + b.totalUsd, 0);
    const dR = hours.reduce((s, b) => s + b.sumR, 0);
    const dWR = dT > 0 ? dW / dT : 0;
    const dExpR = dT > 0 ? dR / dT : 0;
    console.log(`  ${v.name.padEnd(36)} ${dT}t · ${dW}W/${dL}L · WR ${(dWR*100).toFixed(0)}% · ${dUsd >= 0 ? "+" : ""}$${dUsd.toFixed(2)} · expR ${dExpR.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

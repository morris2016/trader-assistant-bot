// RDBEAR breakout 5m — most recent COMPLETED hour, variants 1/2/7.
// "Last hour" = the most recently completed UTC hour relative to now.
// e.g. if it's 15:38 UTC, last hour = 14:00-15:00 UTC.

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

// Most recent completed UTC hour. floor(now / 3600) * 3600 = top of current hour;
// minus 3600 = top of previous hour. window = [prev_top, current_top).
const NOW = Math.floor(Date.now() / 1000);
const HOUR_END = Math.floor(NOW / 3600) * 3600;          // top of current hour
const HOUR_START = HOUR_END - 3600;                       // top of previous hour
const FETCH_END = HOUR_END;                               // up to top of current hour

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

async function evalVariant(v: Variant, candles: Candle[]) {
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
  type T = { epoch: number; pnlUsd: number; rMul: number };
  const trades: T[] = [];
  for (const t of r.trades) {
    const epoch = candles[t.openedAtIndex].epoch;
    if (epoch < HOUR_START || epoch >= HOUR_END) continue;
    const pnlUsd = STAKE * Math.max(-1, t.pnlPct * MULT);
    trades.push({ epoch, pnlUsd, rMul: pnlUsd / STAKE });
  }
  let wins = 0, losses = 0, totalUsd = 0, sumR = 0;
  for (const t of trades) {
    totalUsd += t.pnlUsd; sumR += t.rMul;
    if (t.pnlUsd > 0) wins++; else if (t.pnlUsd < 0) losses++;
  }
  return { trades, wins, losses, totalUsd, sumR, count: trades.length };
}

async function main() {
  const startISO = new Date(HOUR_START * 1000).toISOString();
  const endISO = new Date(HOUR_END * 1000).toISOString();
  const nowISO = new Date(NOW * 1000).toISOString();
  console.log(`Now: ${nowISO}`);
  console.log(`Last completed UTC hour: ${startISO} → ${endISO}\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, FETCH_END);
  c.close();
  console.log(`Fetched ${candles.length} ${SYM} 5m bars (warmup ${(candles[candles.length-1].epoch - candles[0].epoch)/86400 | 0}d)\n`);

  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  console.log(`LAST-HOUR TRADES — ${startISO.slice(11,16)}-${endISO.slice(11,16)} UTC`);
  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const r = await evalVariant(v, candles);
    if (r.count === 0) {
      console.log(`  ${v.name.padEnd(36)} — no signal in last hour`);
      continue;
    }
    const wr = r.wins / r.count;
    console.log(`  ${v.name}`);
    console.log(`     ${r.count}t · ${r.wins}W/${r.losses}L · WR ${(wr*100).toFixed(0)}% · ${r.totalUsd >= 0 ? "+" : ""}$${r.totalUsd.toFixed(2)} · expR ${(r.sumR / r.count).toFixed(2)}`);
    for (const t of r.trades) {
      const tISO = new Date(t.epoch * 1000).toISOString().slice(11, 19);
      const tag = t.pnlUsd > 0 ? "WON" : t.pnlUsd < 0 ? "LOST" : "scratch";
      console.log(`       ${tISO}  ${tag}  ${t.pnlUsd >= 0 ? "+" : ""}$${t.pnlUsd.toFixed(2)} (${t.rMul.toFixed(2)}R)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

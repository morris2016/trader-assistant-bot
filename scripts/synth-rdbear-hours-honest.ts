// RDBEAR breakout 5m — honest Deriv sim, per-hour table from
// `START_HOUR` (default 1) to `END_HOUR` (default 9) UTC of today.
// Variants 1, 2, 7. Mirrors production paper-engine semantics:
//   • Entry deferred to next bar's open ± 1bp adverse spread
//   • SL slippage 5bps past stop on hit
//   • Commission 0.5% of stake at open
//   • Same-bar settlement gate (entry on next bar; first SL/TP touch wins)

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;

const START_HOUR = Number(process.env.START_HOUR ?? 1); // inclusive
const END_HOUR = Number(process.env.END_HOUR ?? 9);     // inclusive (last bucket = END_HOUR-1 → END_HOUR)

// Today UTC midnight
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline kAtr=2.0 momR=0.70", lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "#2 tighter   momR=0.75",          lookback: 15, kAtr: 2.0, momRatio: 0.75 },
  { name: "#7 higher kAtr=2.5",              lookback: 15, kAtr: 2.5, momRatio: 0.70 },
];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch { /* */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout req_id=${id}`)); } }, 30_000);
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

function atr(c: Candle[], i: number, period = 14): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

type Sig = { idx: number; side: "SELL"; entry: number; stop: number; target: number };
function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  for (let i = v.lookback + 14; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    let lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    if (!(cur.close < lo)) continue;
    const closePosDn = (cur.high - cur.close) / r;
    if (closePosDn < v.momRatio) continue;
    const dist = v.kAtr * a;
    out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { sigEpoch: number; net: number; rMul: number; exit: "tp" | "sl" };

function honestSim(v: Variant, candles: Candle[], windowStart: number, windowEnd: number): Trade[] {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= windowStart && candles[s.idx].epoch < windowEnd);
  const trades: Trade[] = [];
  for (const sig of sigs) {
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    // SELL: adverse spread = lower fill price (less favorable)
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    const commission = round2(STAKE * COMMISSION_FRAC);
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) {
        exit = "sl";
        exitPrice = stop + stop * SL_SLIPPAGE_FRAC;
        break;
      }
      if (b.low <= target) {
        exit = "tp";
        exitPrice = target;
        break;
      }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE; // SELL P&L
    const pnlGross = round2(STAKE * MULT * move);
    const net = round2(pnlGross - commission);
    trades.push({ sigEpoch: candles[sig.idx].epoch, net, rMul: net / STAKE, exit });
  }
  return trades;
}

async function main() {
  const dateStr = new Date(TODAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST Deriv sim — RDBEAR breakout 5m  ·  ${dateStr} UTC  ·  hours ${String(START_HOUR).padStart(2, "0")}:00 → ${String(END_HOUR).padStart(2, "0")}:00`);
  console.log(`Stake $${STAKE}  ·  MULT ${MULT}×  ·  commission ${(COMMISSION_FRAC*100).toFixed(2)}%  ·  spread ${ENTRY_SPREAD_FRAC*10000}bp  ·  SL slip ${SL_SLIPPAGE_FRAC*10000}bp\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, TODAY_START + END_HOUR * 3600);
  c.close();
  console.log(`Fetched ${candles.length} bars (warmup ${(candles[candles.length-1].epoch - candles[0].epoch)/86400 | 0}d)\n`);

  // Per-hour for each variant.
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  hour      ${"#1 baseline".padEnd(22)} ${"#2 tighter momR".padEnd(22)} ${"#7 higher kAtr"}`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);

  const totals: Record<string, { trades: number; wins: number; losses: number; net: number }> = {};
  for (const v of VARIANTS) totals[v.name] = { trades: 0, wins: 0, losses: 0, net: 0 };

  for (let h = START_HOUR; h < END_HOUR; h++) {
    const ws = TODAY_START + h * 3600;
    const we = ws + 3600;
    const cells = VARIANTS.map((v) => {
      const ts = honestSim(v, candles, ws, we);
      const wins = ts.filter((t) => t.net > 0).length;
      const losses = ts.filter((t) => t.net < 0).length;
      const net = ts.reduce((s, t) => s + t.net, 0);
      const tot = totals[v.name];
      tot.trades += ts.length; tot.wins += wins; tot.losses += losses; tot.net += net;
      if (ts.length === 0) return "—                    ";
      return `${ts.length}t ${wins}W/${losses}L ${(net >= 0 ? "+" : "") + "$" + net.toFixed(2).padStart(7)}`;
    });
    console.log(`  ${String(h).padStart(2, "0")}:00→${String(h + 1).padStart(2, "0")}:00  ${cells[0].padEnd(22)} ${cells[1].padEnd(22)} ${cells[2]}`);
  }

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const t = totals[v.name];
    const wr = t.trades > 0 ? t.wins / t.trades : 0;
    console.log(`  ${v.name.padEnd(36)} ${t.trades}t · ${t.wins}W/${t.losses}L · WR ${(wr * 100).toFixed(0)}% · NET ${t.net >= 0 ? "+" : ""}$${t.net.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

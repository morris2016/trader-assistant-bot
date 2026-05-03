// RDBEAR breakout 5m — ONE HOUR BEFORE the last hour, with HONEST Deriv sim.
// Honest sim mirrors what the production paper engine would compute:
//   • Entry deferred to next bar's open ± entry spread (adverse 1bp)
//   • SL slippage 5bps past the stop on hit
//   • Commission 0.5% of stake at open
//   • TP/SL $0.10 floor
//   • Same-bar settlement gate (cannot settle on the bar that fired the signal)

import WebSocket from "ws";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;     // 1 bp adverse
const SL_SLIPPAGE_FRAC  = 5 / 10000;     // 5 bps past stop
const TP_SL_FLOOR_USD = 0.10;

const SYM = "RDBEAR";
const GR = 300; // 5m

// "One hour before" the most recently completed UTC hour.
// e.g. now=12:41 → last hour = 11:00-12:00 → prev hour = 10:00-11:00.
const NOW = Math.floor(Date.now() / 1000);
const HOUR_END_LAST = Math.floor(NOW / 3600) * 3600;     // top of current hour
// HOURS_BACK: 1 = last completed hour (11:00-12:00), 2 = hour before that (10:00-11:00).
const HOURS_BACK = Number(process.env.HOURS_BACK ?? 2);
const HOUR_END = HOUR_END_LAST - (HOURS_BACK - 1) * 3600;
const HOUR_START = HOUR_END - 3600;
const FETCH_END = HOUR_END_LAST;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline kAtr=2.0 momR=0.70", lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "#2 tighter   momR=0.75",          lookback: 15, kAtr: 2.0, momRatio: 0.75 },
  { name: "#7 higher kAtr=2.5",              lookback: 15, kAtr: 2.5, momRatio: 0.70 },
];

// ── WS helper ────────────────────────────────────────────────────────────
class C {
  ws!: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WebSocketClass = require("ws") as typeof import("ws");
    this.ws = new WebSocketClass(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
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

// ── Indicators ───────────────────────────────────────────────────────────
function atr(candles: Candle[], i: number, period = 14): number {
  if (i < period) return 0;
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(
      candles[j].high - candles[j].low,
      Math.abs(candles[j].high - candles[j - 1].close),
      Math.abs(candles[j].low - candles[j - 1].close),
    );
    sum += tr;
  }
  return sum / period;
}

// ── Detector: breakout-continuation SELL-only ────────────────────────────
type Sig = { idx: number; side: "BUY" | "SELL"; entryPrice: number; stopPrice: number; targetPrice: number };

// Mirror of src/main/engine/detectors/breakoutContinuation.ts (SELL-only).
function breakoutContinuation(candles: Candle[], v: Variant): Sig[] {
  const sigs: Sig[] = [];
  for (let i = v.lookback + 14; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    // Prior N-bar high/low EXCLUDING current bar.
    let hi = -Infinity, lo = Infinity;
    const start = i - v.lookback;
    for (let m = start; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const curr = candles[i];
    const barRange = curr.high - curr.low;
    if (barRange <= 0) continue;
    // SELL: close pierces prior N-bar LOW AND (high - close)/range >= momR
    if (!(curr.close < lo)) continue;
    const closePosDn = (curr.high - curr.close) / barRange;
    if (closePosDn < v.momRatio) continue;
    const dist = v.kAtr * a;
    const entry = curr.close;
    const stop = entry + dist;
    const target = entry - dist;
    sigs.push({ idx: i, side: "SELL", entryPrice: entry, stopPrice: stop, targetPrice: target });
  }
  return sigs;
}

// ── Honest sim ────────────────────────────────────────────────────────────
type Trade = { sigEpoch: number; finEpoch: number; closeEpoch: number; signalE: number; finalE: number; exitP: number; exit: "tp" | "sl"; pnlGross: number; commission: number; pnlNet: number; rMul: number };

function round2(x: number) { return Math.round(x * 100) / 100; }

async function honestSim(v: Variant, candles: Candle[]): Promise<Trade[]> {
  const sigs = breakoutContinuation(candles, v);
  const inWindow = sigs.filter((s) => candles[s.idx].epoch >= HOUR_START && candles[s.idx].epoch < HOUR_END);
  const trades: Trade[] = [];
  for (const sig of inWindow) {
    if (sig.idx + 1 >= candles.length) continue; // can't defer to next bar
    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY" ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    // Adjust stop/target to maintain the same distance from finalE as from signalE.
    const delta = finalE - sig.entryPrice;
    const stop = sig.stopPrice + delta;
    const target = sig.targetPrice + delta;
    const commission = round2(STAKE * COMMISSION_FRAC);
    // Simulate forward bar-by-bar from sig.idx+1 onwards. SL/TP touch logic.
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    let exitEpoch = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      // Same-bar gate is implicitly handled — the entry IS at j's open, so j's
      // own high/low can hit SL/TP.
      if (sig.side === "SELL") {
        if (b.high >= stop) {
          exit = "sl";
          exitPrice = stop + stop * SL_SLIPPAGE_FRAC; // adverse fill past stop
          exitEpoch = b.epoch;
          break;
        }
        if (b.low <= target) {
          exit = "tp";
          exitPrice = target;
          exitEpoch = b.epoch;
          break;
        }
      }
    }
    if (!exit) continue; // never closed within fetch window
    // P&L: BOOM/CRASH-style multiplier P&L = stake * mult * (priceMove / entry)
    const move = sig.side === "SELL" ? (finalE - exitPrice) / finalE : (exitPrice - finalE) / finalE;
    const pnlGross = round2(STAKE * MULT * move);
    const pnlNet = round2(pnlGross - commission);
    trades.push({
      sigEpoch: candles[sig.idx].epoch,
      finEpoch: finBar.epoch,
      closeEpoch: exitEpoch,
      signalE: round2(sig.entryPrice),
      finalE: round2(finalE),
      exitP: round2(exitPrice),
      exit,
      pnlGross,
      commission,
      pnlNet,
      rMul: pnlNet / STAKE,
    });
  }
  return trades;
}

async function main() {
  const sISO = new Date(HOUR_START * 1000).toISOString();
  const eISO = new Date(HOUR_END * 1000).toISOString();
  console.log(`HONEST Deriv sim — RDBEAR breakout 5m, hour BEFORE last hour`);
  console.log(`Window: ${sISO} → ${eISO}`);
  console.log(`Stake $${STAKE}  ·  MULT ${MULT}×  ·  commission ${(COMMISSION_FRAC*100).toFixed(2)}%  ·  spread ${ENTRY_SPREAD_FRAC*10000}bp  ·  SL slip ${SL_SLIPPAGE_FRAC*10000}bp\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, FETCH_END);
  c.close();
  console.log(`Fetched ${candles.length} bars (warmup ${(candles[candles.length-1].epoch - candles[0].epoch)/86400 | 0}d)\n`);

  console.log(`══════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const trades = await honestSim(v, candles);
    console.log(`\n  ${v.name}`);
    if (trades.length === 0) { console.log("     — no signal in this hour"); continue; }
    let wins = 0, losses = 0, total = 0, totalGross = 0, totalCom = 0, sumR = 0;
    for (const t of trades) {
      total += t.pnlNet; totalGross += t.pnlGross; totalCom += t.commission; sumR += t.rMul;
      if (t.pnlNet > 0) wins++; else if (t.pnlNet < 0) losses++;
    }
    console.log(`     ${trades.length}t · ${wins}W/${losses}L · WR ${((wins/trades.length)*100).toFixed(0)}% · gross +$${totalGross.toFixed(2)} · commission -$${totalCom.toFixed(2)} · NET ${total >= 0 ? "+" : ""}$${total.toFixed(2)} · expR ${(sumR/trades.length).toFixed(2)}`);
    console.log(`     ${"sigT".padEnd(8)}  ${"finT".padEnd(8)}  ${"closeT".padEnd(8)}  ${"signalE".padStart(8)}  ${"finalE".padStart(8)}  ${"exitP".padStart(8)}  exit  net`);
    for (const t of trades) {
      const sigT = new Date(t.sigEpoch * 1000).toISOString().slice(11, 19);
      const finT = new Date(t.finEpoch * 1000).toISOString().slice(11, 19);
      const cT = new Date(t.closeEpoch * 1000).toISOString().slice(11, 19);
      console.log(`     ${sigT}  ${finT}  ${cT}  ${t.signalE.toFixed(4).padStart(8)}  ${t.finalE.toFixed(4).padStart(8)}  ${t.exitP.toFixed(4).padStart(8)}  ${t.exit}    ${t.pnlNet >= 0 ? "+" : ""}$${t.pnlNet.toFixed(2)} (${t.rMul.toFixed(2)}R)`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

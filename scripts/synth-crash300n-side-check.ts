// CRASH300N side-bias check — does it favor BUYs (fade down-spikes) or
// SELLs (ride down-spikes)? Run validated spike-fade detector both ways
// over Jan 1 2025 → today and compare net PnL, WR, trade count.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const COMMISSION_FRAC = 0.005;
const MULT = 100;
const STAKE = 1.5;

const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.2;
const TP_FRAC_OF_SPIKE = 0.5;
const ATR_PERIOD = 14;

const SYM = "CRASH300N";
const GR = 60;

const JAN_1_2025 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 60_000);
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

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number; result: "TP" | "SL" };

function detectAndResolve(candles: Candle[], side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];

    let entry = 0, stop = 0, target = 0;
    if (side === "BUY") {
      // FADE down-spike (validated direction)
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close > spike.close)) continue;
      entry = confirm.close;
      stop = spike.low - BUFFER_ATR * a;
      target = entry + TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop >= entry) continue;
    } else {
      // SELL = ride down-spike (or fade up-spike if it exists, but CRASH down-drifts so up-spikes rare)
      // Mirror logic: bearish spike + confirm continues down → SELL
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close < spike.close)) continue;
      entry = confirm.close;
      stop = spike.high + BUFFER_ATR * a;
      target = entry - TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop <= entry) continue;
    }

    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - entry;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (side === "BUY") {
        if (b.low <= stopAdj) { exit = "SL"; break; }
        if (b.high >= targetAdj) { exit = "TP"; break; }
      } else {
        if (b.high >= stopAdj) { exit = "SL"; break; }
        if (b.low <= targetAdj) { exit = "TP"; break; }
      }
    }
    if (exit) out.push({ idx: i, side, entry, stop, target, result: exit });
  }
  return out;
}

function pnl(side: "BUY" | "SELL", entry: number, stop: number, target: number, allCandles: Candle[], idx: number, result: "TP" | "SL"): number {
  if (idx + 1 >= allCandles.length) return 0;
  const finBar = allCandles[idx + 1];
  const finalE = side === "BUY"
    ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
    : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
  let exitPrice = 0;
  const delta = finalE - entry;
  if (result === "TP") exitPrice = target + delta;
  else exitPrice = (stop + delta) + (side === "BUY" ? -1 : 1) * stop * SL_SLIPPAGE_FRAC;
  const move = side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
  let net = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
  if (net < -STAKE) net = -STAKE;
  return net;
}

async function main() {
  console.log(`CRASH300N side-bias check — Jan 1 2025 → today\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  console.log(`Fetching ${need} bars...`);
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  const days = candles.length * GR / 86400;
  console.log(`  ${candles.length} bars  (${days.toFixed(1)} days available)\n`);

  for (const side of ["BUY", "SELL"] as const) {
    const sigs = detectAndResolve(candles, side).filter((s) => candles[s.idx].epoch >= JAN_1_2025);
    let netSum = 0, wins = 0, losses = 0;
    for (const s of sigs) {
      const p = pnl(s.side, s.entry, s.stop, s.target, candles, s.idx, s.result);
      netSum += p;
      if (s.result === "TP") wins++; else losses++;
    }
    const wr = sigs.length > 0 ? wins / sigs.length : 0;
    const epd = sigs.length > 0 ? netSum / sigs.length : 0;
    console.log(`  ${side.padEnd(4)} (${side === "BUY" ? "fade down-spike" : "ride down-spike"}):`);
    console.log(`    trades=${sigs.length}  W=${wins}  L=${losses}  WR=${(wr*100).toFixed(1)}%  net=${netSum >= 0 ? "+" : ""}$${netSum.toFixed(2)}  per-trade=${epd >= 0 ? "+" : ""}$${epd.toFixed(3)}\n`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

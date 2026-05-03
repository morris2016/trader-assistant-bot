// BOOM 300N — can BUY-side trades add value? Test BUY-fade (fade rare down-spikes
// expecting bounce) at the new TP=1.5 setting found in the TP/SL sweep.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const STAKE = 3;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const ATR_PERIOD = 14;

const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.05;  // new optimum from sweep
const TP_FRAC = 1.5;       // new optimum from sweep

const SYM = "BOOM300N";
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

function simulate(candles: Candle[], side: "BUY" | "SELL", from: number, to: number) {
  let trades = 0, wins = 0, net = 0;
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    if (candles[i].epoch < from || candles[i].epoch >= to) continue;
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    let entry = 0, stop = 0, target = 0;
    if (side === "SELL") {
      if (!(spike.close > spike.open)) continue;
      if (!(confirm.close < spike.close)) continue;
      entry = confirm.close;
      stop = spike.high + BUFFER_ATR * a;
      target = entry - TP_FRAC * range;
    } else {
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close > spike.close)) continue;
      entry = confirm.close;
      stop = spike.low - BUFFER_ATR * a;
      target = entry + TP_FRAC * range;
    }
    if (target <= 0 || (side === "SELL" ? stop <= entry : stop >= entry)) continue;
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - entry;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null;
    let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (side === "BUY") {
        if (b.low <= stopAdj) { exit = "SL"; exitPrice = stopAdj - stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      } else {
        if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
      }
    }
    if (!exit) continue;
    const move = side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    if (exit === "TP") wins++;
    trades++;
    net += pnl;
  }
  return { trades, wins, net, epd: trades > 0 ? net / trades : 0 };
}

async function main() {
  console.log(`BOOM 300N both-sides test @ NEW optimum (spike 3.0 / buf 0.05 / TP 1.5×)\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`${candles.length} bars (${(candles.length * GR / 86400).toFixed(1)} days)\n`);

  const splitEpoch = JAN_1_2025 + Math.floor((TODAY - JAN_1_2025) * 0.7);

  for (const [tag, side] of [["SELL (fade up-spike, validated)", "SELL"], ["BUY (fade down-spike, NEW)", "BUY"]] as const) {
    const train = simulate(candles, side, JAN_1_2025, splitEpoch);
    const test = simulate(candles, side, splitEpoch, TODAY);
    console.log(`${tag}:`);
    console.log(`  TRAIN: ${train.trades}t  WR=${train.trades > 0 ? (train.wins/train.trades*100).toFixed(1) : 0}%  net=+$${train.net.toFixed(2)}  epd=+$${train.epd.toFixed(3)}`);
    console.log(`  TEST:  ${test.trades}t  WR=${test.trades > 0 ? (test.wins/test.trades*100).toFixed(1) : 0}%  net=+$${test.net.toFixed(2)}  epd=+$${test.epd.toFixed(3)}\n`);
  }

  // Combined: both sides
  const trS = simulate(candles, "SELL", JAN_1_2025, splitEpoch);
  const trB = simulate(candles, "BUY", JAN_1_2025, splitEpoch);
  const teS = simulate(candles, "SELL", splitEpoch, TODAY);
  const teB = simulate(candles, "BUY", splitEpoch, TODAY);
  const trCombined = { trades: trS.trades + trB.trades, wins: trS.wins + trB.wins, net: trS.net + trB.net };
  const teCombined = { trades: teS.trades + teB.trades, wins: teS.wins + teB.wins, net: teS.net + teB.net };
  console.log(`BOTH SIDES combined:`);
  console.log(`  TRAIN: ${trCombined.trades}t  WR=${(trCombined.wins/trCombined.trades*100).toFixed(1)}%  net=+$${trCombined.net.toFixed(2)}  epd=+$${(trCombined.net/trCombined.trades).toFixed(3)}`);
  console.log(`  TEST:  ${teCombined.trades}t  WR=${(teCombined.wins/teCombined.trades*100).toFixed(1)}%  net=+$${teCombined.net.toFixed(2)}  epd=+$${(teCombined.net/teCombined.trades).toFixed(3)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

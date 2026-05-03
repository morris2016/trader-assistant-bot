// BOOM 300N TP/SL parameter sweep — find combo with highest per-trade $.
// Sweeps spike threshold, SL buffer, TP fraction. Train/test split to find
// robust improvements (not curve-fit).

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const STAKE = 3;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const ATR_PERIOD = 14;

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

type Cfg = { spikeNatr: number; bufferAtr: number; tpFrac: number };
type Out = { cfg: Cfg; trades: number; wins: number; net: number; epd: number };

function simulate(candles: Candle[], cfg: Cfg, fromEpoch: number, toEpoch: number): Out {
  let trades = 0, wins = 0, net = 0;
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    if (candles[i].epoch < fromEpoch || candles[i].epoch >= toEpoch) continue;
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < cfg.spikeNatr * a) continue;
    const confirm = candles[i];
    if (!(spike.close > spike.open)) continue;
    if (!(confirm.close < spike.close)) continue;
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1];
    const finalE = confirm.close - confirm.close * ENTRY_SPREAD_FRAC;
    const stop = spike.high + cfg.bufferAtr * a;
    const target = confirm.close - cfg.tpFrac * range;
    if (target <= 0 || stop <= confirm.close) continue;
    const delta = finalE - confirm.close;
    const stopAdj = stop + delta;
    const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null;
    let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    net += pnl;
    if (exit === "TP") wins++;
    trades++;
  }
  return { cfg, trades, wins, net, epd: trades > 0 ? net / trades : 0 };
}

async function main() {
  console.log(`BOOM 300N TP/SL parameter sweep — Jan 1 2025 → today\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  console.log(`Fetching ${need} bars...`);
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`  ${candles.length} bars (${(candles.length * GR / 86400).toFixed(1)} days)\n`);

  // 70/30 chronological split
  const splitEpoch = JAN_1_2025 + Math.floor((TODAY - JAN_1_2025) * 0.7);
  console.log(`Train: Jan 1 → ${new Date(splitEpoch * 1000).toISOString().slice(0,10)}`);
  console.log(`Test:  ${new Date(splitEpoch * 1000).toISOString().slice(0,10)} → today\n`);

  const SPIKE_NS = [2.5, 3.0, 3.5, 4.0];
  const BUFFER_AS = [0.05, 0.1, 0.2, 0.3];
  const TP_FS = [0.3, 0.5, 0.7, 1.0, 1.5];

  const results: Array<{ cfg: Cfg; train: Out; test: Out }> = [];
  for (const sn of SPIKE_NS) {
    for (const ba of BUFFER_AS) {
      for (const tf of TP_FS) {
        const cfg = { spikeNatr: sn, bufferAtr: ba, tpFrac: tf };
        const train = simulate(candles, cfg, JAN_1_2025, splitEpoch);
        const test = simulate(candles, cfg, splitEpoch, TODAY);
        results.push({ cfg, train, test });
      }
    }
  }

  // Baseline (current production: 3.0/0.2/0.5)
  const baseline = results.find((r) => r.cfg.spikeNatr === 3.0 && r.cfg.bufferAtr === 0.2 && r.cfg.tpFrac === 0.5)!;
  console.log(`Baseline (production: 3.0×ATR / 0.2 buf / 0.5 TP):`);
  console.log(`  TRAIN: ${baseline.train.trades}t  WR=${(baseline.train.wins/baseline.train.trades*100).toFixed(1)}%  net=+$${baseline.train.net.toFixed(2)}  epd=+$${baseline.train.epd.toFixed(3)}`);
  console.log(`  TEST:  ${baseline.test.trades}t  WR=${(baseline.test.wins/baseline.test.trades*100).toFixed(1)}%  net=+$${baseline.test.net.toFixed(2)}  epd=+$${baseline.test.epd.toFixed(3)}\n`);

  // Sort by TEST epd desc (out-of-sample per-trade $)
  results.sort((a, b) => b.test.epd - a.test.epd);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`TOP 15 BY TEST EPD (out-of-sample per-trade $)`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  spk  buf  tpf      TRAIN: trades  WR    epd       TEST: trades  WR    epd       TEST netΔ`);
  for (const r of results.slice(0, 15)) {
    const trWR = r.train.wins / r.train.trades * 100;
    const teWR = r.test.wins / r.test.trades * 100;
    const flag = r.test.epd > baseline.test.epd ? " ★" : "";
    console.log(`  ${r.cfg.spikeNatr.toFixed(1)}  ${r.cfg.bufferAtr.toFixed(2)} ${r.cfg.tpFrac.toFixed(1)}        ${String(r.train.trades).padStart(4)}  ${trWR.toFixed(1).padStart(4)}%  +$${r.train.epd.toFixed(3)}      ${String(r.test.trades).padStart(4)}  ${teWR.toFixed(1).padStart(4)}%  +$${r.test.epd.toFixed(3)}     +$${r.test.net.toFixed(2)}${flag}`);
  }

  // Sort by TEST total net desc
  results.sort((a, b) => b.test.net - a.test.net);
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`TOP 15 BY TEST TOTAL NET $`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  spk  buf  tpf      TRAIN: trades  WR    net          TEST: trades  WR    net         epd`);
  for (const r of results.slice(0, 15)) {
    const trWR = r.train.wins / r.train.trades * 100;
    const teWR = r.test.wins / r.test.trades * 100;
    const flag = r.test.net > baseline.test.net ? " ★" : "";
    console.log(`  ${r.cfg.spikeNatr.toFixed(1)}  ${r.cfg.bufferAtr.toFixed(2)} ${r.cfg.tpFrac.toFixed(1)}        ${String(r.train.trades).padStart(4)}  ${trWR.toFixed(1).padStart(4)}%  +$${r.train.net.toFixed(0).padStart(4)}        ${String(r.test.trades).padStart(4)}  ${teWR.toFixed(1).padStart(4)}%  +$${r.test.net.toFixed(2).padStart(7)}    +$${r.test.epd.toFixed(3)}${flag}`);
  }

  // Robust filter: BOTH train and test must beat baseline
  const robust = results.filter((r) => r.train.epd > baseline.train.epd && r.test.epd > baseline.test.epd && r.test.trades >= 100);
  robust.sort((a, b) => (b.train.epd + b.test.epd) - (a.train.epd + a.test.epd));
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`ROBUST CANDIDATES (beat baseline in BOTH train AND test, ≥100 OOS trades) — sorted by combined epd`);
  console.log(`${"".padEnd(110, "═")}`);
  if (robust.length === 0) {
    console.log(`  none — no config beats baseline OOS in per-trade $.`);
  } else {
    for (const r of robust) {
      console.log(`  spike≥${r.cfg.spikeNatr.toFixed(1)}×ATR  buf=${r.cfg.bufferAtr.toFixed(2)}×ATR  TP=${r.cfg.tpFrac.toFixed(1)}×spike   TRAIN: ${r.train.trades}t epd=+$${r.train.epd.toFixed(3)}   TEST: ${r.test.trades}t epd=+$${r.test.epd.toFixed(3)}   total test net=+$${r.test.net.toFixed(2)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

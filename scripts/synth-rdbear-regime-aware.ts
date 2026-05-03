// RDBEAR breakout 5m — REGIME-AWARE state machine.
// Higher-timeframe SMA (12 bars on 5m = 1h smoothed) determines regime:
//   • Price above SMA AND SMA rising  → BULL regime → take BUY breakouts only
//   • Price below SMA AND SMA falling → BEAR regime → take SELL breakouts only
//   • Mixed / flat slope              → NEUTRAL → take both (trend forming)
// Plus an ADX gate: skip signals when ADX is below `minAdx` (chop filter).
// Pairs with static martingale 1.7× × 3L on a $100 account.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE = Number(process.env.STAKE ?? 10);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 100);
const HTF_SMA_PERIOD = Number(process.env.HTF_SMA ?? 12); // 12×5m = 1h
const SLOPE_BARS = Number(process.env.SLOPE_BARS ?? 6);    // slope over last 30m
const MIN_ADX = Number(process.env.MIN_ADX ?? 22);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAY_OFFSET = Number(process.env.DAY_OFFSET ?? 4);
const START_HOUR = Number(process.env.START_HOUR ?? 0);
const END_HOUR = Number(process.env.END_HOUR ?? 48);
const TARGET_DAY_START = TODAY_START - DAY_OFFSET * 86400;
const ws = TARGET_DAY_START + START_HOUR * 3600;
const we = TARGET_DAY_START + END_HOUR * 3600;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number };
const VARIANTS: Variant[] = [
  { name: "lb15 kAtr2.0 momR0.70", lookback: 15, kAtr: 2.0, momRatio: 0.70 },
  { name: "lb15 kAtr2.5 momR0.70", lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { name: "lb20 kAtr2.5 momR0.70", lookback: 20, kAtr: 2.5, momRatio: 0.70 },
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

function atr(c: Candle[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

function sma(c: Candle[], i: number, period: number): number {
  if (i < period - 1) return NaN;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) s += c[j].close;
  return s / period;
}

// Wilder's ADX, simplified.
function adx(c: Candle[], i: number, period = 14): number {
  if (i < period * 2) return 0;
  let plusDM = 0, minusDM = 0, tr = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const upMove = c[j].high - c[j - 1].high;
    const dnMove = c[j - 1].low - c[j].low;
    const pdm = upMove > dnMove && upMove > 0 ? upMove : 0;
    const ndm = dnMove > upMove && dnMove > 0 ? dnMove : 0;
    plusDM += pdm; minusDM += ndm;
    tr += Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
  }
  if (tr === 0) return 0;
  const plusDI = (plusDM / tr) * 100;
  const minusDI = (minusDM / tr) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
  return dx;
}

type Regime = "BULL" | "BEAR" | "NEUTRAL";
function detectRegime(c: Candle[], i: number): Regime {
  const smaNow = sma(c, i, HTF_SMA_PERIOD);
  const smaPrev = sma(c, i - SLOPE_BARS, HTF_SMA_PERIOD);
  if (!isFinite(smaNow) || !isFinite(smaPrev)) return "NEUTRAL";
  const slope = smaNow - smaPrev;
  const price = c[i].close;
  // Both confirmation: price-vs-SMA AND slope sign.
  if (price > smaNow && slope > 0) return "BULL";
  if (price < smaNow && slope < 0) return "BEAR";
  return "NEUTRAL";
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number; regime: Regime };
function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  const atrPeriod = 14;
  for (let i = Math.max(v.lookback, atrPeriod, HTF_SMA_PERIOD + SLOPE_BARS) + 1; i < candles.length; i++) {
    const a = atr(candles, i, atrPeriod);
    if (a <= 0) continue;
    const ad = adx(candles, i, 14);
    if (ad < MIN_ADX) continue; // chop filter
    let hi = -Infinity, lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = v.kAtr * a;
    const regime = detectRegime(candles, i);

    // REGIME_MODE:
    //   "WITH"    = take breakouts only WITH regime (BUY in BULL, SELL in BEAR)
    //   "AGAINST" = take FADE breakouts (SELL signal in BULL regime, BUY in BEAR)
    //   "BOTH"    = no regime filter, take all breakouts in their natural direction
    const REGIME_MODE = (process.env.REGIME_MODE ?? "WITH") as "WITH" | "AGAINST" | "BOTH";
    if (cur.close > hi && closePosUp >= v.momRatio) {
      let side: "BUY" | "SELL" = "BUY";
      if (REGIME_MODE === "WITH" && regime === "BEAR") continue;
      if (REGIME_MODE === "AGAINST") {
        // Upward breakout in BULL regime is "extension" — fade it (SELL).
        // In BEAR regime — likely false breakout — also fade (SELL).
        // In NEUTRAL — no clear bias, take with the breakout.
        if (regime === "BULL" || regime === "BEAR") side = "SELL";
      }
      const stop = side === "BUY" ? cur.close - dist : cur.close + dist;
      const target = side === "BUY" ? cur.close + dist : cur.close - dist;
      out.push({ idx: i, side, entry: cur.close, stop, target, regime });
    } else if (cur.close < lo && closePosDn >= v.momRatio) {
      let side: "BUY" | "SELL" = "SELL";
      if (REGIME_MODE === "WITH" && regime === "BULL") continue;
      if (REGIME_MODE === "AGAINST") {
        // Downward breakout in BEAR regime — fade (BUY) expecting bounce.
        if (regime === "BULL" || regime === "BEAR") side = "BUY";
      }
      const stop = side === "BUY" ? cur.close - dist : cur.close + dist;
      const target = side === "BUY" ? cur.close + dist : cur.close - dist;
      out.push({ idx: i, side, entry: cur.close, stop, target, regime });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { sigT: string; closeT: string; side: "BUY" | "SELL"; regime: Regime; level: number; stake: number; exit: "tp" | "sl"; net: number; bal: number };

function honestSim(candles: Candle[], v: Variant) {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  const trades: Trade[] = [];
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let peak = ACCT;
  let trough = ACCT;
  let buyCount = 0, sellCount = 0;
  const regimeCounts: Record<Regime, number> = { BULL: 0, BEAR: 0, NEUTRAL: 0 };

  for (const sig of sigs) {
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) continue;

    const finBar = candles[sig.idx + 1];
    const finalE = sig.side === "BUY"
      ? finBar.open + finBar.open * ENTRY_SPREAD_FRAC
      : finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    let exitEpoch = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (sig.side === "BUY") {
        if (b.low <= stop) { exit = "sl"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; exitEpoch = b.epoch; break; }
        if (b.high >= target) { exit = "tp"; exitPrice = target; exitEpoch = b.epoch; break; }
      } else {
        if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; exitEpoch = b.epoch; break; }
        if (b.low <= target) { exit = "tp"; exitPrice = target; exitEpoch = b.epoch; break; }
      }
    }
    if (!exit) continue;
    const move = sig.side === "BUY" ? (exitPrice - finalE) / finalE : (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (balance < trough) trough = balance;
    const tradeLevel = martLevel;
    if (exit === "tp") martLevel = 0;
    else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; }
    if (sig.side === "BUY") buyCount++; else sellCount++;
    regimeCounts[sig.regime]++;
    trades.push({
      sigT: new Date(candles[sig.idx].epoch * 1000).toISOString().slice(11, 19),
      closeT: new Date(exitEpoch * 1000).toISOString().slice(11, 19),
      side: sig.side, regime: sig.regime, level: tradeLevel, stake, exit, net, bal: balance,
    });
  }
  return { trades, bust, finalBal: balance, peak, trough, buyCount, sellCount, regimeCounts };
}

async function main() {
  const dateStr = new Date(TARGET_DAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST sim — RDBEAR breakout 5m  REGIME-AWARE + MART ${MART}× × ${MAX_LEVELS}L`);
  console.log(`${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  (${(END_HOUR-START_HOUR)}h)`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MULT=${MULT}×  HTF_SMA=${HTF_SMA_PERIOD}×5m  slope-bars=${SLOPE_BARS}  minAdx=${MIN_ADX}\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  variant                   trades  B/S      regimes(BULL/BEAR/NEU)  W/L     WR     final   Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const r = honestSim(candles, v);
    const wins = r.trades.filter((t) => t.net > 0).length;
    const losses = r.trades.filter((t) => t.net < 0).length;
    const wr = r.trades.length > 0 ? wins / r.trades.length : 0;
    const status = r.bust ? "💀 BUST" : "✓";
    const dPct = ((r.finalBal - ACCT) / ACCT * 100).toFixed(0);
    const reg = `${r.regimeCounts.BULL}/${r.regimeCounts.BEAR}/${r.regimeCounts.NEUTRAL}`;
    console.log(`  ${v.name.padEnd(24)}  ${String(r.trades.length).padStart(3)}t  ${String(r.buyCount).padStart(3)}/${String(r.sellCount).padStart(3)}  ${reg.padStart(10)}              ${wins}W/${losses}L   ${(wr*100).toFixed(0).padStart(2)}%  $${r.finalBal.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

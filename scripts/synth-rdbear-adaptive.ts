// RDBEAR breakout 5m — ADAPTIVE regime mode-switcher.
// Smoothed ADX picks the trade direction posture per signal:
//   • smoothedADX ≥ ADX_TREND_HIGH → "trending" regime → WITH mode (trade with breakout)
//   • smoothedADX ≤ ADX_CHOP_LOW   → "chop" regime    → AGAINST mode (fade breakout)
//   • in between → previous mode (hysteresis to prevent whipsawing)
//
// Combined with HTF SMA regime detection: regime decides BULL/BEAR/NEUTRAL,
// adaptive mode decides WITH/AGAINST. NEUTRAL always trades natural breakout
// direction regardless of mode.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE = Number(process.env.STAKE ?? 10);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 100);
const HTF_SMA_PERIOD = Number(process.env.HTF_SMA ?? 12);
const SLOPE_BARS = Number(process.env.SLOPE_BARS ?? 6);
const MIN_ADX = Number(process.env.MIN_ADX ?? 22);
// Adaptive thresholds. Hysteresis: ADX_TREND_HIGH > ADX_CHOP_LOW.
const ADX_SMOOTH_BARS = Number(process.env.ADX_SMOOTH ?? 20);
const ADX_TREND_HIGH = Number(process.env.ADX_TREND_HIGH ?? 30);
const ADX_CHOP_LOW = Number(process.env.ADX_CHOP_LOW ?? 25);
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
  return Math.abs(plusDI - minusDI) / (plusDI + minusDI || 1) * 100;
}

function smoothedAdx(c: Candle[], i: number, smoothBars: number): number {
  if (i < smoothBars) return adx(c, i);
  let sum = 0, count = 0;
  for (let j = i - smoothBars + 1; j <= i; j++) {
    sum += adx(c, j);
    count++;
  }
  return sum / count;
}

type Regime = "BULL" | "BEAR" | "NEUTRAL";
function detectRegime(c: Candle[], i: number): Regime {
  const smaNow = sma(c, i, HTF_SMA_PERIOD);
  const smaPrev = sma(c, i - SLOPE_BARS, HTF_SMA_PERIOD);
  if (!isFinite(smaNow) || !isFinite(smaPrev)) return "NEUTRAL";
  const slope = smaNow - smaPrev;
  const price = c[i].close;
  if (price > smaNow && slope > 0) return "BULL";
  if (price < smaNow && slope < 0) return "BEAR";
  return "NEUTRAL";
}

type AdaptiveMode = "WITH" | "AGAINST";

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number; regime: Regime; mode: AdaptiveMode; smoothedAdx: number };

function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  const atrPeriod = 14;
  let currentMode: AdaptiveMode = "AGAINST"; // default until ADX confirms trending

  for (let i = Math.max(v.lookback, atrPeriod * 2, HTF_SMA_PERIOD + SLOPE_BARS, ADX_SMOOTH_BARS) + 1; i < candles.length; i++) {
    const a = atr(candles, i, atrPeriod);
    if (a <= 0) continue;
    const adNow = adx(candles, i, 14);
    if (adNow < MIN_ADX) continue;

    const adSmoothed = smoothedAdx(candles, i, ADX_SMOOTH_BARS);
    // Update adaptive mode with hysteresis
    if (adSmoothed >= ADX_TREND_HIGH) currentMode = "WITH";
    else if (adSmoothed <= ADX_CHOP_LOW) currentMode = "AGAINST";
    // else keep previous mode

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

    if (cur.close > hi && closePosUp >= v.momRatio) {
      let side: "BUY" | "SELL" = "BUY";
      if (currentMode === "WITH") {
        if (regime === "BEAR") continue; // skip counter-regime in trending mode
      } else {
        // AGAINST: fade BULL/BEAR regimes
        if (regime === "BULL" || regime === "BEAR") side = "SELL";
      }
      const stop = side === "BUY" ? cur.close - dist : cur.close + dist;
      const target = side === "BUY" ? cur.close + dist : cur.close - dist;
      out.push({ idx: i, side, entry: cur.close, stop, target, regime, mode: currentMode, smoothedAdx: adSmoothed });
    } else if (cur.close < lo && closePosDn >= v.momRatio) {
      let side: "BUY" | "SELL" = "SELL";
      if (currentMode === "WITH") {
        if (regime === "BULL") continue;
      } else {
        if (regime === "BULL" || regime === "BEAR") side = "BUY";
      }
      const stop = side === "BUY" ? cur.close - dist : cur.close + dist;
      const target = side === "BUY" ? cur.close + dist : cur.close - dist;
      out.push({ idx: i, side, entry: cur.close, stop, target, regime, mode: currentMode, smoothedAdx: adSmoothed });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], v: Variant) {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let peak = ACCT;
  let trough = ACCT;
  let buyCount = 0, sellCount = 0;
  const modeCounts = { WITH: 0, AGAINST: 0 };
  let trades = 0, wins = 0, losses = 0;

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
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (sig.side === "BUY") {
        if (b.low <= stop) { exit = "sl"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; break; }
        if (b.high >= target) { exit = "tp"; exitPrice = target; break; }
      } else {
        if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
        if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
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
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    if (sig.side === "BUY") buyCount++; else sellCount++;
    modeCounts[sig.mode]++;
    trades++;
  }
  return { trades, wins, losses, bust, finalBal: balance, peak, trough, buyCount, sellCount, modeCounts };
}

async function main() {
  const dateStr = new Date(TARGET_DAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST sim — RDBEAR breakout 5m  ADAPTIVE (ADX-gated WITH/AGAINST switch)`);
  console.log(`${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  (${(END_HOUR-START_HOUR)}h)`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  HTF_SMA=${HTF_SMA_PERIOD}×5m`);
  console.log(`ADX smooth=${ADX_SMOOTH_BARS}  trend≥${ADX_TREND_HIGH} (WITH)  chop≤${ADX_CHOP_LOW} (AGAINST)  minAdx=${MIN_ADX}\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  variant                   trades  B/S   WITH/AGN   W/L     WR     final     Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const r = honestSim(candles, v);
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const status = r.bust ? "💀 BUST" : "✓";
    const dPct = ((r.finalBal - ACCT) / ACCT * 100).toFixed(0);
    const modes = `${r.modeCounts.WITH}/${r.modeCounts.AGAINST}`;
    console.log(`  ${v.name.padEnd(24)}  ${String(r.trades).padStart(3)}t  ${String(r.buyCount).padStart(3)}/${String(r.sellCount).padStart(3)}   ${modes.padEnd(8)}  ${r.wins}W/${r.losses}L   ${(wr*100).toFixed(0).padStart(2)}%  $${r.finalBal.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${status}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

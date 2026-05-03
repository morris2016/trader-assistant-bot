// RDBEAR mean-rev — TODAY ONLY (UTC). Trade-by-trade ledger for the current
// UTC day, with all the validated parameters and $200/$30/1.7× sizing.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = 200;
const BASE_STAKE = 30;
const MART = 1.7;
const MAX_LEVELS = 3;
const PER_TRADE_CAP = 200;
const DD_FRAC = 0.60;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const MIN_ADX = 22;
const EFF_WINDOW = 24;
const CHOP_THRESH = 0.30;
const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.70;

const SYM = "RDBEAR";
const GR = 300;

const NOW = Math.floor(Date.now() / 1000);
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
// Use top of current hour as the upper bound — last fully closed bar.
const FETCH_END = Math.floor(NOW / 3600) * 3600;

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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000);
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

function efficiency(c: Candle[], i: number, window: number): number {
  if (i < window) return 0;
  const netMove = Math.abs(c[i].close - c[i - window].close);
  let sumAbs = 0;
  for (let j = i - window + 1; j <= i; j++) sumAbs += Math.abs(c[j].close - c[j - 1].close);
  return sumAbs > 0 ? netMove / sumAbs : 0;
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(LOOKBACK, 28, EFF_WINDOW) + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    const ad = adx(candles, i, 14);
    if (ad < MIN_ADX) continue;
    const eff = efficiency(candles, i, EFF_WINDOW);
    if (eff >= CHOP_THRESH) continue;
    let hi = -Infinity, lo = Infinity;
    for (let m = i - LOOKBACK; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = KATR * a;
    const SELL_ONLY = (process.env.SELL_ONLY ?? "0") === "1";
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    } else if (cur.close < lo && closePosDn >= MOM_RATIO) {
      if (SELL_ONLY) continue;
      out.push({ idx: i, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

async function main() {
  const dateStr = new Date(TODAY_START * 1000).toISOString().slice(0, 10);
  const cutoffStr = new Date(FETCH_END * 1000).toISOString().slice(11, 19);
  console.log(`RDBEAR mean-rev — TODAY (${dateStr} UTC, 00:00 → ${cutoffStr})`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}  DD-pause=${(DD_FRAC*100).toFixed(0)}%`);
  console.log(`Strategy: lb=${LOOKBACK} kAtr=${KATR} momR=${MOM_RATIO}  chop=${CHOP_THRESH}  minAdx=${MIN_ADX}\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, FETCH_END);
  c.close();
  const days = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
  console.log(`Fetched ${candles.length} bars (${days.toFixed(1)}d warmup)\n`);

  const sigs = detect(candles).filter((s) => candles[s.idx].epoch >= TODAY_START && candles[s.idx].epoch < FETCH_END);
  if (sigs.length === 0) {
    console.log("No signals fired today yet.");
    return;
  }

  let balance = ACCT;
  let martLevel = 0;
  let bust = false, ddPaused = false;
  let peak = ACCT;
  type Trade = { sigT: string; closeT: string; side: string; level: number; stake: number; exit: string; net: number; bal: number; dd: number };
  const trades: Trade[] = [];

  for (const sig of sigs) {
    if (ddPaused) break;
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
    const tradeLevel = martLevel;
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    const dd = peak > 0 ? (peak - balance) / peak : 0;
    if (exit === "tp") martLevel = 0; else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; }
    trades.push({
      sigT: new Date(candles[sig.idx].epoch * 1000).toISOString().slice(11, 19),
      closeT: new Date(exitEpoch * 1000).toISOString().slice(11, 19),
      side: sig.side, level: tradeLevel, stake, exit, net, bal: balance, dd,
    });
    if (DD_FRAC > 0 && dd >= DD_FRAC) { ddPaused = true; break; }
  }

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${"sigT".padEnd(8)}  ${"closeT".padEnd(8)}  side  L  stake   exit  ${"net".padStart(8)}  ${"balance".padStart(8)}  DD%`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const t of trades) {
    const tag = t.exit === "tp" ? "WON" : "LOST";
    console.log(`  ${t.sigT}  ${t.closeT}  ${t.side.padEnd(4)}  ${t.level}  $${t.stake.toFixed(2).padStart(5)}  ${tag}  ${(t.net >= 0 ? "+" : "") + "$" + t.net.toFixed(2).padStart(7)}    $${t.bal.toFixed(2).padStart(7)}  ${(t.dd*100).toFixed(0).padStart(3)}%`);
  }

  const wins = trades.filter((t) => t.net > 0).length;
  const losses = trades.filter((t) => t.net < 0).length;
  const wr = trades.length > 0 ? wins / trades.length : 0;
  const status = bust ? "💀 BUST" : ddPaused ? "⏸ DD-paused" : "✓ open";
  const finalBal = trades.length > 0 ? trades[trades.length - 1].bal : ACCT;
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${status}  ${trades.length}t · ${wins}W/${losses}L · WR ${(wr*100).toFixed(0)}%`);
  console.log(`  Started $${ACCT} → ended $${finalBal.toFixed(2)} (${finalBal > ACCT ? "+" : ""}${((finalBal-ACCT)/ACCT*100).toFixed(1)}%)`);
  console.log(`  Peak $${peak.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

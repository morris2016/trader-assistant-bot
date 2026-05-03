// Verify: RDBEAR with regime filters REMOVED — take every breakout signal.
// Strips effChopThresh and minAdx gates from the detector. Daily survival
// study Dec 1 2025 → today. Compare against filtered baseline (+$16,426).

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = 200;
const BASE_STAKE = 30;
const MART = 1.7;
const MAX_LEVELS = 3;
const PER_TRADE_CAP = 100;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;
const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
// REGIME FILTERS REMOVED:
// const EFF_WINDOW = 24;  const CHOP_THRESH = 0.30;  const MIN_ADX = 22;

const SYM = "RDBEAR";
const GR = 300;

const DEC_1 = Math.floor(Date.UTC(2025, 11, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAYS = Math.floor((TODAY - DEC_1) / 86400);

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

type Sig = { idx: number; side: "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  for (let i = LOOKBACK + 14 + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    // NO ADX gate, NO efficiency gate — just the breakout pattern
    let hi = -Infinity;
    for (let m = i - LOOKBACK; m < i; m++) if (candles[m].high > hi) hi = candles[m].high;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const dist = KATR * a;
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], ws: number, we: number) {
  const sigs = detect(candles).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;
  for (const sig of sigs) {
    if (bust || ddPaused) break;
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; break; }
    if (sig.idx + 1 >= candles.length) continue;
    const finBar = candles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance };
}

async function main() {
  console.log(`RDBEAR NO-REGIME study — ${DAYS} days (Dec 1 2025 → today)`);
  console.log(`Filters STRIPPED: no minAdx, no effChopThresh — every breakout fires\n`);

  const c = new C(); await c.ready;
  let totalNet = 0, w = 0, l = 0, dd = 0, bust = 0, noTrade = 0, totalTrades = 0, totalWins = 0;
  for (let d = 0; d < DAYS; d++) {
    const dayStart = DEC_1 + d * 86400;
    const dayEnd = dayStart + 86400;
    let candles: Candle[] | null = null;
    try { candles = await fetchPaged(c, SYM, GR, 600, dayEnd); }
    catch { continue; }
    const r = honestSim(candles, dayStart, dayEnd);
    totalNet += r.finalBal - ACCT;
    totalTrades += r.trades;
    totalWins += r.wins;
    if (r.bust) bust++;
    else if (r.ddPaused) dd++;
    else if (r.trades === 0) noTrade++;
    else if (r.finalBal >= ACCT) w++;
    else l++;
    if ((d + 1) % 30 === 0) {
      process.stdout.write(`  d${d+1}/${DAYS}: W=${w} DD=${dd} totalΔ=${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(0)}\n`);
    }
  }
  c.close();

  const wr = totalTrades > 0 ? totalWins / totalTrades : 0;
  console.log(`\nSUMMARY: ${DAYS} days · ${w}W ${l}L ${dd}DD ${bust}BUST ${noTrade}—  totalΔ=$${totalNet.toFixed(2)}`);
  console.log(`Trades: ${totalTrades} (${(totalTrades/DAYS).toFixed(1)}/day)  WR: ${(wr*100).toFixed(1)}%`);
  console.log(`\nVS FILTERED baseline +$16,425.73 (97W/7L/48DD/0BUST):  diff=${totalNet >= 16425.73 ? "+" : ""}$${(totalNet - 16425.73).toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

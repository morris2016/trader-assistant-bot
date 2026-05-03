// RDBEAR mean-rev-only — daily survival study from Jan 1 through today.
// Each UTC day is an independent $200 account; tally daily survive/paused/bust.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 200);
const BASE_STAKE = Number(process.env.STAKE ?? 30);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 200);
const DD_FRAC = Number(process.env.DD_FRAC ?? 0.60);
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

// Date window: Jan 1 (current year) → today UTC midnight.
const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const JAN1_START = Math.floor(Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);

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
    process.stdout.write(`.`);
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

function honestSim(candles: Candle[], allSigs: Sig[], ws: number, we: number) {
  const sigs = allSigs.filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;

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
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance };
}

async function main() {
  const totalDays = Math.floor((TODAY_START - JAN1_START) / 86400);
  const totalBarsNeeded = totalDays * 288 + 200; // 5m bars/day + warmup
  console.log(`RDBEAR mean-rev daily survival study — Jan 1 → today (${totalDays} days)`);
  console.log(`ACCT=$${ACCT}/day  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}  DD-pause=${(DD_FRAC*100).toFixed(0)}%`);
  console.log(`Strategy: lb=${LOOKBACK} kAtr=${KATR} momR=${MOM_RATIO}  chop=${CHOP_THRESH}  minAdx=${MIN_ADX}\n`);
  process.stdout.write(`Fetching ${totalBarsNeeded} bars`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, totalBarsNeeded, TODAY_START);
  c.close();
  console.log(`\nFetched ${candles.length} bars (${new Date(candles[0].epoch * 1000).toISOString().slice(0,10)} → ${new Date(candles[candles.length-1].epoch * 1000).toISOString().slice(0,10)})\n`);

  // Pre-compute all signals once (much faster than re-running detector per day).
  process.stdout.write(`Computing signals...`);
  const allSigs = detect(candles);
  console.log(` ${allSigs.length} candidate signals across full range\n`);

  // Iterate day by day
  let dSurvive = 0, dPaused = 0, dBust = 0, dNoTrade = 0;
  let totalReturn = 0;
  let totalTrades = 0, totalWins = 0, totalLosses = 0;
  const monthly: Record<string, { d: number; sv: number; ps: number; bs: number; ret: number }> = {};

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  date         trades  W/L     WR    final     Δ$      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (let day = 0; day < totalDays; day++) {
    const ws = JAN1_START + day * 86400;
    const we = ws + 86400;
    const dateStr = new Date(ws * 1000).toISOString().slice(0, 10);
    const month = dateStr.slice(0, 7);
    if (!monthly[month]) monthly[month] = { d: 0, sv: 0, ps: 0, bs: 0, ret: 0 };
    monthly[month].d++;

    const r = honestSim(candles, allSigs, ws, we);
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const delta = r.finalBal - ACCT;
    totalReturn += delta;
    totalTrades += r.trades; totalWins += r.wins; totalLosses += r.losses;

    let status: string;
    if (r.bust) { status = "💀 BUST"; dBust++; monthly[month].bs++; }
    else if (r.ddPaused) { status = "⏸ DD-paused"; dPaused++; monthly[month].ps++; }
    else if (r.trades === 0) { status = "—"; dNoTrade++; }
    else if (delta >= 0) { status = "✓"; dSurvive++; monthly[month].sv++; }
    else { status = "↓ down"; dSurvive++; monthly[month].sv++; } // survived but down on day
    monthly[month].ret += delta;

    if (r.trades > 0 || r.bust || r.ddPaused) {
      console.log(`  ${dateStr}    ${String(r.trades).padStart(2)}t   ${r.wins}W/${r.losses}L   ${(wr*100).toFixed(0).padStart(2)}%  $${r.finalBal.toFixed(2).padStart(7)}  ${delta >= 0 ? "+" : ""}$${delta.toFixed(2).padStart(7)}  ${status}`);
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY (${totalDays} days, Jan 1 → ${new Date((TODAY_START - 86400) * 1000).toISOString().slice(0,10)})`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ✓ Survived (made money or break-even):  ${dSurvive}/${totalDays} (${(dSurvive/totalDays*100).toFixed(1)}%)`);
  console.log(`  ⏸ DD-paused (capped loss at 60%):       ${dPaused}/${totalDays} (${(dPaused/totalDays*100).toFixed(1)}%)`);
  console.log(`  💀 Bust:                                ${dBust}/${totalDays} (${(dBust/totalDays*100).toFixed(1)}%)`);
  console.log(`  — No trades fired:                       ${dNoTrade}/${totalDays} (${(dNoTrade/totalDays*100).toFixed(1)}%)`);
  console.log(`\n  Total trades: ${totalTrades}  ·  W/L: ${totalWins}/${totalLosses}  ·  WR: ${totalTrades > 0 ? (totalWins/totalTrades*100).toFixed(1) : "—"}%`);
  console.log(`  Total return summed across days: ${totalReturn >= 0 ? "+" : ""}$${totalReturn.toFixed(2)}`);
  console.log(`  Avg return per day: ${totalReturn >= 0 ? "+" : ""}$${(totalReturn/totalDays).toFixed(2)}`);

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`MONTHLY BREAKDOWN`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  month     days  survive  paused  bust   net Δ$`);
  for (const [m, s] of Object.entries(monthly)) {
    console.log(`  ${m}    ${String(s.d).padStart(3)}  ${String(s.sv).padStart(3)} (${(s.sv/s.d*100).toFixed(0)}%)  ${String(s.ps).padStart(3)}  ${String(s.bs).padStart(3)}   ${s.ret >= 0 ? "+" : ""}$${s.ret.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

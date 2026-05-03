// BOOM/CRASH 300N spike-fade — sweep mart factors to find one that actually
// recovers losses on a win.
//
// The math: per-trade win = 0.49×stake (TP 50% spike, after commission).
// Per-trade loss = -1.0×stake (full SL after slippage). Cumulative loss after
// L levels then win at level L:
//
//   Net = S × [m^L × (0.49m - 1.49) + 1] / (m - 1)
//
// For Net ≥ 0 asymptotically, need 0.49m - 1.49 ≥ 0  →  m ≥ 3.04
//   m=1.7:  recovery LOSES on any L≥1
//   m=2.2:  recovery LOSES on any L≥1 (current setting)
//   m=3.0:  recovery ~breakeven on chain (no profit)
//   m=3.5:  recovery PROFITS — but stakes balloon: $1×3.5^4 = $150 by lvl 4
//   m=4.0:  bigger profit, faster bust
//
// This script simulates m ∈ {2.0, 2.5, 3.0, 3.5, 4.0} on the validated
// BOOM/CRASH 300N spike-fade across 5 windows. Track: net P&L, bust count,
// largest single-chain damage, max drawdown.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const PER_TRADE_CAP = Number(process.env.CAP ?? 49);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;

const SPIKE_NATR = 3.0;
const BUFFER_ATR = 0.2;
const TP_FRAC_OF_SPIKE = 0.5;
const ATR_PERIOD = 14;

const ASSETS = [
  { sym: "BOOM300N",  side: "SELL" as const },
  { sym: "CRASH300N", side: "BUY"  as const },
];

const MART_FACTORS = [2.0, 2.5, 3.0, 3.5, 4.0];

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

const WINDOWS = [
  { offset: 4, startH: 0, endH: 24, label: "4d" },
  { offset: 7, startH: 8, endH: 32, label: "7d" },
  { offset: 12, startH: 20, endH: 44, label: "12d" },
  { offset: 20, startH: 4, endH: 28, label: "20d" },
  { offset: 25, startH: 16, endH: 40, label: "25d" },
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

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], side: "BUY" | "SELL"): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const spike = candles[i - 1];
    const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    if (side === "SELL") {
      if (!(spike.close > spike.open)) continue;
      if (!(confirm.close < spike.close)) continue;
      const entry = confirm.close;
      const stop = spike.high + BUFFER_ATR * a;
      const target = entry - TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop <= entry) continue;
      out.push({ idx: i, side: "SELL", entry, stop, target });
    } else {
      if (!(spike.close < spike.open)) continue;
      if (!(confirm.close > spike.close)) continue;
      const entry = confirm.close;
      const stop = spike.low - BUFFER_ATR * a;
      const target = entry + TP_FRAC_OF_SPIKE * range;
      if (target <= 0 || stop >= entry) continue;
      out.push({ idx: i, side: "BUY", entry, stop, target });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], side: "BUY" | "SELL", ws: number, we: number, mart: number) {
  const sigs = detect(candles, side).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;
  let chainStake = 0;
  let worstChainLoss = 0;
  let chainLosses = 0;
  let maxLevelHit = 0;

  for (const sig of sigs) {
    if (bust || ddPaused) break;
    if (martLevel >= MAX_LEVELS) martLevel = 0;
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(mart, martLevel)));
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
    chainStake += net;
    if (net > 0) {
      // chain ended on win — record outcome
      if (chainStake < worstChainLoss) worstChainLoss = chainStake;
      chainStake = 0;
      chainLosses = 0;
    } else {
      chainLosses++;
    }
    if (balance > peak) peak = balance;
    if (martLevel > maxLevelHit) maxLevelHit = martLevel;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  if (chainStake < worstChainLoss) worstChainLoss = chainStake;
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak, worstChainLoss, maxLevelHit };
}

async function main() {
  console.log(`BOOM/CRASH 300N spike-fade — mart-factor recovery sweep`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MAX_LEVELS=${MAX_LEVELS}  CAP=$${PER_TRADE_CAP}  DD=${(DD_FRAC*100).toFixed(0)}%\n`);
  console.log(`Math: m ≥ 3.04 needed for any chain to break even on recovery.\n`);

  const c = new C(); await c.ready;

  type Row = { sym: string; mart: number; net: number; trades: number; busts: number; dds: number; worst: number; maxLvl: number };
  const rows: Row[] = [];

  for (const a of ASSETS) {
    for (const m of MART_FACTORS) {
      let netSum = 0, tradesSum = 0, bustCount = 0, ddCount = 0, worst = 0, maxLvl = 0;
      for (const win of WINDOWS) {
        const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
        const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
        let candles: Candle[] | null = null;
        try { candles = await fetchPaged(c, a.sym, 60, 5000, we_); }
        catch (e) { continue; }
        const r = honestSim(candles, a.side, ws_, we_, m);
        netSum += r.finalBal - ACCT;
        tradesSum += r.trades;
        if (r.bust) bustCount++;
        if (r.ddPaused) ddCount++;
        if (r.worstChainLoss < worst) worst = r.worstChainLoss;
        if (r.maxLevelHit > maxLvl) maxLvl = r.maxLevelHit;
      }
      rows.push({ sym: a.sym, mart: m, net: netSum, trades: tradesSum, busts: bustCount, dds: ddCount, worst, maxLvl });
    }
  }
  c.close();

  for (const a of ASSETS) {
    console.log(`\n══ ${a.sym}  ${a.side}  ═══════════════════════════════════════════════`);
    console.log(`  mart    net Δ      trades   busts  DDs   worstChain  maxLvl`);
    for (const r of rows.filter((x) => x.sym === a.sym)) {
      console.log(`  ${r.mart.toFixed(1)}×    ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(7)}   ${String(r.trades).padStart(4)}t    ${r.busts}/5    ${r.dds}/5   $${r.worst.toFixed(2).padStart(7)}     L${r.maxLvl}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

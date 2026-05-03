// Multi-asset mean-rev-only screener.
// Apply the validated RDBEAR strategy (efficiency-ratio chop filter + AGAINST
// fade) to other synthetic indices to see if the mean-rev edge generalizes.
//
// Tests across 3 unique 48h windows, accounts for asset-specific volatility.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 5);
const MART = Number(process.env.MART ?? 2.0);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 50);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const HTF_SMA_PERIOD = 12;
const SLOPE_BARS = 6;
const MIN_ADX = 22;
const EFF_WINDOW = 24;
const TREND_THRESH = 0.45;
const CHOP_THRESH = 0.30;
const DD_FRAC = 0.60;

// Math-y synths only: Range Break (bounded), Step Indices (fixed ±0.1 walk),
// Jump Diffusion (periodic jumps). Skip pure random walks (R_*) and ticks (1HZ*).
const ASSETS = [
  { sym: "RB100",    gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "RB200",    gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "stpRNG",   gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "stpRNG2",  gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "stpRNG3",  gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "stpRNG4",  gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "stpRNG5",  gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "JD25",     gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "JD50",     gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
  { sym: "JD75",     gr: 300, lookback: 15, kAtr: 2.5, momRatio: 0.70 },
];

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

const WINDOWS = [
  { offset: 4, startH: 0, endH: 48, label: "4d 00-48h" },
  { offset: 7, startH: 8, endH: 56, label: "7d 08-56h" },
  { offset: 12, startH: 20, endH: 68, label: "12d 20-68h" },
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

function detect(candles: Candle[], asset: typeof ASSETS[number]): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(asset.lookback, 28, EFF_WINDOW) + 1; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    const ad = adx(candles, i, 14);
    if (ad < MIN_ADX) continue;
    const eff = efficiency(candles, i, EFF_WINDOW);
    if (eff >= CHOP_THRESH) continue;

    let hi = -Infinity, lo = Infinity;
    for (let m = i - asset.lookback; m < i; m++) {
      if (candles[m].high > hi) hi = candles[m].high;
      if (candles[m].low < lo) lo = candles[m].low;
    }
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const closePosDn = (cur.high - cur.close) / r;
    const dist = asset.kAtr * a;

    if (cur.close > hi && closePosUp >= asset.momRatio) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
    } else if (cur.close < lo && closePosDn >= asset.momRatio) {
      out.push({ idx: i, side: "BUY", entry: cur.close, stop: cur.close - dist, target: cur.close + dist });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], asset: typeof ASSETS[number], ws: number, we: number) {
  const sigs = detect(candles, asset).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trough = ACCT;
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
    if (balance < trough) trough = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak };
}

async function main() {
  console.log(`Multi-asset mean-rev screener (RDBEAR-validated edge applied to other synths)`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  DD-pause=${(DD_FRAC*100).toFixed(0)}%`);
  console.log(`Strategy: chop-filter (eff<${CHOP_THRESH}) + AGAINST fade  ·  detector lb=15 kAtr=2.5 momR=0.70\n`);

  const c = new C(); await c.ready;

  type Row = { sym: string; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];

  for (const asset of ASSETS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Candle[] | null = null;
      try { candles = await fetchPaged(c, asset.sym, asset.gr, 9000, we_); }
      catch (e) { console.log(`  ${asset.sym} ${win.label}: fetch fail ${(e as Error).message}`); continue; }
      const r = honestSim(candles, asset, ws_, we_);
      const wr = r.trades > 0 ? r.wins / r.trades : 0;
      const status = r.bust ? "💀 BUST" : r.ddPaused ? "⏸ DD-paused" : r.trades === 0 ? "—" : "✓";
      rows.push({ sym: asset.sym, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
    }
  }
  c.close();

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  asset      window       trades   WR    final     Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const r of rows) {
    const dPct = ((r.final - ACCT) / ACCT * 100).toFixed(0);
    console.log(`  ${r.sym.padEnd(8)}  ${r.window.padEnd(12)}  ${String(r.trades).padStart(3)}t   ${(r.wr*100).toFixed(0).padStart(2)}%  $${r.final.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${r.status}`);
  }

  // Summarize by asset.
  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-ASSET SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const asset of ASSETS) {
    const a = rows.filter((r) => r.sym === asset.sym);
    const winners = a.filter((r) => r.final > ACCT).length;
    const busts = a.filter((r) => r.status.includes("BUST") || r.status.includes("paused")).length;
    const totalReturn = a.reduce((s, r) => s + (r.final - ACCT), 0);
    console.log(`  ${asset.sym.padEnd(8)}  ${a.length} windows  ${winners} winners / ${busts} bust-or-paused  total Δ: ${totalReturn >= 0 ? "+" : ""}$${totalReturn.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

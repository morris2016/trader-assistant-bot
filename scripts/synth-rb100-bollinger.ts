// RB100 Range Break — Bollinger Band mean-reversion strategy.
//
// Structural hypothesis: RB100 is a bounded oscillator. Price stays within a
// range until a "break event" creates a new range. Inside any range,
// distance from rolling mean is mean-reverting.
//
// Strategy:
//   • Compute SMA(20) and stdev(20) on 5m closes
//   • SELL when price > mean + sigmaMul × stdev (overbought)
//   • BUY  when price < mean − sigmaMul × stdev (oversold)
//   • TP = mean (return to center)
//   • SL = mean ± exitSigma × stdev (range break — exit)
//   • R:R = (sigmaMul / (exitSigma - sigmaMul)) — typically 2:1 or 3:1
// Skip when stdev is too small (no signal) or trend efficiency too high.

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
const DD_FRAC = 0.60;

const SYM = "RB100";
const GR = 300;

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

// Bollinger variants to sweep.
type Variant = { name: string; smaPeriod: number; sigmaMul: number; exitSigma: number; minSigmaPct: number };
const VARIANTS: Variant[] = [
  { name: "BB(20) ±2σ exit3σ", smaPeriod: 20, sigmaMul: 2.0, exitSigma: 3.0, minSigmaPct: 0.001 },
  { name: "BB(20) ±2σ exit2.5σ", smaPeriod: 20, sigmaMul: 2.0, exitSigma: 2.5, minSigmaPct: 0.001 },
  { name: "BB(20) ±1.5σ exit2.5σ", smaPeriod: 20, sigmaMul: 1.5, exitSigma: 2.5, minSigmaPct: 0.001 },
  { name: "BB(30) ±2σ exit3σ", smaPeriod: 30, sigmaMul: 2.0, exitSigma: 3.0, minSigmaPct: 0.001 },
  { name: "BB(30) ±1.5σ exit2.5σ", smaPeriod: 30, sigmaMul: 1.5, exitSigma: 2.5, minSigmaPct: 0.001 },
  { name: "BB(15) ±2σ exit3σ", smaPeriod: 15, sigmaMul: 2.0, exitSigma: 3.0, minSigmaPct: 0.001 },
  { name: "BB(20) ±2.5σ exit3.5σ", smaPeriod: 20, sigmaMul: 2.5, exitSigma: 3.5, minSigmaPct: 0.001 },
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

function smaStdev(c: Candle[], i: number, period: number): { mean: number; stdev: number } {
  if (i < period - 1) return { mean: NaN, stdev: NaN };
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += c[j].close;
  const mean = sum / period;
  let sqSum = 0;
  for (let j = i - period + 1; j <= i; j++) sqSum += (c[j].close - mean) ** 2;
  const stdev = Math.sqrt(sqSum / period);
  return { mean, stdev };
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };

function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  for (let i = v.smaPeriod + 1; i < candles.length; i++) {
    const { mean, stdev } = smaStdev(candles, i, v.smaPeriod);
    if (!isFinite(mean) || stdev <= 0) continue;
    if (stdev / mean < v.minSigmaPct) continue; // skip when range is too tight
    const upper = mean + v.sigmaMul * stdev;
    const lower = mean - v.sigmaMul * stdev;
    const upperExit = mean + v.exitSigma * stdev;
    const lowerExit = mean - v.exitSigma * stdev;
    const cur = candles[i];
    // Need previous bar to confirm price reached the band (avoid mid-bar entries).
    const prev = candles[i - 1];

    if (cur.close > upper && prev.close <= upper) {
      // Just crossed above upper band → SELL (fade extension)
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: upperExit, target: mean });
    } else if (cur.close < lower && prev.close >= lower) {
      // Just crossed below lower band → BUY (fade extension)
      out.push({ idx: i, side: "BUY", entry: cur.close, stop: lowerExit, target: mean });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], v: Variant, ws: number, we: number) {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;
  let buyCount = 0, sellCount = 0;

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
    if (sig.side === "BUY") buyCount++; else sellCount++;
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak, buyCount, sellCount };
}

async function main() {
  console.log(`RB100 Bollinger Band mean-reversion screener`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  DD-pause=${(DD_FRAC*100).toFixed(0)}%\n`);

  const c = new C(); await c.ready;
  type Row = { variant: string; window: string; trades: number; bs: string; wr: number; final: number; status: string };
  const rows: Row[] = [];
  for (const win of WINDOWS) {
    const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
    const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
    let candles: Candle[] | null = null;
    try { candles = await fetchPaged(c, SYM, GR, 9000, we_); }
    catch (e) { console.log(`  ${win.label}: fetch fail ${(e as Error).message}`); continue; }
    for (const v of VARIANTS) {
      const r = honestSim(candles, v, ws_, we_);
      const wr = r.trades > 0 ? r.wins / r.trades : 0;
      const status = r.bust ? "💀 BUST" : r.ddPaused ? "⏸ DD-paused" : r.trades === 0 ? "—" : "✓";
      rows.push({ variant: v.name, window: win.label, trades: r.trades, bs: `${r.buyCount}/${r.sellCount}`, wr, final: r.finalBal, status });
    }
  }
  c.close();

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  variant                   window       trades  B/S   WR    final     Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const r of rows) {
    const dPct = ((r.final - ACCT) / ACCT * 100).toFixed(0);
    console.log(`  ${r.variant.padEnd(24)}  ${r.window.padEnd(12)}  ${String(r.trades).padStart(3)}t  ${r.bs.padEnd(5)}  ${(r.wr*100).toFixed(0).padStart(2)}%  $${r.final.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${r.status}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`PER-VARIANT SUMMARY`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  for (const v of VARIANTS) {
    const a = rows.filter((r) => r.variant === v.name);
    const winners = a.filter((r) => r.final > ACCT).length;
    const busts = a.filter((r) => r.status.includes("BUST") || r.status.includes("paused")).length;
    const totalReturn = a.reduce((s, r) => s + (r.final - ACCT), 0);
    console.log(`  ${v.name.padEnd(24)}  ${a.length} windows  ${winners}W / ${busts} bust-or-paused  total Δ: ${totalReturn >= 0 ? "+" : ""}$${totalReturn.toFixed(2)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

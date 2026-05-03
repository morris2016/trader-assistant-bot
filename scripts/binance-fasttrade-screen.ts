// Binance 24/7 fast-trade screener — REAL assets, no market hours.
// Public REST klines (no auth needed). Tests multiple detectors on the
// top-liquidity USDT perpetuals to find any high-frequency edge similar
// to the Deriv synth strategies.
//
// Detectors:
//   SPK    — spike-fade (validated on BOOM/CRASH 300N, may not transfer)
//   RSI    — RSI(14) extreme reversion, TP=2×ATR  SL=1×ATR (2:1 R:R)
//   BOLL   — Bollinger band reversion to midband
//   DONCH  — Donchian midline cross
//   PULL   — pullback fade with structural SL

import * as https from "https";

type Kline = { epoch: number; open: number; high: number; low: number; close: number; volume: number };

const ACCT = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const PER_TRADE_CAP = Number(process.env.CAP ?? 30);
const MULT = 100;
const COMMISSION_FRAC = 0.0004;       // Binance perp taker ~0.04%
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;
const ATR_PERIOD = 14;

// Top-liquidity perpetuals — broad volatility profile
const PAIRS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "BNBUSDT", "AVAXUSDT", "LINKUSDT",
  "SUIUSDT", "WLDUSDT",
];

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

function fetchJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`parse: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(new Error("timeout")); });
  });
}

async function fetchKlines(symbol: string, intervalSec: number, startSec: number, endSec: number): Promise<Kline[]> {
  const out: Kline[] = [];
  const intervalStr = intervalSec === 60 ? "1m" : intervalSec === 300 ? "5m" : `${intervalSec}s`;
  let cursor = startSec * 1000;
  const endMs = endSec * 1000;
  while (cursor < endMs) {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${intervalStr}&startTime=${cursor}&endTime=${endMs}&limit=1500`;
    let raw: any;
    try { raw = await fetchJson(url); }
    catch (e) {
      // backoff once
      await new Promise((r) => setTimeout(r, 1500));
      try { raw = await fetchJson(url); } catch { break; }
    }
    if (!Array.isArray(raw) || raw.length === 0) break;
    for (const k of raw) {
      out.push({
        epoch: Math.floor(k[0] / 1000),
        open: Number(k[1]),
        high: Number(k[2]),
        low: Number(k[3]),
        close: Number(k[4]),
        volume: Number(k[5]),
      });
    }
    if (raw.length < 1500) break;
    cursor = raw[raw.length - 1][0] + 1;
  }
  return out;
}

function atr(c: Kline[], i: number, period: number): number {
  if (i < period) return 0;
  let s = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close));
    s += tr;
  }
  return s / period;
}

function rsi(c: Kline[], i: number, period = 14): number {
  if (i < period) return 50;
  let gain = 0, loss = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const diff = c[j].close - c[j - 1].close;
    if (diff > 0) gain += diff; else loss -= diff;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

function bb(c: Kline[], i: number, period = 20, k = 2): { mid: number; up: number; lo: number } {
  if (i < period) return { mid: c[i].close, up: c[i].close, lo: c[i].close };
  let sum = 0;
  for (let j = i - period + 1; j <= i; j++) sum += c[j].close;
  const mid = sum / period;
  let v = 0;
  for (let j = i - period + 1; j <= i; j++) v += (c[j].close - mid) ** 2;
  const sd = Math.sqrt(v / period);
  return { mid, up: mid + k * sd, lo: mid - k * sd };
}

type Sig = { idx: number; side: "BUY" | "SELL"; entry: number; stop: number; target: number };
type Strat = "SPK" | "RSI" | "BOLL" | "DONCH" | "PULL";

function detect(candles: Kline[], strat: Strat, side: "BUY" | "SELL" | "BOTH"): Sig[] {
  const out: Sig[] = [];
  const start = Math.max(ATR_PERIOD + 2, 22);
  for (let i = start; i < candles.length; i++) {
    const a = atr(candles, i - 1, ATR_PERIOD);
    if (a <= 0) continue;
    const cur = candles[i];

    if (strat === "SPK") {
      const spike = candles[i - 1];
      const range = spike.high - spike.low;
      if (range < 3.0 * a) continue;
      const confirm = cur;
      if ((side === "SELL" || side === "BOTH") && spike.close > spike.open && confirm.close < spike.close) {
        const entry = confirm.close;
        const stop = spike.high + 0.2 * a;
        const target = entry - 0.5 * range;
        if (target > 0 && stop > entry) out.push({ idx: i, side: "SELL", entry, stop, target });
      }
      if ((side === "BUY" || side === "BOTH") && spike.close < spike.open && confirm.close > spike.close) {
        const entry = confirm.close;
        const stop = spike.low - 0.2 * a;
        const target = entry + 0.5 * range;
        if (target > 0 && stop < entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }

    else if (strat === "RSI") {
      const r = rsi(candles, i, 14);
      if (r > 75) {
        const entry = cur.close;
        const stop = entry + 1.0 * a;
        const target = entry - 2.0 * a;
        if (target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      } else if (r < 25) {
        const entry = cur.close;
        const stop = entry - 1.0 * a;
        const target = entry + 2.0 * a;
        if (target > 0) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }

    else if (strat === "BOLL") {
      const b = bb(candles, i, 20, 2);
      if (cur.close > b.up) {
        const entry = cur.close;
        const stop = entry + 2.0 * a;
        const target = b.mid;
        if (target < entry && target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      } else if (cur.close < b.lo) {
        const entry = cur.close;
        const stop = entry - 2.0 * a;
        const target = b.mid;
        if (target > entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }

    else if (strat === "DONCH") {
      let hi = -Infinity, lo = Infinity;
      for (let m = i - 20; m < i; m++) {
        if (candles[m].high > hi) hi = candles[m].high;
        if (candles[m].low < lo) lo = candles[m].low;
      }
      const mid = (hi + lo) / 2;
      const prev = candles[i - 1];
      if (prev.close < mid && cur.close > mid && cur.close > cur.open) {
        const entry = cur.close;
        const stop = mid - 1.0 * a;
        const target = hi;
        if (target > entry && stop < entry) out.push({ idx: i, side: "BUY", entry, stop, target });
      } else if (prev.close > mid && cur.close < mid && cur.close < cur.open) {
        const entry = cur.close;
        const stop = mid + 1.0 * a;
        const target = lo;
        if (target < entry && target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      }
    }

    else if (strat === "PULL") {
      // Pullback fade: green-then-red sells; red-then-green buys.
      const prev = candles[i - 1];
      if (prev.close > prev.open && cur.close < cur.open === false && cur.close < cur.open) {
        const entry = cur.close;
        const stop = Math.max(prev.high, cur.high) + 0.2 * a;
        const target = entry - 0.4 * a;
        if (target > 0) out.push({ idx: i, side: "SELL", entry, stop, target });
      } else if (prev.close < prev.open && cur.close > cur.open) {
        const entry = cur.close;
        const stop = Math.min(prev.low, cur.low) - 0.2 * a;
        const target = entry + 0.4 * a;
        if (target > 0) out.push({ idx: i, side: "BUY", entry, stop, target });
      }
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Kline[], sigs: Sig[], ws: number, we: number) {
  const filtered = sigs.filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;

  for (const sig of filtered) {
    if (bust || ddPaused) break;
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
  console.log(`Binance perpetuals fast-trade screen — 5 detectors × ${PAIRS.length} pairs × 5 windows @ 1m`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}\n`);

  type Row = { sym: string; strat: Strat; side: string; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];
  const strats: Array<{ id: Strat; sides: Array<"BUY" | "SELL" | "BOTH"> }> = [
    { id: "SPK",   sides: ["BOTH"] },
    { id: "RSI",   sides: ["BOTH"] },
    { id: "BOLL",  sides: ["BOTH"] },
    { id: "DONCH", sides: ["BOTH"] },
    { id: "PULL",  sides: ["BOTH"] },
  ];

  for (const sym of PAIRS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Kline[] = [];
      try { candles = await fetchKlines(sym, 60, ws_ - 3600, we_); }
      catch (e) { console.log(`  ${sym} ${win.label}: fetch fail ${(e as Error).message}`); continue; }
      if (candles.length < 50) continue;
      for (const s of strats) {
        for (const side of s.sides) {
          const sigs = detect(candles, s.id, side);
          const r = honestSim(candles, sigs, ws_, we_);
          const wr = r.trades > 0 ? r.wins / r.trades : 0;
          const status = r.bust ? "BUST" : r.ddPaused ? "DD" : r.trades === 0 ? "—" : "ok";
          rows.push({ sym, strat: s.id, side, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
        }
      }
    }
    process.stdout.write(`  ${sym} done\n`);
  }

  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`SUMMARY (5 windows each)  — sorted by net Δ desc`);
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`  pair        strat   trades   W   bust   net Δ      WR`);

  type Agg = { sym: string; strat: Strat; trades: number; W: number; bust: number; net: number; wins: number };
  const aggMap = new Map<string, Agg>();
  for (const r of rows) {
    const key = `${r.sym}|${r.strat}`;
    if (!aggMap.has(key)) aggMap.set(key, { sym: r.sym, strat: r.strat, trades: 0, W: 0, bust: 0, net: 0, wins: 0 });
    const a = aggMap.get(key)!;
    a.trades += r.trades;
    a.wins += Math.round(r.trades * r.wr);
    if (r.final > ACCT) a.W++;
    if (r.status === "BUST" || r.status === "DD") a.bust++;
    a.net += r.final - ACCT;
  }
  const aggs = Array.from(aggMap.values()).sort((a, b) => b.net - a.net);
  for (const a of aggs) {
    const wr = a.trades > 0 ? a.wins / a.trades : 0;
    const flag = a.W >= 4 && a.bust === 0 && a.net > 0 ? " ★" : a.W >= 3 && a.bust === 0 && a.net > 0 ? " ✓" : "";
    console.log(`  ${a.sym.padEnd(10)}  ${a.strat.padEnd(5)}  ${String(a.trades).padStart(5)}t   ${a.W}/5   ${a.bust}/5   ${a.net >= 0 ? "+" : ""}$${a.net.toFixed(2).padStart(7)}   ${(wr*100).toFixed(0)}%${flag}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

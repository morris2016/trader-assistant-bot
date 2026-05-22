// Per-hour and per-day breakdown for the 3 winning HF patterns at 15m.
// Helps identify time-of-day edge + spot any losing days.

import * as fs from "fs";

const ASSETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT", "AVAXUSDT", "LDOUSDT", "ADAUSDT", "LINKUSDT", "UNIUSDT", "AAVEUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT"];
const CACHE_DIR = "C:/Users/fame/AppData/Local/Temp";
const FROM_DATE = process.env.FROM_DATE ?? "2025-12-01";
const TO_DATE = process.env.TO_DATE ?? "2025-12-31";
const STAKE = 15, MULT = 30, HORIZON = 48;
const TRAIL_ARM_ATR = 1.0, TRAIL_RETRACE_ATR = 0.3;

// REALISTIC cost model — CALIBRATED against live $1 trade on 2026-05-22
// (ETHUSDT BB_LOW_LONG, ACTUAL EXECUTION REPORT, see project memory):
//   - Binance Futures taker fee: 0.05% per side (10bps RT) — measured 9.92bps ✓
//   - Slippage: was 0.08% per side; ACTUAL measured 0.09bps entry — using
//     0.0001 (1bps) per side as conservative buffer for less-liquid alts.
//   - Funding rate: avg 0.005% per trade (4h hold spans ~0.5 funding periods)
//     — actual was 0 on 3h trade (no boundary crossed); keep current value.
//   - Trail timing: was 0.03%; actual exit slipped $0.15 below trigger on
//     market-close ack (~7bps). Bumping to 5bps for conservatism.
const NOTIONAL = STAKE * MULT;
const TAKER_FEE = 0.0005;           // per side  (confirmed live ✓)
const SLIPPAGE = 0.0001;            // per side  (was 0.0008 — live measured 0.09bps)
const FUNDING = 0.00005;            // avg per trade
const TRAIL_TIMING = 0.0005;        // one-sided exit-only (was 0.0003 — live 7bps)
const FEE_PER_TRADE = NOTIONAL * TAKER_FEE * 2;          // $0.45
const SLIP_PER_TRADE = NOTIONAL * SLIPPAGE * 2;          // $0.09
const FUNDING_PER_TRADE = NOTIONAL * FUNDING;            // $0.02
const TRAIL_TIMING_PER_TRADE = NOTIONAL * TRAIL_TIMING;  // $0.23
// Total per-trade cost: ~$0.79 on $450 notional (was $1.33 — sim was 1.7× too pessimistic)
const ATR_PERIOD = 14, BB_PERIOD = 20, BB_K = 2.0, TF_SEC = 900;

// Profitable UTC hours from Dec 2025 analysis. Set HOURS=all to disable filter.
const ALLOWED_HOURS = process.env.HOURS === "all"
  ? new Set(Array.from({ length: 24 }, (_, i) => i))
  : new Set([0, 2, 6, 7, 8, 9, 12, 13, 14, 15, 16, 23]);

type Bar = { epoch: number; open: number; high: number; low: number; close: number };

function load1m(sym: string): Bar[] {
  const all: Bar[] = [];
  for (const m of ["2025-11-01-2025-12-31", "2026-02-01-2026-04-30", "2026-05-01-2026-05-20", "2026-05-20-2026-05-22"]) {
    const cf = `${CACHE_DIR}/ticks-${sym}-1m-${m}.json`;
    if (!fs.existsSync(cf)) continue;
    const partial: Bar[] = JSON.parse(fs.readFileSync(cf, "utf8"));
    for (const b of partial) all.push(b);
  }
  const map = new Map<number, Bar>();
  for (const b of all) map.set(b.epoch, b);
  return Array.from(map.values()).sort((a, b) => a.epoch - b.epoch);
}

function roll(bars1m: Bar[]): Bar[] {
  const out: Bar[] = [];
  let bucket: Bar[] = []; let be = -1;
  for (const b of bars1m) {
    const e = Math.floor(b.epoch / TF_SEC) * TF_SEC;
    if (be === -1) be = e;
    if (e !== be) {
      if (bucket.length) out.push({ epoch: be, open: bucket[0].open, close: bucket[bucket.length - 1].close, high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)) });
      bucket = []; be = e;
    }
    bucket.push(b);
  }
  if (bucket.length) out.push({ epoch: be, open: bucket[0].open, close: bucket[bucket.length - 1].close, high: Math.max(...bucket.map(x => x.high)), low: Math.min(...bucket.map(x => x.low)) });
  return out;
}

function computeATR(bars: Bar[], i: number): number {
  if (i < ATR_PERIOD) return NaN;
  let s = 0;
  for (let j = i - ATR_PERIOD + 1; j <= i; j++) s += Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
  return s / ATR_PERIOD;
}

function computeBB(bars: Bar[], i: number): { mid: number; upper: number; lower: number } | null {
  if (i < BB_PERIOD - 1) return null;
  let sum = 0, sq = 0;
  for (let j = i - BB_PERIOD + 1; j <= i; j++) { sum += bars[j].close; sq += bars[j].close ** 2; }
  const mid = sum / BB_PERIOD;
  const sd = Math.sqrt(Math.max(0, sq / BB_PERIOD - mid * mid));
  return { mid, upper: mid + BB_K * sd, lower: mid - BB_K * sd };
}

function simTrade(bars: Bar[], i: number, entry: number, side: 1 | -1, atr: number): number {
  const exitIdx = Math.min(i + HORIZON, bars.length - 1);
  let exitPrice = bars[exitIdx].close;
  if (isFinite(atr) && atr > 0) {
    const arm = TRAIL_ARM_ATR * atr, retrace = TRAIL_RETRACE_ATR * atr;
    let peak = entry, armed = false;
    for (let bi = i + 1; bi <= exitIdx; bi++) {
      const b = bars[bi]; let trail = false;
      if (side === 1) {
        if (b.high > peak) peak = b.high;
        if (!armed && peak >= entry + arm) armed = true;
        if (armed && b.low <= peak - retrace) { exitPrice = peak - retrace; trail = true; }
      } else {
        if (b.low < peak) peak = b.low;
        if (!armed && peak <= entry - arm) armed = true;
        if (armed && b.high >= peak + retrace) { exitPrice = peak + retrace; trail = true; }
      }
      if (trail) break;
    }
  }
  let pnl = STAKE * MULT * side * ((exitPrice - entry) / entry);
  if (pnl < -STAKE) pnl = -STAKE;
  return pnl - FEE_PER_TRADE - SLIP_PER_TRADE - FUNDING_PER_TRADE - TRAIL_TIMING_PER_TRADE;
}

type Detector = (bars: Bar[], i: number) => { side: 1 | -1; entry: number } | null;
// SWEEP_HIGH_SHORT dropped 2026-05-22 — net positive on Dec 2025 ($33) but
// −$866 on Feb 2026 OOS. Regime-dependent, not robust. Only BB patterns kept.
const PATTERNS: Record<string, Detector> = {
  BB_UP_SHORT: (bars, i) => { const bb = computeBB(bars, i); if (!bb) return null; return (bars[i].high >= bb.upper && bars[i].close < bb.upper) ? { side: -1, entry: bars[i].close } : null; },
  BB_LOW_LONG: (bars, i) => { const bb = computeBB(bars, i); if (!bb) return null; return (bars[i].low <= bb.lower && bars[i].close > bb.lower) ? { side: 1, entry: bars[i].close } : null; },
};

type Trade = { pattern: string; epoch: number; pnl: number };

function main() {
  console.log(`\n══ HF 15m hourly + daily breakdown: ${FROM_DATE} → ${TO_DATE} ══\n`);
  const fromEp = Math.floor(new Date(FROM_DATE + "T00:00:00Z").getTime() / 1000);
  const toEp = Math.floor(new Date(TO_DATE + "T23:59:59Z").getTime() / 1000);

  const allTrades: Trade[] = [];

  for (const sym of ASSETS) {
    const bars1m = load1m(sym);
    if (bars1m.length < 5000) continue;
    const preWarm = (BB_PERIOD + ATR_PERIOD + 10) * TF_SEC;
    const bars = roll(bars1m).filter(b => b.epoch >= fromEp - preWarm && b.epoch <= toEp);
    if (bars.length < BB_PERIOD + ATR_PERIOD + 20) continue;
    let startIdx = bars.findIndex(b => b.epoch >= fromEp);
    if (startIdx < 0) continue;
    // If we don't have enough warmup bars BEFORE fromEp, push startIdx
    // forward to where indicators are valid (sacrifices a few early test
    // hours but lets the rest of the window trade).
    if (startIdx < BB_PERIOD + ATR_PERIOD + 5) startIdx = BB_PERIOD + ATR_PERIOD + 5;

    for (const [name, gen] of Object.entries(PATTERNS)) {
      for (let i = startIdx; i < bars.length - HORIZON; i++) {
        const s = gen(bars, i); if (!s) continue;
        // Hour-of-day filter — skip signals outside profitable windows
        const hour = new Date(bars[i].epoch * 1000).getUTCHours();
        if (!ALLOWED_HOURS.has(hour)) continue;
        const atr = computeATR(bars, i);
        const pnl = simTrade(bars, i, s.entry, s.side, atr);
        allTrades.push({ pattern: name, epoch: bars[i].epoch, pnl });
      }
    }
  }

  // ── Per UTC hour ────────────────────────────────────────────────────
  console.log("── Per UTC hour (all 3 patterns combined) ──");
  console.log(`Hour  Trades   WR%    Total $   $/trade`);
  console.log("─".repeat(48));
  for (let h = 0; h < 24; h++) {
    const t = allTrades.filter(x => new Date(x.epoch * 1000).getUTCHours() === h);
    const wr = t.length > 0 ? t.filter(x => x.pnl > 0).length / t.length * 100 : 0;
    const tot = t.reduce((s, x) => s + x.pnl, 0);
    const avg = t.length > 0 ? tot / t.length : 0;
    const bar = "▌".repeat(Math.max(0, Math.min(20, Math.round(tot / 20))));
    console.log(`${String(h).padStart(2)}:00  ${String(t.length).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  ${tot >= 0 ? "+" : ""}${tot.toFixed(2).padStart(7)}   ${avg.toFixed(3).padStart(6)}  ${bar}`);
  }

  // ── Per day ─────────────────────────────────────────────────────────
  console.log("\n── Per day ──");
  console.log(`Date         Trades   WR%    Total $   $/trade`);
  console.log("─".repeat(50));
  const byDay = new Map<string, Trade[]>();
  for (const t of allTrades) {
    const day = new Date(t.epoch * 1000).toISOString().slice(0, 10);
    const arr = byDay.get(day) ?? [];
    arr.push(t);
    byDay.set(day, arr);
  }
  let dailyTotal = 0, dailyTradeTotal = 0;
  for (const day of Array.from(byDay.keys()).sort()) {
    const t = byDay.get(day)!;
    const wr = t.filter(x => x.pnl > 0).length / t.length * 100;
    const tot = t.reduce((s, x) => s + x.pnl, 0);
    const avg = tot / t.length;
    dailyTotal += tot; dailyTradeTotal += t.length;
    const flag = tot >= 0 ? "✓" : "✗";
    console.log(`${day}   ${String(t.length).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  ${tot >= 0 ? "+" : ""}${tot.toFixed(2).padStart(7)}   ${avg.toFixed(3).padStart(6)}  ${flag}`);
  }
  console.log("─".repeat(50));
  console.log(`TOTAL        ${String(dailyTradeTotal).padStart(5)}            ${dailyTotal >= 0 ? "+" : ""}${dailyTotal.toFixed(2).padStart(7)}   ${(dailyTotal / dailyTradeTotal).toFixed(3).padStart(6)}`);

  // ── Per pattern breakdown ───────────────────────────────────────────
  console.log("\n── Per pattern ──");
  console.log(`Pattern              Trades   WR%    Total $   $/trade   Profitable days / Total days`);
  console.log("─".repeat(85));
  for (const p of Object.keys(PATTERNS)) {
    const t = allTrades.filter(x => x.pattern === p);
    const wr = t.length > 0 ? t.filter(x => x.pnl > 0).length / t.length * 100 : 0;
    const tot = t.reduce((s, x) => s + x.pnl, 0);
    // Profitable days
    const dailyForPattern = new Map<string, number>();
    for (const x of t) {
      const day = new Date(x.epoch * 1000).toISOString().slice(0, 10);
      dailyForPattern.set(day, (dailyForPattern.get(day) ?? 0) + x.pnl);
    }
    const profitableDays = Array.from(dailyForPattern.values()).filter(v => v > 0).length;
    const totalDays = dailyForPattern.size;
    console.log(`${p.padEnd(22)}${String(t.length).padStart(5)}  ${wr.toFixed(1).padStart(5)}%  ${tot >= 0 ? "+" : ""}${tot.toFixed(2).padStart(7)}   ${(tot / t.length).toFixed(3).padStart(6)}      ${profitableDays} / ${totalDays}`);
  }
}

main();

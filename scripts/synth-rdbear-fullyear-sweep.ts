// RDBEAR full-year survival sweep — Jan 1 2025 → today (~16 months).
// Persistent balance through entire window. Test multiple configs to find
// one that survives without bust AND remains profitable.
//
// Each config runs on the SAME signal stream from the no-regime detector,
// optionally adding a bar-level distSma200 filter. Persistent balance, no
// per-day reset. We're looking for: 0 busts AND best ending balance.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT_DEFAULT = 100;
const MIN_STAKE = 0.31;
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
const SYM = "RDBEAR";
const GR = 300;

const JAN_1_2025 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const TODAY = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const TOTAL_DAYS = Math.floor((TODAY - JAN_1_2025) / 86400);

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

function distAboveSma(c: Candle[], i: number, n: number): number {
  if (i < n) return 0;
  let sum = 0;
  for (let j = i - n + 1; j <= i; j++) sum += c[j].close;
  const sma = sum / n;
  const a = atr(c, i, 14);
  if (a <= 0) return 0;
  return (c[i].close - sma) / a;
}

type Sig = { idx: number; entry: number; stop: number; target: number; distSma200: number };

function detect(candles: Candle[]): Sig[] {
  const out: Sig[] = [];
  const start = Math.max(LOOKBACK + 14, 200) + 1;
  for (let i = start; i < candles.length; i++) {
    const a = atr(candles, i, 14);
    if (a <= 0) continue;
    let hi = -Infinity;
    for (let m = i - LOOKBACK; m < i; m++) if (candles[m].high > hi) hi = candles[m].high;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    const closePosUp = (cur.close - cur.low) / r;
    const dist = KATR * a;
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      out.push({
        idx: i,
        entry: cur.close,
        stop: cur.close + dist,
        target: cur.close - dist,
        distSma200: distAboveSma(candles, i, 200),
      });
    }
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Cfg = {
  label: string;
  acctInit: number;
  base: number;
  mart: number;
  levels: number;
  ddFrac: number;
  minDistSma200: number;
  acctReset: boolean;
};

type RunResult = {
  cfg: Cfg;
  bust: boolean;
  bustEpoch: number;
  finalBal: number;
  peak: number;
  trough: number;
  trades: number;
  wins: number;
  losses: number;
  ddDays: number;
  maxStreak: number;
};

function run(allCandles: Candle[], allSigs: Sig[], rangeStart: number, rangeEnd: number, cfg: Cfg): RunResult {
  const filtered = allSigs.filter((s) => allCandles[s.idx].epoch >= rangeStart && allCandles[s.idx].epoch < rangeEnd && s.distSma200 >= cfg.minDistSma200);
  let balance = cfg.acctInit;
  let martLevel = 0;
  let bust = false;
  let bustEpoch = 0;
  let peak = cfg.acctInit, trough = cfg.acctInit;
  let trades = 0, wins = 0, losses = 0;
  let curStreak = 0, maxStreak = 0;
  let dayStart = rangeStart;
  let dayPeak = cfg.acctInit;
  let dayDDPaused = false;
  let ddDays = 0;

  for (const sig of filtered) {
    const sigEpoch = allCandles[sig.idx].epoch;
    // Daily reset checks
    if (sigEpoch >= dayStart + 86400) {
      if (dayDDPaused) ddDays++;
      dayStart = Math.floor(sigEpoch / 86400) * 86400;
      dayPeak = balance;
      dayDDPaused = false;
      if (cfg.acctReset) balance = cfg.acctInit;
    }
    if (bust) break;
    if (dayDDPaused) continue;
    if (martLevel >= cfg.levels) martLevel = cfg.levels - 1; // cap, no auto-reset
    const stake = round2(cfg.base * Math.pow(cfg.mart, martLevel));
    if (stake < MIN_STAKE) { martLevel = 0; continue; }
    const commission = round2(stake * COMMISSION_FRAC);
    if (balance < stake + commission) { bust = true; bustEpoch = sigEpoch; break; }
    if (sig.idx + 1 >= allCandles.length) continue;
    const finBar = allCandles[sig.idx + 1];
    const finalE = finBar.open - finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < allCandles.length; j++) {
      const b = allCandles[j];
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
    if (balance > dayPeak) dayPeak = balance;
    if (balance < trough) trough = balance;
    if (exit === "tp") { martLevel = 0; wins++; curStreak = 0; }
    else {
      martLevel++;
      losses++;
      curStreak++;
      if (curStreak > maxStreak) maxStreak = curStreak;
    }
    trades++;
    if (cfg.ddFrac > 0 && dayPeak > 0 && (dayPeak - balance) / dayPeak >= cfg.ddFrac) dayDDPaused = true;
  }
  return { cfg, bust, bustEpoch, finalBal: balance, peak, trough, trades, wins, losses, ddDays, maxStreak };
}

async function main() {
  console.log(`RDBEAR full-year sweep — ${TOTAL_DAYS} days (Jan 1 2025 → today)\n`);

  const c = new C(); await c.ready;
  const need = Math.ceil((TODAY - JAN_1_2025) / GR) + 200;
  console.log(`Fetching ${need} bars...`);
  const candles = await fetchPaged(c, SYM, GR, need, TODAY);
  c.close();
  console.log(`  got ${candles.length} bars (${(candles.length * GR / 86400).toFixed(1)} days)\n`);

  const allSigs = detect(candles);
  const filtered = allSigs.filter((s) => candles[s.idx].epoch >= JAN_1_2025);
  console.log(`Total signals in range: ${filtered.length}\n`);

  const configs: Cfg[] = [
    // FLAT STAKE (mart=1.0, levels=1) — no recovery, no chain-bust risk
    { label: "$100/$1 FLAT no-filter",                   acctInit: 100,  base: 1,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
    { label: "$100/$2 FLAT no-filter",                   acctInit: 100,  base: 2,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
    { label: "$100/$3 FLAT no-filter",                   acctInit: 100,  base: 3,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
    { label: "$100/$5 FLAT no-filter",                   acctInit: 100,  base: 5,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
    { label: "$100/$3 FLAT distSma200≥1.5",              acctInit: 100,  base: 3,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: 1.5,       acctReset: false },
    { label: "$100/$5 FLAT distSma200≥1.5",              acctInit: 100,  base: 5,  mart: 1.0, levels: 1, ddFrac: 0,    minDistSma200: 1.5,       acctReset: false },
    { label: "$500/$3 mart1.7/L8 NO-DD no-filter",       acctInit: 500,  base: 3,  mart: 1.7, levels: 8, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
    { label: "$500/$3 mart1.7/L8 NO-DD distSma200≥1.5",  acctInit: 500,  base: 3,  mart: 1.7, levels: 8, ddFrac: 0,    minDistSma200: 1.5,       acctReset: false },
    { label: "$1000/$3 mart1.7/L8 NO-DD no-filter",      acctInit: 1000, base: 3,  mart: 1.7, levels: 8, ddFrac: 0,    minDistSma200: -Infinity, acctReset: false },
  ];

  const results: RunResult[] = [];
  for (const cfg of configs) {
    const r = run(candles, allSigs, JAN_1_2025, TODAY, cfg);
    results.push(r);
  }

  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`SWEEP RESULTS — persistent $100 balance through ${TOTAL_DAYS} days, sorted by survival + final balance`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  config                                          bust   trades   W   L   maxL   netΔ           peak     trough   DDdays`);
  results.sort((a, b) => {
    if (a.bust !== b.bust) return a.bust ? 1 : -1;
    return b.finalBal - a.finalBal;
  });
  for (const r of results) {
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const bustStr = r.bust ? `💀 ${new Date(r.bustEpoch * 1000).toISOString().slice(0,10)}` : "  no";
    const delta = r.finalBal - r.cfg.acctInit;
    console.log(`  ${r.cfg.label.padEnd(48)}  ${bustStr.padEnd(13)}  ${String(r.trades).padStart(4)}t   ${String(r.wins).padStart(3)} ${String(r.losses).padStart(3)}   L${r.maxStreak}    ${delta >= 0 ? "+" : ""}$${delta.toFixed(0).padStart(7)}    $${r.peak.toFixed(0).padStart(6)}   $${r.trough.toFixed(0).padStart(5)}   ${String(r.ddDays).padStart(3)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// RDBEAR honest Deriv-style 48h continuous run.
// Yesterday + today, persistent balance, 8 mart levels no reset, no DD pause.
// $100 acct / $3 base / 1.7× / L8 — bust risk profile.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE = Number(process.env.STAKE ?? 3);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 8);
const PER_TRADE_CAP = 2000;     // Deriv stake limit, not a strategy cap
const MIN_STAKE = 0.31;         // Deriv MULT min stake
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
// NO DD CIRCUIT.

const LOOKBACK = 15;
const KATR = 2.5;
const MOM_RATIO = 0.7;
// NO regime filter (matches stripped production).

const SYM = "RDBEAR";
const GR = 300;

const NOW = Math.floor(Date.now() / 1000);
const Y_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate() - 1,
) / 1000);

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

async function main() {
  const days = (NOW - Y_START) / 86400;
  console.log(`RDBEAR honest 48h continuous — ${days.toFixed(2)} days from yesterday 00:00 UTC to now`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L (no reset)  NO DD-pause`);
  console.log(`Mart stake table:`);
  for (let l = 0; l < MAX_LEVELS; l++) {
    const stk = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, l)));
    console.log(`  L${l}: $${stk.toFixed(2)}`);
  }
  console.log();

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 800, NOW);
  c.close();

  const sigs = detect(candles).filter((s) => candles[s.idx].epoch >= Y_START && candles[s.idx].epoch < NOW);
  console.log(`Signals fired: ${sigs.length}\n`);

  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let peak = ACCT, trough = ACCT;
  let trades = 0, wins = 0, losses = 0;
  let maxConsecLoss = 0, curConsecLoss = 0;
  const log: Array<{ ts: string; lvl: number; stake: number; result: "TP" | "SL"; pnl: number; bal: number }> = [];

  for (const sig of sigs) {
    if (bust) break;
    if (martLevel >= MAX_LEVELS) martLevel = MAX_LEVELS - 1; // CAP at top, no reset
    const stake = round2(Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART, martLevel)));
    if (stake < MIN_STAKE) { martLevel = 0; continue; }
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
    if (balance < trough) trough = balance;
    const ts = new Date(candles[sig.idx].epoch * 1000).toISOString().slice(5, 16).replace("T", " ");
    log.push({ ts, lvl: martLevel, stake, result: exit === "tp" ? "TP" : "SL", pnl: net, bal: balance });
    if (exit === "tp") {
      martLevel = 0;
      wins++;
      curConsecLoss = 0;
    } else {
      martLevel++;       // NO auto-reset at MAX_LEVELS — capped at top instead.
      losses++;
      curConsecLoss++;
      if (curConsecLoss > maxConsecLoss) maxConsecLoss = curConsecLoss;
    }
    trades++;
  }

  // Detailed log
  console.log(`TRADE-BY-TRADE LOG:`);
  console.log(`  ts          lvl   stake     result   pnl      balance`);
  for (const e of log) {
    console.log(`  ${e.ts.padEnd(11)}  L${e.lvl}   $${e.stake.toFixed(2).padStart(7)}   ${e.result}     ${e.pnl >= 0 ? "+" : ""}$${e.pnl.toFixed(2).padStart(6)}   $${e.bal.toFixed(2).padStart(7)}`);
  }

  console.log(`\n${"".padEnd(70, "═")}`);
  console.log(`SUMMARY — RDBEAR honest 48h ($100 / $3 / 1.7× / L8 no reset / NO DD)`);
  console.log(`${"".padEnd(70, "═")}`);
  console.log(`  Final balance:    $${balance.toFixed(2)}  (Δ ${balance - ACCT >= 0 ? "+" : ""}$${(balance - ACCT).toFixed(2)})`);
  console.log(`  Peak:             $${peak.toFixed(2)}`);
  console.log(`  Trough:           $${trough.toFixed(2)}  (max DD: ${((peak - trough)/peak*100).toFixed(1)}%)`);
  console.log(`  Trades:           ${trades}  (${wins}W / ${losses}L)  WR ${trades > 0 ? (wins/trades*100).toFixed(1) : 0}%`);
  console.log(`  Max consec loss:  ${maxConsecLoss}`);
  console.log(`  Bust:             ${bust ? "💀 YES" : "no"}`);
  console.log(`  Signals skipped (insuff bal):  ${sigs.length - trades}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

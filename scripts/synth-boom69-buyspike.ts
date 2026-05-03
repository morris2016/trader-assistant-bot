// BOOM 600 + 900 BUY-the-drift screener.
// Reverse premise: instead of SELLing drift (which loses to rare up-spikes),
// BUY into drift dips with WIDE TPs that profit when the eventual up-spike
// fires. Tight SL on recent low. The spike itself is the win condition.
// Three variants on entry trigger:
//   A) RED1   — BUY on close after 1 red bar
//   B) RED2   — BUY on close after 2 reds
//   C) RED3   — BUY on close after 3 reds (deeper dip)
// All variants: SL = last 3-bar low - 0.2×ATR. TP = TP_ATR×ATR (configurable).

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const PER_TRADE_CAP = Number(process.env.CAP ?? 30);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;
const DD_FRAC = 0.60;

const ATR_PERIOD = 14;
const TP_ATR = Number(process.env.TP_ATR ?? 2.0);
const SL_BUFFER_ATR = 0.2;
const SL_LOOKBACK = 3;

const ASSETS = [
  { sym: "BOOM600", gr: 60 },
  { sym: "BOOM900", gr: 60 },
];

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);

const WINDOWS = [
  { offset: 4, startH: 0, endH: 24, label: "4d 00-24h" },
  { offset: 7, startH: 8, endH: 32, label: "7d 08-32h" },
  { offset: 12, startH: 20, endH: 44, label: "12d 20-44h" },
  { offset: 20, startH: 4, endH: 28, label: "20d 04-28h" },
  { offset: 25, startH: 16, endH: 40, label: "25d 16-40h" },
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

type Sig = { idx: number; side: "BUY"; entry: number; stop: number; target: number };
type Variant = "RED1" | "RED2" | "RED3";

function detect(candles: Candle[], variant: Variant): Sig[] {
  const need = variant === "RED1" ? 1 : variant === "RED2" ? 2 : 3;
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + need + SL_LOOKBACK; i < candles.length; i++) {
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    let red = true;
    for (let k = 0; k < need; k++) {
      const b = candles[i - k];
      if (!(b.close < b.open)) { red = false; break; }
    }
    if (!red) continue;
    let lo = Infinity;
    for (let m = i - SL_LOOKBACK + 1; m <= i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const cur = candles[i];
    const entry = cur.close;
    const stop = lo - SL_BUFFER_ATR * a;
    const target = entry + TP_ATR * a;
    if (stop >= entry || target <= 0) continue;
    out.push({ idx: i, side: "BUY", entry, stop, target });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

function honestSim(candles: Candle[], variant: Variant, ws: number, we: number) {
  const sigs = detect(candles, variant).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
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
    const finalE = finBar.open + finBar.open * ENTRY_SPREAD_FRAC;
    const delta = finalE - sig.entry;
    const stop = sig.stop + delta;
    const target = sig.target + delta;
    let exit: "tp" | "sl" | null = null;
    let exitPrice = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.low <= stop) { exit = "sl"; exitPrice = stop - stop * SL_SLIPPAGE_FRAC; break; }
      if (b.high >= target) { exit = "tp"; exitPrice = target; break; }
    }
    if (!exit) continue;
    const move = (exitPrice - finalE) / finalE;
    let netRaw = stake * MULT * move - commission;
    if (netRaw < -stake) netRaw = -stake;
    const net = round2(netRaw);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (exit === "tp") { martLevel = 0; wins++; } else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak };
}

async function main() {
  console.log(`BOOM 600 + 900 BUY-the-drift (catch the spike) @ 1m`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}`);
  console.log(`TP=${TP_ATR}×ATR  SL=last-${SL_LOOKBACK}-low - ${SL_BUFFER_ATR}×ATR  DD-pause=${(DD_FRAC*100).toFixed(0)}%\n`);

  const c = new C(); await c.ready;
  type Row = { sym: string; variant: Variant; window: string; trades: number; wr: number; final: number; status: string; tps: number };
  const rows: Row[] = [];
  const variants: Variant[] = ["RED1", "RED2", "RED3"];

  for (const a of ASSETS) {
    for (const win of WINDOWS) {
      const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
      const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
      let candles: Candle[] | null = null;
      try { candles = await fetchPaged(c, a.sym, a.gr, 5000, we_); }
      catch (e) { console.log(`  ${a.sym} ${win.label}: fetch fail ${(e as Error).message}`); continue; }
      for (const v of variants) {
        const r = honestSim(candles, v, ws_, we_);
        const wr = r.trades > 0 ? r.wins / r.trades : 0;
        const status = r.bust ? "💀 BUST" : r.ddPaused ? "⏸ DD-paused" : r.trades === 0 ? "—" : "✓";
        const hours = (win.endH - win.startH);
        rows.push({ sym: a.sym, variant: v, window: win.label, trades: r.trades, wr, final: r.finalBal, status, tps: r.trades / hours });
      }
    }
  }
  c.close();

  for (const a of ASSETS) {
    for (const v of variants) {
      const arr = rows.filter((r) => r.sym === a.sym && r.variant === v);
      console.log(`\n══ ${a.sym}  ·  ${v} ═══════════════════════════════════════════════════════════════`);
      for (const r of arr) {
        const dPct = ((r.final - ACCT) / ACCT * 100).toFixed(0);
        console.log(`  ${r.window.padEnd(13)}  ${String(r.trades).padStart(4)}t   ${r.tps.toFixed(1).padStart(5)}/hr  ${(r.wr*100).toFixed(0).padStart(2)}%  $${r.final.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${r.status}`);
      }
      const winners = arr.filter((r) => r.final > ACCT).length;
      const busts = arr.filter((r) => r.status.includes("BUST") || r.status.includes("paused")).length;
      const totalReturn = arr.reduce((s, r) => s + (r.final - ACCT), 0);
      const totalTrades = arr.reduce((s, r) => s + r.trades, 0);
      console.log(`  TOTAL ${arr.length}w  ${winners}W / ${busts} bust-pause  Δ ${totalReturn >= 0 ? "+" : ""}$${totalReturn.toFixed(2)}  ${totalTrades}t`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

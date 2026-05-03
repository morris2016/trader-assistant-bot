// BOOM 300N mean-reversion at 5m — apply the RDBEAR-validated framework to
// BOOM300N. BOOM300N has structural DOWN-drift between up-spikes, so:
//   • Up-pierce of prior 15-bar high → fade with SELL
//   • Gated by efficiency<0.30 (chop) + minADX 22
//   • SELL-only (fade with the bear-drift)
// Goal: complement the existing 1m spike-fade with a slower 5m mean-rev sister.

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = 50;
const BASE_STAKE = 5;
const MART = 1.7;
const MAX_LEVELS = 3;
const PER_TRADE_CAP = 50;
const DD_FRAC = 0.60;
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

const SYM = "BOOM300N";
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
  { offset: 20, startH: 4, endH: 52, label: "20d 04-52h" },
  { offset: 25, startH: 16, endH: 64, label: "25d 16-64h" },
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
    const dist = KATR * a;
    // SELL-only: fade up-pierces with SELLs (BOOM300N has down-drift between spikes)
    if (cur.close > hi && closePosUp >= MOM_RATIO) {
      out.push({ idx: i, side: "SELL", entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
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
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak };
}

async function main() {
  console.log(`BOOM300N mean-rev SELL-only @ 5m — RDBEAR framework applied`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L  DD-pause=${(DD_FRAC*100).toFixed(0)}%\n`);

  const c = new C(); await c.ready;
  type Row = { window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];
  for (const win of WINDOWS) {
    const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
    const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
    let candles: Candle[] | null = null;
    try { candles = await fetchPaged(c, SYM, GR, 9000, we_); }
    catch (e) { console.log(`  ${win.label}: fetch fail ${(e as Error).message}`); continue; }
    const allSigs = detect(candles);
    const r = honestSim(candles, allSigs, ws_, we_);
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const status = r.bust ? "💀 BUST" : r.ddPaused ? "⏸ DD-paused" : r.trades === 0 ? "—" : "✓";
    rows.push({ window: win.label, trades: r.trades, wr, final: r.finalBal, status });
  }
  c.close();

  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  window         trades   WR    final     Δ%      result`);
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  let total = 0, totalT = 0, winners = 0, busts = 0;
  for (const r of rows) {
    const d = r.final - ACCT; total += d; totalT += r.trades;
    if (r.final > ACCT) winners++;
    if (r.status.includes("BUST") || r.status.includes("paused")) busts++;
    console.log(`  ${r.window.padEnd(13)}  ${String(r.trades).padStart(3)}t   ${(r.wr*100).toFixed(0).padStart(2)}%  $${r.final.toFixed(2).padStart(7)}  ${d >= 0 ? "+" : ""}$${d.toFixed(2).padStart(6)}  ${r.status}`);
  }
  console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
  console.log(`  ${rows.length} windows · ${winners} winners · ${busts} bust-or-paused · ${totalT} trades · total Δ: ${total >= 0 ? "+" : ""}$${total.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

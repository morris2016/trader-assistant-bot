// BOOM 600 + 900 slower-timeframe + no-mart catch-spike screener.
// Two regimes:
//   (1) DRIFT-5m  — SELL-the-drift at 5m with martingale, TP=0.4×ATR, SL above pullback.
//   (2) DRIFT-15m — same but at 15m.
//   (3) CATCH     — no-mart BUY catch-spike at 1m, single stake, TP=5×ATR, SL last-3-low.
//   (4) CATCH-WIDE — same but TP=10×ATR (full spike-magnitude catch).

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

const ASSETS = ["BOOM600", "BOOM900"];

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

function detectDriftSell(candles: Candle[], tpAtr: number, slBufAtr: number): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    const prev = candles[i - 1];
    const cur = candles[i];
    if (!(prev.close > prev.open && cur.close < cur.open)) continue;
    const entry = cur.close;
    const stop = Math.max(prev.high, cur.high) + slBufAtr * a;
    const target = entry - tpAtr * a;
    if (stop <= entry || target <= 0) continue;
    out.push({ idx: i, side: "SELL", entry, stop, target });
  }
  return out;
}

function detectCatchBuy(candles: Candle[], tpAtr: number, slBufAtr: number, slLb: number): Sig[] {
  const out: Sig[] = [];
  for (let i = ATR_PERIOD + slLb + 1; i < candles.length; i++) {
    const a = atr(candles, i, ATR_PERIOD);
    if (a <= 0) continue;
    const cur = candles[i];
    if (!(cur.close < cur.open)) continue;
    let lo = Infinity;
    for (let m = i - slLb + 1; m <= i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const entry = cur.close;
    const stop = lo - slBufAtr * a;
    const target = entry + tpAtr * a;
    if (stop >= entry || target <= 0) continue;
    out.push({ idx: i, side: "BUY", entry, stop, target });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type SimCfg = { martOn: boolean };

function honestSim(candles: Candle[], sigs: Sig[], ws: number, we: number, cfg: SimCfg) {
  const filtered = sigs.filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  let balance = ACCT;
  let martLevel = 0;
  let bust = false;
  let ddPaused = false;
  let peak = ACCT;
  let trades = 0, wins = 0, losses = 0;

  for (const sig of filtered) {
    if (ddPaused) break;
    if (cfg.martOn && martLevel >= MAX_LEVELS) martLevel = 0;
    const stakeRaw = cfg.martOn ? BASE_STAKE * Math.pow(MART, martLevel) : BASE_STAKE;
    const stake = round2(Math.min(PER_TRADE_CAP, stakeRaw));
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
    if (exit === "tp") { if (cfg.martOn) martLevel = 0; wins++; } else { if (cfg.martOn) { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; } losses++; }
    trades++;
    if (DD_FRAC > 0 && peak > 0 && (peak - balance) / peak >= DD_FRAC) ddPaused = true;
  }
  return { trades, wins, losses, bust, ddPaused, finalBal: balance, peak };
}

async function main() {
  console.log(`BOOM 600 + 900 slow + catch screener`);
  console.log(`ACCT=$${ACCT}  STAKE=$${BASE_STAKE}  MART=${MART}× × ${MAX_LEVELS}L (where on)  CAP=$${PER_TRADE_CAP}\n`);

  const c = new C(); await c.ready;
  type Row = { sym: string; tag: string; window: string; trades: number; wr: number; final: number; status: string };
  const rows: Row[] = [];

  type Cfg = {
    tag: string;
    gr: number;
    detect: (candles: Candle[]) => Sig[];
    martOn: boolean;
  };
  const CFGS: Cfg[] = [
    { tag: "DRIFT-5m  (SELL pull, TP0.4 SL+0.2, mart)",   gr: 300,  detect: (cs) => detectDriftSell(cs, 0.4, 0.2), martOn: true },
    { tag: "DRIFT-15m (SELL pull, TP0.4 SL+0.2, mart)",   gr: 900,  detect: (cs) => detectDriftSell(cs, 0.4, 0.2), martOn: true },
    { tag: "CATCH-1m  (BUY red, TP5  SL3low-0.2, NO-mart)", gr: 60, detect: (cs) => detectCatchBuy(cs, 5.0, 0.2, 3), martOn: false },
    { tag: "CATCH-1m  (BUY red, TP10 SL3low-0.2, NO-mart)", gr: 60, detect: (cs) => detectCatchBuy(cs, 10.0, 0.2, 3), martOn: false },
  ];

  for (const sym of ASSETS) {
    for (const cfg of CFGS) {
      for (const win of WINDOWS) {
        const ws_ = (TODAY_START - win.offset * 86400) + win.startH * 3600;
        const we_ = (TODAY_START - win.offset * 86400) + win.endH * 3600;
        const need = cfg.gr <= 60 ? 5000 : cfg.gr <= 300 ? 2500 : 1000;
        let candles: Candle[] | null = null;
        try { candles = await fetchPaged(c, sym, cfg.gr, need, we_); }
        catch (e) { console.log(`  ${sym} ${cfg.tag} ${win.label}: fetch fail`); continue; }
        const sigs = cfg.detect(candles);
        const r = honestSim(candles, sigs, ws_, we_, { martOn: cfg.martOn });
        const wr = r.trades > 0 ? r.wins / r.trades : 0;
        const status = r.bust ? "BUST" : r.ddPaused ? "DD" : r.trades === 0 ? "—" : "ok";
        rows.push({ sym, tag: cfg.tag, window: win.label, trades: r.trades, wr, final: r.finalBal, status });
      }
    }
  }
  c.close();

  for (const sym of ASSETS) {
    for (const cfg of CFGS) {
      const arr = rows.filter((r) => r.sym === sym && r.tag === cfg.tag);
      console.log(`\n══ ${sym}  ·  ${cfg.tag} ══`);
      for (const r of arr) {
        const dPct = ((r.final - ACCT) / ACCT * 100).toFixed(0);
        console.log(`  ${r.window.padEnd(4)}  ${String(r.trades).padStart(4)}t  ${(r.wr*100).toFixed(0).padStart(3)}%  $${r.final.toFixed(2).padStart(7)}  ${dPct.padStart(4)}%  ${r.status}`);
      }
      const winners = arr.filter((r) => r.final > ACCT).length;
      const busts = arr.filter((r) => r.status === "BUST" || r.status === "DD").length;
      const tot = arr.reduce((s, r) => s + (r.final - ACCT), 0);
      const totT = arr.reduce((s, r) => s + r.trades, 0);
      console.log(`  TOTAL  ${winners}W  ${busts} bust/DD  Δ ${tot >= 0 ? "+" : ""}$${tot.toFixed(2)}  ${totT}t`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

// RDBEAR breakout 5m — MART → DE-RISK → PAROLI → restore-to-MART state machine.
//
// Modes:
//   MART:   stake = currentBase × MART^level; win→L0, loss→L+1 (capped at MAX_LEVELS).
//   PAROLI: stake = paroliStake; win→escalate by MART; loss→reset to currentBase.
//
// Transitions:
//   MART trade closes & DD ≥ DD_FRAC  → halve currentBase, switch to PAROLI,
//                                       paroliStake = currentBase, peak resets.
//   PAROLI win: nextStake = paroliStake × MART
//     • nextStake ≥ TARGET_BASE  → switch back to MART at TARGET_BASE, L0.
//     • else                     → stay PAROLI with paroliStake = nextStake.
//   PAROLI loss: paroliStake resets to currentBase. Stay PAROLI.
//   PAROLI trade closes & DD ≥ DD_FRAC → halve again (de-risk-while-de-risked).

import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT = Number(process.env.ACCT ?? 100);
const BASE_STAKE_INITIAL = Number(process.env.STAKE ?? 25);
const TARGET_BASE = BASE_STAKE_INITIAL; // paroli must restore stake to this before MART resumes
const MART = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 3);
const PER_TRADE_CAP = Number(process.env.CAP ?? 100);
const DD_FRAC = Number(process.env.DD_FRAC ?? 0.40);
const MIN_BASE_STAKE = Number(process.env.MIN_STAKE ?? 1);
const MULT = 100;
const COMMISSION_FRAC = 0.005;
const ENTRY_SPREAD_FRAC = 1 / 10000;
const SL_SLIPPAGE_FRAC = 5 / 10000;

const SYM = "RDBEAR";
const GR = 300;

const TODAY_START = Math.floor(Date.UTC(
  new Date().getUTCFullYear(),
  new Date().getUTCMonth(),
  new Date().getUTCDate(),
) / 1000);
const DAY_OFFSET = Number(process.env.DAY_OFFSET ?? 2);
const START_HOUR = Number(process.env.START_HOUR ?? 14);
const END_HOUR = Number(process.env.END_HOUR ?? 62);
const TARGET_DAY_START = TODAY_START - DAY_OFFSET * 86400;
const ws = TARGET_DAY_START + START_HOUR * 3600;
const we = TARGET_DAY_START + END_HOUR * 3600;

type Variant = { name: string; lookback: number; kAtr: number; momRatio: number; atrPeriod: number };
const VARIANTS: Variant[] = [
  { name: "#1 baseline    (15/2.0/0.70/14)", lookback: 15, kAtr: 2.0, momRatio: 0.70, atrPeriod: 14 },
  { name: "#7 higher kAtr (15/2.5/0.70/14)", lookback: 15, kAtr: 2.5, momRatio: 0.70, atrPeriod: 14 },
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

type Sig = { idx: number; entry: number; stop: number; target: number };
function detect(candles: Candle[], v: Variant): Sig[] {
  const out: Sig[] = [];
  for (let i = Math.max(v.lookback, v.atrPeriod) + 1; i < candles.length; i++) {
    const a = atr(candles, i, v.atrPeriod);
    if (a <= 0) continue;
    let lo = Infinity;
    for (let m = i - v.lookback; m < i; m++) if (candles[m].low < lo) lo = candles[m].low;
    const cur = candles[i];
    const r = cur.high - cur.low;
    if (r <= 0) continue;
    if (!(cur.close < lo)) continue;
    const closePosDn = (cur.high - cur.close) / r;
    if (closePosDn < v.momRatio) continue;
    const dist = v.kAtr * a;
    out.push({ idx: i, entry: cur.close, stop: cur.close + dist, target: cur.close - dist });
  }
  return out;
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Trade = { sigT: string; closeT: string; mode: "MART" | "PAROLI"; level: number; base: number; stake: number; exit: "tp" | "sl"; net: number; bal: number; ddPct: number; modeChange: string };

function honestSimMartParoli(candles: Candle[], v: Variant): { trades: Trade[]; bust: boolean; deRisks: number; restores: number; finalBal: number; peak: number; trough: number } {
  const sigs = detect(candles, v).filter((s) => candles[s.idx].epoch >= ws && candles[s.idx].epoch < we);
  const trades: Trade[] = [];
  let balance = ACCT;
  let mode: "MART" | "PAROLI" = "MART";
  let currentBase = BASE_STAKE_INITIAL;
  let martLevel = 0;
  let paroliStake = currentBase;
  let peak = ACCT;
  let trough = ACCT;
  let bust = false;
  let deRisks = 0;
  let restores = 0;

  for (const sig of sigs) {
    // Compute stake based on mode
    let stake: number;
    if (mode === "MART") {
      if (martLevel >= MAX_LEVELS) martLevel = 0;
      stake = round2(Math.min(PER_TRADE_CAP, currentBase * Math.pow(MART, martLevel)));
    } else {
      stake = round2(Math.min(PER_TRADE_CAP, paroliStake));
    }
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
    let exitEpoch = 0;
    for (let j = sig.idx + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stop) { exit = "sl"; exitPrice = stop + stop * SL_SLIPPAGE_FRAC; exitEpoch = b.epoch; break; }
      if (b.low <= target) { exit = "tp"; exitPrice = target; exitEpoch = b.epoch; break; }
    }
    if (!exit) continue;

    const move = (finalE - exitPrice) / finalE;
    const net = round2(stake * MULT * move - commission);
    balance = round2(balance + net);
    if (balance > peak) peak = balance;
    if (balance < trough) trough = balance;
    const ddPct = peak > 0 ? (peak - balance) / peak : 0;
    const closeT = new Date(exitEpoch * 1000).toISOString().slice(11, 19);

    let modeChange = "";
    const tradeMode = mode;
    const tradeLevel = mode === "MART" ? martLevel : 0;
    const tradeBase = currentBase;

    // Update state based on mode + outcome
    if (mode === "MART") {
      if (exit === "tp") martLevel = 0;
      else { martLevel++; if (martLevel >= MAX_LEVELS) martLevel = 0; }
    } else {
      // PAROLI
      if (exit === "tp") {
        const nextStake = round2(paroliStake * MART);
        if (nextStake >= TARGET_BASE) {
          // Recovered — switch back to MART
          mode = "MART";
          currentBase = TARGET_BASE;
          martLevel = 0;
          peak = balance; // reset peak so next DD measures from here
          modeChange = " ↑restore→MART";
          restores++;
        } else {
          paroliStake = nextStake;
        }
      } else {
        paroliStake = currentBase; // reset paroli on loss
      }
    }

    // Check DD breach AFTER state update.
    // Halving continues on each successive DD trip until currentBase reaches
    // MIN_BASE_STAKE. Once at the floor, the bot stays at MIN_STAKE indefinitely
    // (in PAROLI mode) — losses don't de-risk further, wins escalate paroli
    // back toward TARGET_BASE.
    if (ddPct >= DD_FRAC) {
      const halved = round2(Math.max(MIN_BASE_STAKE, currentBase / 2));
      if (halved < currentBase) {
        currentBase = halved;
        paroliStake = halved;
        martLevel = 0;
        mode = "PAROLI";
        peak = balance;
        modeChange = ` ⚙de-risk→PAROLI base=$${halved}`;
        deRisks++;
      } else {
        // Already at the floor — clamp peak so DD% doesn't spiral, force
        // PAROLI mode if we somehow ended up in MART at MIN_STAKE.
        peak = balance;
        if (mode === "MART") {
          mode = "PAROLI";
          paroliStake = currentBase;
          modeChange = ` ⚙floor-hold @ $${currentBase} (PAROLI)`;
        } else if (modeChange === "") {
          modeChange = ` ⚙floor-hold @ $${currentBase}`;
        }
      }
    }

    trades.push({
      sigT: new Date(candles[sig.idx].epoch * 1000).toISOString().slice(11, 19),
      closeT, mode: tradeMode, level: tradeLevel, base: tradeBase, stake, exit, net, bal: balance, ddPct,
      modeChange,
    });
  }
  return { trades, bust, deRisks, restores, finalBal: balance, peak, trough };
}

async function main() {
  const dateStr = new Date(TARGET_DAY_START * 1000).toISOString().slice(0, 10);
  console.log(`HONEST mart→paroli state machine — RDBEAR breakout 5m`);
  console.log(`${dateStr} ${START_HOUR}:00→${END_HOUR}:00 UTC  (${(END_HOUR-START_HOUR)}h)`);
  console.log(`ACCT=$${ACCT}  BASE=$${BASE_STAKE_INITIAL}  MART=${MART}× × ${MAX_LEVELS}L  CAP=$${PER_TRADE_CAP}  DD=${(DD_FRAC*100).toFixed(0)}%`);
  console.log(`DD breach → halve base + switch to PAROLI; PAROLI win-streak ≥ TARGET_BASE → restore to MART\n`);

  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, 9000, we);
  c.close();
  console.log(`Fetched ${candles.length} bars\n`);

  for (const v of VARIANTS) {
    const r = honestSimMartParoli(candles, v);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
    console.log(`${v.name}`);
    console.log(`══════════════════════════════════════════════════════════════════════════════════════`);
    if (r.trades.length === 0) { console.log("  no trades\n"); continue; }
    const wins = r.trades.filter((t) => t.net > 0).length;
    const losses = r.trades.filter((t) => t.net < 0).length;
    const wr = wins / r.trades.length;
    const status = r.bust ? "💀 BUST" : `de-risks=${r.deRisks} restores=${r.restores}`;
    console.log(`  ${status}  ${r.trades.length}t · ${wins}W/${losses}L · WR ${(wr*100).toFixed(0)}%`);
    console.log(`  ACCOUNT: $${ACCT.toFixed(2)} → $${r.finalBal.toFixed(2)} (${((r.finalBal-ACCT)/ACCT*100).toFixed(1)}%)  peak $${r.peak.toFixed(2)}  trough $${r.trough.toFixed(2)}`);
    console.log(`\n  ${"sigT".padEnd(8)}  ${"closeT".padEnd(8)}  mode    L  base  ${"stake".padStart(6)}  exit   ${"net".padStart(8)}  ${"bal".padStart(8)}  DD%   transition`);
    for (const t of r.trades) {
      const m = t.mode === "MART" ? "MART" : "PAR ";
      const lvlOrEmpty = t.mode === "MART" ? String(t.level) : " ";
      console.log(`  ${t.sigT}  ${t.closeT}  ${m}    ${lvlOrEmpty}  $${String(t.base).padStart(2)}   $${t.stake.toFixed(2).padStart(5)}  ${t.exit}    ${(t.net >= 0 ? "+" : "") + "$" + t.net.toFixed(2).padStart(6)}    $${t.bal.toFixed(2).padStart(7)}  ${(t.ddPct*100).toFixed(0).padStart(3)}%  ${t.modeChange}`);
    }
    console.log("");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

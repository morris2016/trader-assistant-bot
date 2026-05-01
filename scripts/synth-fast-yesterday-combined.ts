// Yesterday-only combined-account stress test.
// Runs the TOP 3 winners simultaneously in a SHARED account.
//   • Account starting balance: $50
//   • Base stake: $1.50
//   • Multiplier: 1.5× per loss (gentler than classic 2.2×)
//   • Max ladder depth: 5 levels (level 4 stake = $1.50 × 1.5^4 = $7.59)
//   • Cumulative bust cost = $1.50 × (1.5^5 - 1)/(1.5 - 1) = $19.78
//   • Each strategy has its OWN martingale ladder (independent escalation)
//   • All 3 strategies' P&L hits the SAME balance
//   • Up to 3 concurrent open positions (one per strategy)
//
// Strategies (top 3 by yesterday P&L from prior solo test):
//   1. spikeFade-CRASH300N-1m  (n=3.0, buf=0.2, tp=0.4, conf)
//   2. spikeFade-BOOM300N-1m   (n=3.0, buf=0.2, tp=0.4, conf)
//   3. driftPullback-CRASH300N-5m (k=3, kAtr=1.0, drift=up)

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const COST_BPS = 5.0;

const ACCT_BALANCE = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART_MULT = Number(process.env.MART ?? 1.5);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const TRADE_MULT = Number(process.env.MULT ?? 30);

const NOW = Math.floor(Date.now() / 1000);
// Allow override: WINDOW_START=<epoch> forces a specific 24h test window
// (e.g. WINDOW_START=1777593600 = 2026-04-27 00:00 UTC).
// WINDOW_END defaults to WINDOW_START + 86400.
const YESTERDAY_START = process.env.WINDOW_START
  ? Number(process.env.WINDOW_START)
  : NOW - 24 * 3600 - 30 * 60;
const YESTERDAY_END = process.env.WINDOW_END
  ? Number(process.env.WINDOW_END)
  : (process.env.WINDOW_START ? YESTERDAY_START + 86400 : NOW);

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() { this.connect(); }
  private connect() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
    this.ws.on("close", () => { for (const { reject } of this.pending.values()) reject(new Error("ws closed")); this.pending.clear(); });
    this.ws.on("error", () => {});
  }
  async reconnect(): Promise<void> {
    try { this.ws.close(); } catch {}
    for (const { reject } of this.pending.values()) reject(new Error("ws reconnecting"));
    this.pending.clear();
    await new Promise((r) => setTimeout(r, 1500));
    this.connect();
    await this.ready;
  }
  send(p: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ ...p, req_id: id })); }
      catch (e) { this.pending.delete(id); reject(e as Error); return; }
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
  let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    let r: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr }); break; }
      catch (e) { if (attempt === 3) throw e; await new Promise((res) => setTimeout(res, 1500 + attempt * 1200)); }
    }
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected);
    cursor = String(ch[0].epoch - 1);
    if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

type SimSignal = { idx: number; side: "BUY" | "SELL"; stopPrice: number; targetPrice: number };

function eqSig(idx: number, side: "BUY" | "SELL", entry: number, dist: number): SimSignal {
  return side === "BUY"
    ? { idx, side, stopPrice: entry - dist, targetPrice: entry + dist }
    : { idx, side, stopPrice: entry + dist, targetPrice: entry - dist };
}

function driftPullback(candles: Candle[], driftDir: 1 | -1, k: number, kAtr: number): SimSignal[] {
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  const sigs: SimSignal[] = [];
  for (let i = k; i < candles.length; i++) {
    let allAgainst = true;
    for (let m = i - k + 1; m <= i; m++) {
      const prev = candles[m - 1]?.close ?? candles[m].open;
      const mv = candles[m].close - prev;
      if (driftDir === 1 && mv >= 0) { allAgainst = false; break; }
      if (driftDir === -1 && mv <= 0) { allAgainst = false; break; }
    }
    if (!allAgainst) continue;
    const atr = atrAt(i);
    if (atr <= 0) continue;
    sigs.push(eqSig(i, driftDir === 1 ? "BUY" : "SELL", candles[i].close, kAtr * atr));
  }
  return sigs;
}

function spikeFade(candles: Candle[], spikeN: number, buf: number, tpFrac: number, conf: boolean): SimSignal[] {
  const sigs: SimSignal[] = [];
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: candles.map((c) => c.close) });
  const offset = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < offset ? 0 : atrSeries[i - offset]);
  for (let i = 16; i < candles.length - 1; i++) {
    const sp = candles[i];
    const range = sp.high - sp.low;
    const priorAtr = atrAt(i - 1);
    if (priorAtr <= 0) continue;
    if (range < spikeN * priorAtr) continue;
    const cf = candles[i + 1];
    if (conf) {
      const inside = cf.close <= sp.high && cf.close >= sp.low;
      if (!inside) continue;
    }
    const dirUp = sp.close >= sp.open;
    const fadeSide: "BUY" | "SELL" = dirUp ? "SELL" : "BUY";
    const bufD = buf * priorAtr;
    const entry = cf.close;
    let sl: number, tp: number;
    if (fadeSide === "SELL") { sl = sp.high + bufD; tp = entry - tpFrac * range; if (sl <= entry || tp >= entry) continue; }
    else { sl = sp.low - bufD; tp = entry + tpFrac * range; if (sl >= entry || tp <= entry) continue; }
    sigs.push({ idx: i + 1, side: fadeSide, stopPrice: sl, targetPrice: tp });
  }
  return sigs;
}

// ── Combined account simulation ───────────────────────────────────────────
type Strat = {
  id: string;
  symbol: string;
  granularity: number;     // 60 = 1m, 300 = 5m
  build: (candles: Candle[]) => SimSignal[];
};
type Position = {
  strategyId: string;
  side: "BUY" | "SELL";
  level: number;           // martingale ladder level at open
  stake: number;
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  symbol: string;
  granularity: number;
  openEpoch: number;
};
type Event =
  | { kind: "bar"; symbol: string; granularity: number; bar: Candle; idx: number }
  | { kind: "signal"; strategyId: string; symbol: string; granularity: number; sig: SimSignal; epoch: number };
type LedgerRow = {
  epoch: number;
  strategyId: string;
  symbol: string;
  side: "BUY" | "SELL";
  level: number;
  stake: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: "tp" | "sl" | "bankrupt";
  pnlUsd: number;
  balanceAfter: number;
};

const STRATS: Strat[] = [
  {
    id: "spike-CRASH300N-1m",
    symbol: "CRASH300N", granularity: 60,
    build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true),
  },
  {
    id: "spike-BOOM300N-1m",
    symbol: "BOOM300N", granularity: 60,
    build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true),
  },
  {
    id: "drift-CRASH300N-5m",
    symbol: "CRASH300N", granularity: 300,
    build: (c) => driftPullback(c, 1, 3, 1.0),
  },
];

async function main() {
  console.log("Yesterday combined-account stress test (3 strategies, shared $50).");
  console.log(`Base stake: $${BASE_STAKE}  ·  Martingale: ${MART_MULT}× per loss  ·  Max levels: ${MAX_LEVELS}`);
  const bustLoss = BASE_STAKE * (Math.pow(MART_MULT, MAX_LEVELS) - 1) / (MART_MULT - 1);
  const lvl4 = BASE_STAKE * Math.pow(MART_MULT, MAX_LEVELS - 1);
  console.log(`Theoretical bust cost (sum of stakes): $${bustLoss.toFixed(2)} · level 4 stake: $${lvl4.toFixed(2)}`);
  console.log("Note: actual $-loss per trade is much smaller — SL distance × MULT is typically 1-4% of stake.");
  console.log("");

  const c = new C(); await c.ready;
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(STRATS.map((s) => `${s.symbol}|${s.granularity}`)));
  for (const k of fetchKeys) {
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    // Bump fetch counts so we have warmup + window for back-dated tests
    // (e.g. April 27 from today = 4 days back). 8000 1m bars = ~5.5d; 1500 5m = ~5.2d.
    const cnt = gr === 60 ? 8000 : 1500;
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars)...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, gr, cnt); break; }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      console.log(` ${candles.length} bars (${span.toFixed(1)}d)`);
      cache.set(k, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  // Build per-strategy signals + per-(sym,gr) candle list.
  const stratSignals = new Map<string, SimSignal[]>();
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    if (!candles) { stratSignals.set(s.id, []); continue; }
    stratSignals.set(s.id, s.build(candles));
  }

  // Build a global event stream:
  //   • Each candle close fires a "bar" event for SL/TP checking (per sym×gr).
  //   • Each strategy signal fires a "signal" event.
  // We sort by epoch + tiebreaker (bar before signal at same epoch — bar's
  // own range may close a position before a new signal opens one).
  const events: Event[] = [];
  for (const k of fetchKeys) {
    const candles = cache.get(k)!;
    if (!candles) continue;
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      if (bar.epoch < YESTERDAY_START || bar.epoch >= YESTERDAY_END) continue;
      events.push({ kind: "bar", symbol: sym, granularity: gr, bar, idx: i });
    }
  }
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`)!;
    const sigs = stratSignals.get(s.id) ?? [];
    for (const sig of sigs) {
      const epoch = candles[sig.idx].epoch;
      if (epoch < YESTERDAY_START || epoch >= YESTERDAY_END) continue;
      events.push({ kind: "signal", strategyId: s.id, symbol: s.symbol, granularity: s.granularity, sig, epoch });
    }
  }
  events.sort((a, b) => {
    const ea = a.kind === "bar" ? a.bar.epoch : a.epoch;
    const eb = b.kind === "bar" ? b.bar.epoch : b.epoch;
    if (ea !== eb) return ea - eb;
    // Bars first, signals after — let intra-bar exits happen before new opens.
    return a.kind === "bar" ? -1 : 1;
  });

  // Run combined simulation.
  let balance = ACCT_BALANCE;
  let peak = ACCT_BALANCE;
  let trough = ACCT_BALANCE;
  const ladder: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const wins: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const losses: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const busts: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const open = new Map<string, Position>();   // strategy id → open pos
  const ledger: LedgerRow[] = [];
  const costFrac = COST_BPS / 10000;
  let bankrupt = false;

  for (const ev of events) {
    if (bankrupt) break;
    const epoch = ev.kind === "bar" ? ev.bar.epoch : ev.epoch;

    if (ev.kind === "bar") {
      // Check exit on any open position whose symbol matches AND whose granularity
      // matches the bar (so a 5m bar checks 5m positions, 1m bar checks 1m positions).
      for (const [sid, pos] of Array.from(open.entries())) {
        if (pos.symbol !== ev.symbol || pos.granularity !== ev.granularity) continue;
        let hit: "tp" | "sl" | null = null;
        if (pos.side === "BUY") {
          if (ev.bar.low <= pos.stopPrice) hit = "sl";
          else if (ev.bar.high >= pos.targetPrice) hit = "tp";
        } else {
          if (ev.bar.high >= pos.stopPrice) hit = "sl";
          else if (ev.bar.low <= pos.targetPrice) hit = "tp";
        }
        if (hit) {
          const exitPrice = hit === "tp" ? pos.targetPrice : pos.stopPrice;
          const gross = pos.side === "BUY"
            ? (exitPrice - pos.entryPrice) / pos.entryPrice
            : (pos.entryPrice - exitPrice) / pos.entryPrice;
          const pnlPct = gross - costFrac;
          const pnlUsd = pos.stake * Math.max(-1, pnlPct * TRADE_MULT);
          balance += pnlUsd;
          if (balance > peak) peak = balance;
          if (balance < trough) trough = balance;
          ledger.push({
            epoch: ev.bar.epoch,
            strategyId: pos.strategyId,
            symbol: pos.symbol,
            side: pos.side,
            level: pos.level,
            stake: pos.stake,
            entryPrice: pos.entryPrice,
            exitPrice,
            exitReason: hit,
            pnlUsd,
            balanceAfter: balance,
          });
          if (hit === "tp") {
            wins[sid]++;
            ladder[sid] = 0;
          } else {
            losses[sid]++;
            ladder[sid]++;
            if (ladder[sid] >= MAX_LEVELS) {
              busts[sid]++;
              ladder[sid] = 0;
            }
          }
          open.delete(sid);
          if (balance <= 0) {
            bankrupt = true;
            break;
          }
        }
      }
    } else {
      // signal event — open a position on this strategy if none open already
      const sid = ev.strategyId;
      if (open.has(sid)) continue; // already running
      const wantStake = BASE_STAKE * Math.pow(MART_MULT, ladder[sid]);
      if (wantStake > balance) {
        ledger.push({
          epoch,
          strategyId: sid,
          symbol: ev.symbol,
          side: ev.sig.side,
          level: ladder[sid],
          stake: wantStake,
          entryPrice: 0,
          exitPrice: 0,
          exitReason: "bankrupt",
          pnlUsd: 0,
          balanceAfter: balance,
        });
        bankrupt = true;
        break;
      }
      const candles = cache.get(`${ev.symbol}|${ev.granularity}`)!;
      const entry = candles[ev.sig.idx].close;
      open.set(sid, {
        strategyId: sid,
        side: ev.sig.side,
        level: ladder[sid],
        stake: wantStake,
        entryPrice: entry,
        stopPrice: ev.sig.stopPrice,
        targetPrice: ev.sig.targetPrice,
        symbol: ev.symbol,
        granularity: ev.granularity,
        openEpoch: epoch,
      });
    }
  }

  const endBalance = balance;
  const totalPnl = endBalance - ACCT_BALANCE;

  console.log("");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("COMBINED ACCOUNT — YESTERDAY RESULTS");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log(`Start: $${ACCT_BALANCE.toFixed(2)}  ·  End: $${endBalance.toFixed(2)}  ·  P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`Peak: $${peak.toFixed(2)}  ·  Trough: $${trough.toFixed(2)}  ·  Max DD: $${(peak - trough).toFixed(2)}`);
  console.log(bankrupt ? "💀 BANKRUPT" : (totalPnl >= 0 ? "✅ profit" : "❌ loss"));
  console.log("");
  console.log("Per-strategy contribution:");
  for (const s of STRATS) {
    const stratLedger = ledger.filter((r) => r.strategyId === s.id && r.exitReason !== "bankrupt");
    const stratPnl = stratLedger.reduce((a, r) => a + r.pnlUsd, 0);
    const w = wins[s.id], l = losses[s.id];
    const wr = (w + l) > 0 ? w / (w + l) : 0;
    const maxLevel = stratLedger.reduce((m, r) => Math.max(m, r.level), 0);
    const maxStake = stratLedger.reduce((m, r) => Math.max(m, r.stake), 0);
    const sign = stratPnl >= 0 ? "+" : "";
    console.log(`  ${s.id.padEnd(30)} ${stratLedger.length}t  ${w}W/${l}L  WR=${(wr * 100).toFixed(0)}%  P&L=${sign}$${stratPnl.toFixed(2)}  busts=${busts[s.id]}  maxLvl=${maxLevel}  maxStake=$${maxStake.toFixed(2)}`);
  }
  console.log("");

  // Time-ordered ledger summary
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("TIME-ORDERED LEDGER (first 40 / last 10)");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  const showRow = (r: LedgerRow) => {
    const t = new Date(r.epoch * 1000).toISOString().slice(11, 19);
    const sign = r.pnlUsd >= 0 ? "+" : "";
    const reason = r.exitReason === "tp" ? "✓TP" : r.exitReason === "sl" ? "✗SL" : "💀BUST";
    return `  ${t}  ${r.strategyId.padEnd(28)}  L${r.level}  $${r.stake.toFixed(2).padStart(6)}  ${reason}  ${sign}$${r.pnlUsd.toFixed(2).padStart(6)}  → $${r.balanceAfter.toFixed(2)}`;
  };
  const head = ledger.slice(0, 40);
  const tail = ledger.slice(-10);
  for (const r of head) console.log(showRow(r));
  if (ledger.length > 50) {
    console.log("  ... " + (ledger.length - 50) + " more ...");
    for (const r of tail) console.log(showRow(r));
  }
  console.log("");
  console.log(`Total trades: ${ledger.length}`);

  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  writeFileSync(".tmp/fast-yesterday-combined.json", JSON.stringify({
    timestamp: new Date().toISOString(),
    account: { balance: ACCT_BALANCE, baseStake: BASE_STAKE, multiplier: MART_MULT, maxLevels: MAX_LEVELS, tradeMultiplier: TRADE_MULT },
    yesterdayStartEpoch: YESTERDAY_START,
    strategies: STRATS.map((s) => ({ id: s.id, symbol: s.symbol, granularity: s.granularity })),
    summary: {
      startBalance: ACCT_BALANCE,
      endBalance,
      pnl: totalPnl,
      peak, trough, maxDD: peak - trough,
      bankrupt,
      perStrategy: Object.fromEntries(STRATS.map((s) => [s.id, {
        wins: wins[s.id], losses: losses[s.id], busts: busts[s.id],
      }])),
    },
    ledger,
  }, null, 2));
  console.log("Saved .tmp/fast-yesterday-combined.json");
}

main().catch((e) => { console.error(e); process.exit(1); });

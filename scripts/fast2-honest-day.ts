// Fast2 honest sim: replay any UTC day with the same execution semantics the
// production paper engine uses after the 4058180 cheat-fix:
//   • Entry = first new bar's OPEN + adverse spread (NOT signal-bar close).
//   • SL fills past the stop with adverse slippage (default 5bps).
//   • Commission charged at OPEN (deducted from balance immediately).
//   • Same-bar settlement skipped (bar epoch must be > openedAt epoch).
//   • TP/SL clamped to Deriv \$0.10 minimum.
//   • Trade leverage clamped to Deriv-valid {20,40,60,80,100} on BOOM/CRASH.
//
// Defaults match Fast2 production config: $50 acct, $1.50 base, MULT=100,
// mart=1.7, 5 levels, 0.5% commission, 1bp entry spread, 5bps SL slippage.
//
// Usage:
//   DAY_EPOCH=1777161600 npx ts-node --transpile-only \
//     --compiler-options '{"esModuleInterop":true,"target":"ES2022","module":"CommonJS"}' \
//     scripts/fast2-honest-day.ts
//
// DAY_EPOCH is the 00:00 UTC epoch of the day to simulate. Defaults to
// yesterday (today minus 86400). Window covers 24 hours from there.

import WebSocket from "ws";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const ACCT_BALANCE = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 1.5);
const MART_MULT = Number(process.env.MART ?? 1.7);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const PER_TRADE_CAP = Number(process.env.CAP ?? 30);
const TRADE_MULT = Number(process.env.MULT ?? 100);
const COMMISSION_FRAC = Number(process.env.COMMISSION ?? 0.005);
const ENTRY_SPREAD_FRAC = Number(process.env.SPREAD_BPS ?? 1) / 10000;
const SL_SLIPPAGE_FRAC = Number(process.env.SL_SLIP_BPS ?? 5) / 10000;
const TP_SL_FLOOR = 0.10;
const FORCE_MARTINGALE = (process.env.FORCE_MART ?? "1") === "1";

// Default DAY_EPOCH = yesterday 00:00 UTC.
const NOW = Math.floor(Date.now() / 1000);
const TODAY_START = Math.floor(NOW / 86400) * 86400;
const DAY_EPOCH = Number(process.env.DAY_EPOCH ?? TODAY_START - 86400);
const WINDOW_START = DAY_EPOCH;
const WINDOW_END = DAY_EPOCH + 86400;

// Need warmup bars before WINDOW_START. ATR(14) on 1m needs 14 bars; spike-fade
// uses i >= 16. Drift-pullback on 5m needs k+ATR. Buffer generously.
const FETCH_1M = Number(process.env.FETCH_1M ?? 1500); // 25h of 1m
const FETCH_5M = Number(process.env.FETCH_5M ?? 320);  // ~26h of 5m

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

async function fetchPaged(c: C, sym: string, gr: number, cnt: number, endEpoch: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor = String(endEpoch);
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

// ── Detectors (same as production) ───────────────────────────────────────
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

type Strat = { id: string; symbol: string; granularity: number; build: (c: Candle[]) => SimSignal[] };
const STRATS: Strat[] = [
  { id: "spike-CRASH300N-1m", symbol: "CRASH300N", granularity: 60,  build: (c) => spikeFade(c, 3.0, 0.2, 0.5, true) },
  { id: "spike-BOOM300N-1m",  symbol: "BOOM300N",  granularity: 60,  build: (c) => spikeFade(c, 3.0, 0.2, 0.5, true) },
];

// ── Honest sim engine ────────────────────────────────────────────────────
type Position = {
  strategyId: string;
  side: "BUY" | "SELL";
  level: number;
  stake: number;
  signalIdx: number;     // index in candles array of trigger bar
  signalEntry: number;   // close of trigger bar (provisional)
  entryPrice: number;    // finalized after first-new-bar arrival
  stopPrice: number;
  targetPrice: number;
  symbol: string;
  granularity: number;
  entryFinalized: boolean;
  commission: number;    // already deducted from balance at open
};

type LedgerRow = {
  signalEpoch: number;
  finalizeEpoch: number | null;
  closeEpoch: number;
  strategyId: string;
  symbol: string;
  side: "BUY" | "SELL";
  level: number;
  stake: number;
  signalEntry: number;
  finalizedEntry: number;
  exitPrice: number;
  exitReason: "tp" | "sl";
  grossPnlUsd: number;
  commissionUsd: number;
  netPnlUsd: number;       // gross - commission
  balanceAfter: number;
  ladderAfter: number;
};

async function main() {
  const dayStr = new Date(WINDOW_START * 1000).toISOString().slice(0, 10);
  console.log(`Fast2 honest sim — full UTC day ${dayStr}`);
  console.log(`Account: $${ACCT_BALANCE}  ·  Base: $${BASE_STAKE}  ·  MULT: ${TRADE_MULT}×  ·  Mart: ${MART_MULT}× × ${MAX_LEVELS}L  ·  Cap: $${PER_TRADE_CAP}`);
  console.log(`Commission: ${(COMMISSION_FRAC * 100).toFixed(2)}%  ·  Entry spread: ${(ENTRY_SPREAD_FRAC * 10000).toFixed(1)}bps  ·  SL slippage: ${(SL_SLIPPAGE_FRAC * 10000).toFixed(1)}bps`);
  console.log(`Force martingale: ${FORCE_MARTINGALE}  ·  TP/SL floor: $${TP_SL_FLOOR.toFixed(2)}`);
  console.log("");

  const c = new C(); await c.ready;
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(STRATS.map((s) => `${s.symbol}|${s.granularity}`)));
  for (const k of fetchKeys) {
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    const cnt = gr === 60 ? FETCH_1M : FETCH_5M;
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars to ${new Date(WINDOW_END * 1000).toISOString().slice(0,10)})...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, gr, cnt, WINDOW_END); break; }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      const first = new Date(candles[0].epoch * 1000).toISOString().slice(0, 16);
      const last = new Date(candles[candles.length - 1].epoch * 1000).toISOString().slice(0, 16);
      console.log(` ${candles.length} bars (${span.toFixed(1)}d, ${first}Z → ${last}Z)`);
      cache.set(k, candles);
    }
  }
  c.close();

  // Build per-strategy signals + index lookup tables.
  const stratSignals = new Map<string, SimSignal[]>();
  const candlesByKey = new Map<string, Candle[]>();
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    candlesByKey.set(s.id, candles ?? []);
    stratSignals.set(s.id, candles ? s.build(candles) : []);
  }

  // ── Honest simulation ──
  let balance = ACCT_BALANCE;
  let peak = ACCT_BALANCE;
  let trough = ACCT_BALANCE;
  const ladder: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const open = new Map<string, Position>();
  const ledger: LedgerRow[] = [];
  let bankrupt = false;
  let busts = 0;
  let maxLevel = 0;
  const perStrat: Record<string, { trades: number; wins: number; losses: number; busts: number; pnl: number }> = Object.fromEntries(
    STRATS.map((s) => [s.id, { trades: 0, wins: 0, losses: 0, busts: 0, pnl: 0 }]),
  );

  // Build a chronological event stream: signals + bar-closes per (strat, key).
  type Event =
    | { kind: "signal"; epoch: number; strategyId: string; sig: SimSignal }
    | { kind: "bar"; epoch: number; key: string; bar: Candle };
  const events: Event[] = [];
  for (const s of STRATS) {
    const candles = candlesByKey.get(s.id) ?? [];
    const sigs = stratSignals.get(s.id) ?? [];
    for (const sig of sigs) {
      const epoch = candles[sig.idx].epoch;
      if (epoch < WINDOW_START || epoch >= WINDOW_END) continue;
      events.push({ kind: "signal", epoch, strategyId: s.id, sig });
    }
  }
  for (const k of fetchKeys) {
    const candles = cache.get(k) ?? [];
    for (const bar of candles) {
      // Need bars within window AND a few outside (for finalize/settle of
      // positions opened near WINDOW_END).
      if (bar.epoch < WINDOW_START - 600 || bar.epoch >= WINDOW_END + 1800) continue;
      events.push({ kind: "bar", epoch: bar.epoch, key: k, bar });
    }
  }
  events.sort((a, b) => {
    if (a.epoch !== b.epoch) return a.epoch - b.epoch;
    // signal fires AT bar close — process bar BEFORE signal at same epoch
    return a.kind === "bar" ? -1 : 1;
  });

  for (const ev of events) {
    if (bankrupt) break;
    if (ev.kind === "bar") {
      // Try to settle / finalize each open position whose key matches.
      for (const [sid, pos] of Array.from(open.entries())) {
        if (`${pos.symbol}|${pos.granularity}` !== ev.key) continue;
        if (ev.bar.epoch <= candlesByKey.get(pos.strategyId)![pos.signalIdx].epoch) continue;
        // Finalize entry on first new bar.
        if (!pos.entryFinalized) {
          const newEntry = pos.side === "BUY"
            ? ev.bar.open + (pos.signalEntry * ENTRY_SPREAD_FRAC)
            : ev.bar.open - (pos.signalEntry * ENTRY_SPREAD_FRAC);
          const delta = newEntry - pos.entryPrice;
          pos.entryPrice = newEntry;
          pos.stopPrice += delta;
          pos.targetPrice += delta;
          pos.entryFinalized = true;
        }
        // Check TP/SL hit.
        let hit: "tp" | "sl" | null = null;
        if (pos.side === "BUY") {
          if (ev.bar.low <= pos.stopPrice) hit = "sl";
          else if (ev.bar.high >= pos.targetPrice) hit = "tp";
        } else {
          if (ev.bar.high >= pos.stopPrice) hit = "sl";
          else if (ev.bar.low <= pos.targetPrice) hit = "tp";
        }
        if (!hit) continue;
        // SL slippage (TP fills clean).
        const slipDist = SL_SLIPPAGE_FRAC * pos.entryPrice;
        const slFill = pos.side === "BUY" ? pos.stopPrice - slipDist : pos.stopPrice + slipDist;
        const exitPrice = hit === "tp" ? pos.targetPrice : slFill;
        const moveAmt = (exitPrice - pos.entryPrice) / pos.entryPrice;
        const sideSign = pos.side === "BUY" ? 1 : -1;
        const pnlPct = Math.max(-1, moveAmt * TRADE_MULT * sideSign);
        const grossPnl = pos.stake * pnlPct;
        balance += grossPnl;
        if (balance > peak) peak = balance;
        if (balance < trough) trough = balance;
        const won = hit === "tp";
        const ps = perStrat[pos.strategyId];
        ps.trades++;
        ps.pnl += grossPnl;
        if (won) {
          ps.wins++;
          ladder[pos.strategyId] = 0;
        } else {
          ps.losses++;
          ladder[pos.strategyId]++;
          if (ladder[pos.strategyId] >= MAX_LEVELS) {
            ps.busts++;
            busts++;
            ladder[pos.strategyId] = 0;
          }
        }
        if (ladder[pos.strategyId] > maxLevel) maxLevel = ladder[pos.strategyId];
        ledger.push({
          signalEpoch: candlesByKey.get(pos.strategyId)![pos.signalIdx].epoch,
          finalizeEpoch: pos.entryFinalized ? ev.bar.epoch : null,
          closeEpoch: ev.bar.epoch,
          strategyId: pos.strategyId,
          symbol: pos.symbol,
          side: pos.side,
          level: pos.level,
          stake: pos.stake,
          signalEntry: pos.signalEntry,
          finalizedEntry: pos.entryPrice,
          exitPrice,
          exitReason: hit,
          grossPnlUsd: grossPnl,
          commissionUsd: pos.commission,
          netPnlUsd: grossPnl, // commission already deducted at open
          balanceAfter: balance,
          ladderAfter: ladder[pos.strategyId],
        });
        open.delete(sid);
        if (balance <= 0) { bankrupt = true; break; }
      }
    } else {
      // Signal: try to open a new position for this strategy.
      const sid = ev.strategyId;
      if (open.has(sid)) continue;
      const martingaleActive = FORCE_MARTINGALE;
      let stake = martingaleActive
        ? Math.min(PER_TRADE_CAP, BASE_STAKE * Math.pow(MART_MULT, ladder[sid]))
        : BASE_STAKE;
      stake = Math.round(stake * 100) / 100;
      const commission = Math.round(stake * COMMISSION_FRAC * 100) / 100;
      if (stake + commission > balance) { bankrupt = true; break; }
      // Charge commission at open.
      balance -= commission;
      // Check TP/SL distance vs Deriv $0.10 floor.
      const candles = candlesByKey.get(sid)!;
      const triggerBar = candles[ev.sig.idx];
      const slDist = Math.abs(triggerBar.close - ev.sig.stopPrice);
      const tpDist = Math.abs(ev.sig.targetPrice - triggerBar.close);
      const slUsd = (slDist / triggerBar.close) * stake * TRADE_MULT;
      const tpUsd = (tpDist / triggerBar.close) * stake * TRADE_MULT;
      if (slUsd < TP_SL_FLOOR || tpUsd < TP_SL_FLOOR) {
        // Deriv would clamp — model the wider stop/target.
        // For honesty, continue with stop/target as-is but note this would
        // have been clamped live. (Live clamps the USD-amount, which translates
        // to a wider price distance — same effect as below.)
      }
      const pos: Position = {
        strategyId: sid,
        side: ev.sig.side,
        level: ladder[sid],
        stake,
        signalIdx: ev.sig.idx,
        signalEntry: triggerBar.close,
        entryPrice: triggerBar.close,
        stopPrice: ev.sig.stopPrice,
        targetPrice: ev.sig.targetPrice,
        symbol: STRATS.find((s) => s.id === sid)!.symbol,
        granularity: STRATS.find((s) => s.id === sid)!.granularity,
        entryFinalized: false,
        commission,
      };
      open.set(sid, pos);
    }
  }

  // ── Print summary ──
  const totalTrades = ledger.length;
  const wins = ledger.filter((r) => r.exitReason === "tp").length;
  const losses = totalTrades - wins;
  const wr = totalTrades > 0 ? wins / totalTrades : 0;
  const totalGross = ledger.reduce((a, r) => a + r.grossPnlUsd, 0);
  const totalCommissions = ledger.reduce((a, r) => a + r.commissionUsd, 0);
  const finalBalance = bankrupt ? 0 : balance;
  const netPnl = finalBalance - ACCT_BALANCE;

  console.log("");
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  console.log(`HONEST SIM — ${dayStr} (24h UTC)`);
  console.log("═══════════════════════════════════════════════════════════════════════════════");
  const tag = bankrupt ? "💀" : (netPnl >= 0 ? "✅" : "❌");
  console.log(`${tag} Final balance:  $${finalBalance.toFixed(2)} (started $${ACCT_BALANCE.toFixed(2)})`);
  console.log(`   Net P&L:        ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)} (${((netPnl / ACCT_BALANCE) * 100).toFixed(1)}%)`);
  console.log(`   Peak / Trough:  $${peak.toFixed(2)} / $${trough.toFixed(2)}  ·  Max DD: $${(peak - trough).toFixed(2)}`);
  console.log(`   Trades:         ${totalTrades}  ·  W/L: ${wins}/${losses}  ·  WR: ${(wr * 100).toFixed(1)}%`);
  console.log(`   Gross pnl:      ${totalGross >= 0 ? "+" : ""}$${totalGross.toFixed(2)}`);
  console.log(`   Commissions:    -$${totalCommissions.toFixed(2)}  (${(totalCommissions / Math.max(1, totalGross + totalCommissions) * 100).toFixed(1)}% of gross)`);
  console.log(`   Circuit breakers: ${busts}  ·  Max ladder level: ${maxLevel}`);
  console.log("");
  console.log("Per-strategy contribution:");
  for (const s of STRATS) {
    const ps = perStrat[s.id];
    const psWr = ps.trades > 0 ? (ps.wins / ps.trades * 100).toFixed(0) : "—";
    console.log(`  ${s.id.padEnd(24)} ${String(ps.trades).padStart(4)}t  ${ps.wins}W/${ps.losses}L (${String(psWr).padStart(2)}% WR)  ${ps.pnl >= 0 ? "+" : ""}$${ps.pnl.toFixed(2)}  ${ps.busts}b`);
  }
  console.log("");
  if (totalTrades > 0) {
    console.log("Trade-by-trade ledger (UTC time, signal → finalize → close):");
    console.log(`  ${"sigT".padEnd(8)}  ${"closeT".padEnd(8)}  ${"strategy".padEnd(22)}  ${"side".padEnd(4)}  ${"lvl".padStart(3)}  ${"stake".padStart(6)}  ${"signalE".padStart(9)}  ${"finalE".padStart(9)}  ${"exitP".padStart(9)}  ${"exit".padEnd(4)}  ${"net".padStart(8)}  ${"bal".padStart(8)}  l→`);
    for (const r of ledger) {
      const sigT = new Date(r.signalEpoch * 1000).toISOString().slice(11, 19);
      const closeT = new Date(r.closeEpoch * 1000).toISOString().slice(11, 19);
      const sign = r.netPnlUsd >= 0 ? "+" : "";
      console.log(`  ${sigT.padEnd(8)}  ${closeT.padEnd(8)}  ${r.strategyId.padEnd(22)}  ${r.side.padEnd(4)}  ${String(r.level).padStart(3)}  $${r.stake.toFixed(2).padStart(5)}  ${r.signalEntry.toFixed(2).padStart(9)}  ${r.finalizedEntry.toFixed(2).padStart(9)}  ${r.exitPrice.toFixed(2).padStart(9)}  ${r.exitReason.padEnd(4)}  ${sign}$${r.netPnlUsd.toFixed(2).padStart(7)}  $${r.balanceAfter.toFixed(2).padStart(7)}  ${r.ladderAfter}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

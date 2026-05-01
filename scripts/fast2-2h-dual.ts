// Fast2 sandbox sim: 2 hours of live history, classic vs anti-martingale
// side by side. Uses the validated 3-strategy stack
// (spike-CRASH300N-1m, spike-BOOM300N-1m, drift-CRASH300N-5m) with
// per-strategy independent ladders sharing one paper account.
//
// Knobs are env-overridable; defaults match the request:
//   ACCT=$50  STAKE=$3  MULT=500  MART=2.0  LEVELS=5  HOURS=2
//
// Output: per-mode ledger + summary stats (final balance, peak, trough,
// trades, WR, busts, max ladder level). Both runs replay the SAME bars.

import WebSocket from "ws";
import { ATR } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const COST_BPS = 5.0;

const ACCT_BALANCE = Number(process.env.ACCT ?? 50);
const BASE_STAKE = Number(process.env.STAKE ?? 3);
const MART_MULT = Number(process.env.MART ?? 2.0);
const MAX_LEVELS = Number(process.env.LEVELS ?? 5);
const TRADE_MULT = Number(process.env.MULT ?? 500);
const HOURS = Number(process.env.HOURS ?? 2);

// Fetch enough warmup bars: ATR(14) + a couple-bar buffer.
const FETCH_1M = Number(process.env.FETCH_1M ?? Math.max(200, HOURS * 60 + 50));
const FETCH_5M = Number(process.env.FETCH_5M ?? Math.max(60, Math.ceil(HOURS * 12) + 30));

const NOW = Math.floor(Date.now() / 1000);
const WINDOW_END = NOW;
const WINDOW_START = NOW - HOURS * 3600;

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
  { id: "drift-CRASH300N-5m", symbol: "CRASH300N", granularity: 300, build: (c) => driftPullback(c, 1, 3, 1.0) },
];

type Position = {
  strategyId: string; side: "BUY" | "SELL"; level: number; stake: number;
  entryPrice: number; stopPrice: number; targetPrice: number;
  symbol: string; granularity: number;
};
type Event =
  | { kind: "bar"; symbol: string; granularity: number; bar: Candle }
  | { kind: "signal"; strategyId: string; symbol: string; granularity: number; sig: SimSignal; epoch: number };

type LedgerRow = {
  epoch: number; strategyId: string; symbol: string; side: "BUY" | "SELL";
  level: number; stake: number; entryPrice: number; exitPrice: number;
  exitReason: "tp" | "sl" | "bankrupt"; pnlUsd: number; balanceAfter: number;
  ladderAfter: number;
};

type SimResult = {
  mode: "classic" | "anti";
  finalBalance: number;
  peak: number;
  trough: number;
  trades: number;
  wins: number;
  losses: number;
  busts: number;
  maxLevel: number;
  bankrupt: boolean;
  ledger: LedgerRow[];
  perStrat: Record<string, { trades: number; wins: number; losses: number; busts: number; pnl: number }>;
};

function simulate(events: Event[], cache: Map<string, Candle[]>, mode: "classic" | "anti"): SimResult {
  let balance = ACCT_BALANCE;
  let peak = ACCT_BALANCE;
  let trough = ACCT_BALANCE;
  let maxLevel = 0;
  const ladder: Record<string, number> = Object.fromEntries(STRATS.map((s) => [s.id, 0]));
  const open = new Map<string, Position>();
  const ledger: LedgerRow[] = [];
  const costFrac = COST_BPS / 10000;
  let bankrupt = false;
  const perStrat: SimResult["perStrat"] = Object.fromEntries(STRATS.map((s) => [s.id, { trades: 0, wins: 0, losses: 0, busts: 0, pnl: 0 }]));
  let trades = 0, wins = 0, losses = 0, busts = 0;

  for (const ev of events) {
    if (bankrupt) break;
    if (ev.kind === "bar") {
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
          const grossPnlPct = Math.max(-1, gross * TRADE_MULT);
          const grossPnl = pos.stake * grossPnlPct;
          const pnlUsd = grossPnl - pos.stake * costFrac;
          balance += pnlUsd;
          if (balance > peak) peak = balance;
          if (balance < trough) trough = balance;
          trades++;
          perStrat[pos.strategyId].trades++;
          perStrat[pos.strategyId].pnl += pnlUsd;
          // Ladder advance — depends on mode.
          // classic: TP wins → reset; SL losses → escalate.
          // anti:    TP wins → escalate; SL losses → reset.
          const won = hit === "tp";
          if (won) {
            wins++;
            perStrat[pos.strategyId].wins++;
          } else {
            losses++;
            perStrat[pos.strategyId].losses++;
          }
          const escalates = mode === "classic" ? !won : won;
          if (escalates) {
            ladder[sid]++;
            if (ladder[sid] > maxLevel) maxLevel = ladder[sid];
            if (ladder[sid] >= MAX_LEVELS) {
              busts++;
              perStrat[pos.strategyId].busts++;
              ladder[sid] = 0;
            }
          } else {
            ladder[sid] = 0;
          }
          ledger.push({
            epoch: ev.bar.epoch, strategyId: pos.strategyId, symbol: pos.symbol,
            side: pos.side, level: pos.level, stake: pos.stake,
            entryPrice: pos.entryPrice, exitPrice, exitReason: hit,
            pnlUsd, balanceAfter: balance, ladderAfter: ladder[sid],
          });
          open.delete(sid);
          if (balance <= 0) { bankrupt = true; break; }
        }
      }
    } else {
      const sid = ev.strategyId;
      if (open.has(sid)) continue;
      const wantStake = BASE_STAKE * Math.pow(MART_MULT, ladder[sid]);
      if (wantStake > balance) { bankrupt = true; break; }
      const candles = cache.get(`${ev.symbol}|${ev.granularity}`)!;
      const entry = candles[ev.sig.idx].close;
      open.set(sid, {
        strategyId: sid, side: ev.sig.side, level: ladder[sid], stake: wantStake,
        entryPrice: entry, stopPrice: ev.sig.stopPrice, targetPrice: ev.sig.targetPrice,
        symbol: ev.symbol, granularity: ev.granularity,
      });
    }
  }

  return { mode, finalBalance: bankrupt ? 0 : balance, peak, trough, trades, wins, losses, busts, maxLevel, bankrupt, ledger, perStrat };
}

async function main() {
  console.log("Fast2 sim — classic vs anti-martingale, last 2 hours");
  console.log(`Account: $${ACCT_BALANCE}  ·  Base stake: $${BASE_STAKE}  ·  MULT: ${TRADE_MULT}×  ·  Mart: ${MART_MULT}×  ·  Levels: ${MAX_LEVELS}`);
  console.log(`Window: ${new Date(WINDOW_START * 1000).toISOString()} → ${new Date(WINDOW_END * 1000).toISOString()} (${HOURS}h)`);
  console.log("");

  const c = new C(); await c.ready;
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(STRATS.map((s) => `${s.symbol}|${s.granularity}`)));
  for (const k of fetchKeys) {
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    const cnt = gr === 60 ? FETCH_1M : FETCH_5M;
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars)...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, gr, cnt, WINDOW_END); break; }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 3600;
      console.log(` ${candles.length} bars (${span.toFixed(1)}h)`);
      cache.set(k, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  // Build per-strategy signals (across all fetched candles — warmup bars stay
  // outside the window so they don't trade).
  const stratSignals = new Map<string, SimSignal[]>();
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    stratSignals.set(s.id, candles ? s.build(candles) : []);
  }

  // Build event stream — only events in test window matter.
  const events: Event[] = [];
  for (const k of fetchKeys) {
    const candles = cache.get(k);
    if (!candles) continue;
    const [sym, grStr] = k.split("|");
    const gr = Number(grStr);
    for (const bar of candles) {
      if (bar.epoch < WINDOW_START || bar.epoch >= WINDOW_END) continue;
      events.push({ kind: "bar", symbol: sym, granularity: gr, bar });
    }
  }
  for (const s of STRATS) {
    const candles = cache.get(`${s.symbol}|${s.granularity}`);
    if (!candles) continue;
    const sigs = stratSignals.get(s.id) ?? [];
    for (const sig of sigs) {
      const epoch = candles[sig.idx].epoch;
      if (epoch < WINDOW_START || epoch >= WINDOW_END) continue;
      events.push({ kind: "signal", strategyId: s.id, symbol: s.symbol, granularity: s.granularity, sig, epoch });
    }
  }
  events.sort((a, b) => {
    const ea = a.kind === "bar" ? a.bar.epoch : a.epoch;
    const eb = b.kind === "bar" ? b.bar.epoch : b.epoch;
    if (ea !== eb) return ea - eb;
    return a.kind === "bar" ? -1 : 1;
  });

  const total1m = (cache.get("BOOM300N|60")?.filter((b) => b.epoch >= WINDOW_START && b.epoch < WINDOW_END).length ?? 0)
                + (cache.get("CRASH300N|60")?.filter((b) => b.epoch >= WINDOW_START && b.epoch < WINDOW_END).length ?? 0);
  const total5m = cache.get("CRASH300N|300")?.filter((b) => b.epoch >= WINDOW_START && b.epoch < WINDOW_END).length ?? 0;
  const totalSigs = events.filter((e) => e.kind === "signal").length;
  console.log("");
  console.log(`Window contains ${total1m} × 1m bars + ${total5m} × 5m bars · ${totalSigs} strategy signals fired`);
  console.log("");

  const classic = simulate(events, cache, "classic");
  const anti = simulate(events, cache, "anti");

  // ── Side-by-side summary ───────────────────────────────────────────────
  const fmtMoney = (n: number) => `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  const fmtBal = (n: number) => `$${n.toFixed(2)}`;
  const tagFor = (r: SimResult) => r.bankrupt ? "💀" : (r.finalBalance >= ACCT_BALANCE ? "✅" : "❌");

  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("CLASSIC vs ANTI-MARTINGALE — same bars, same signals, only ladder direction differs");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("");
  console.log(`                         ${"CLASSIC".padStart(14)}      ${"ANTI (Paroli)".padStart(14)}`);
  console.log(`────────────────────────────────────────────────────────────────────`);
  console.log(`Final balance         ${tagFor(classic)} ${fmtBal(classic.finalBalance).padStart(12)}      ${tagFor(anti)} ${fmtBal(anti.finalBalance).padStart(12)}`);
  console.log(`Net P&L                  ${fmtMoney(classic.finalBalance - ACCT_BALANCE).padStart(12)}         ${fmtMoney(anti.finalBalance - ACCT_BALANCE).padStart(12)}`);
  console.log(`Peak balance             ${fmtBal(classic.peak).padStart(12)}         ${fmtBal(anti.peak).padStart(12)}`);
  console.log(`Trough balance           ${fmtBal(classic.trough).padStart(12)}         ${fmtBal(anti.trough).padStart(12)}`);
  console.log(`Max DD (peak→trough)     ${fmtBal(classic.peak - classic.trough).padStart(12)}         ${fmtBal(anti.peak - anti.trough).padStart(12)}`);
  console.log(`Trades                   ${String(classic.trades).padStart(12)}         ${String(anti.trades).padStart(12)}`);
  console.log(`Wins / Losses            ${`${classic.wins}W/${classic.losses}L`.padStart(12)}         ${`${anti.wins}W/${anti.losses}L`.padStart(12)}`);
  const wrC = classic.trades > 0 ? `${((classic.wins / classic.trades) * 100).toFixed(0)}%` : "—";
  const wrA = anti.trades > 0 ? `${((anti.wins / anti.trades) * 100).toFixed(0)}%` : "—";
  console.log(`Win rate                 ${wrC.padStart(12)}         ${wrA.padStart(12)}`);
  console.log(`Circuit breakers (busts) ${String(classic.busts).padStart(12)}         ${String(anti.busts).padStart(12)}`);
  console.log(`Max ladder level         ${String(classic.maxLevel).padStart(12)}         ${String(anti.maxLevel).padStart(12)}`);
  console.log(`Bankrupt?                ${(classic.bankrupt ? "YES" : "no").padStart(12)}         ${(anti.bankrupt ? "YES" : "no").padStart(12)}`);
  console.log("");

  // Per-strategy contribution
  console.log("Per-strategy contribution");
  console.log(`Strategy                 ${"CLASSIC pnl".padStart(14)}  ${"trades  W/L".padStart(14)}     ${"ANTI pnl".padStart(11)}  ${"trades  W/L".padStart(14)}`);
  console.log(`─────────────────────────────────────────────────────────────────────────────────────────`);
  for (const s of STRATS) {
    const a = classic.perStrat[s.id];
    const b = anti.perStrat[s.id];
    console.log(`${s.id.padEnd(24)} ${fmtMoney(a.pnl).padStart(14)}  ${`${a.trades}t ${a.wins}W/${a.losses}L`.padStart(14)}     ${fmtMoney(b.pnl).padStart(11)}  ${`${b.trades}t ${b.wins}W/${b.losses}L`.padStart(14)}`);
  }
  console.log("");

  // Ledger detail (compact, both modes)
  const printLedger = (r: SimResult) => {
    console.log(`▸ ${r.mode.toUpperCase()} ladder (${r.ledger.length} trades)`);
    if (r.ledger.length === 0) {
      console.log(`  (no trades)`);
      return;
    }
    console.log(`  ${"time UTC".padEnd(19)}  ${"strategy".padEnd(22)}  ${"side".padEnd(4)}  ${"lvl".padStart(3)}  ${"stake".padStart(6)}  ${"exit".padStart(4)}  ${"pnl".padStart(8)}  ${"bal".padStart(8)}  ladder→`);
    for (const row of r.ledger) {
      const t = new Date(row.epoch * 1000).toISOString().slice(11, 19);
      console.log(`  ${t.padEnd(19)}  ${row.strategyId.padEnd(22)}  ${row.side.padEnd(4)}  ${String(row.level).padStart(3)}  $${row.stake.toFixed(2).padStart(5)}  ${row.exitReason.padEnd(4)}  ${fmtMoney(row.pnlUsd).padStart(8)}  ${fmtBal(row.balanceAfter).padStart(8)}  ${row.ladderAfter}`);
    }
    console.log("");
  };
  printLedger(classic);
  printLedger(anti);
}

main().catch((e) => { console.error(e); process.exit(1); });

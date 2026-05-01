// Yesterday-only validation of v3 + v2 winning strategies with REALISTIC
// martingale account params:
//   • Account starting balance: $50
//   • Base stake: $1.50
//   • Multiplier: 2.2× per loss
//   • Max ladder depth: 5 levels (level 5 stake = $1.50 × 2.2^4 = $35.11)
//   • Cumulative bust loss = $1.50 × (2.2^5 - 1)/(2.2 - 1) = $63.13
//   • → A SINGLE BUST CYCLE EXCEEDS THE ACCOUNT BALANCE.
//
// This is the stress test the user asked for. We trade exactly the last 24h
// of synthetic data and show:
//   • starting balance, ending balance, peak, drawdown
//   • per-trade ledger: ladder level, stake, P&L, running balance
//   • # bust cycles fired
//   • whether the account went broke at any point
//
// Strategies under test:
//   1. driftPullback BOOM300N 5m (k=3, kAtr=1.0) — v3 #1
//   2. driftPullback CRASH300N 5m (k=3, kAtr=1.0) — v3 #2
//   3. emaPullback BOOM300N 5m (ema=50, kAtr=1.0) — v3 #3
//   4. bollingerEqd CRASH300N 5m (p=20, sd=2.5, k=0.5) — v3 #4
//   5. spikeFade BOOM300N 1m (n=3.0, buf=0.2, tp=0.4, conf=true) — v2 high-WR
//   6. spikeFade CRASH300N 1m (n=3.0, buf=0.2, tp=0.4, conf=true) — v2 high-WR

import WebSocket from "ws";
import { writeFileSync, mkdirSync } from "node:fs";
import { ATR, EMA, BollingerBands } from "technicalindicators";
import type { Candle } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const COST_BPS = 5.0;

// Account params per user's request
const ACCT_BALANCE = 50;
const BASE_STAKE = 1.5;
const MULT = 2.2;
const MAX_LEVELS = 5;
const TRADE_MULT = 30; // Deriv MULTIPLIER leverage on the trade itself

// Yesterday window — 24h ending 1m before script starts.
const NOW = Math.floor(Date.now() / 1000);
const YESTERDAY_START = NOW - 24 * 3600 - 30 * 60; // back 24.5h to ensure full yesterday
const FETCH_START = YESTERDAY_START - 4 * 3600; // 4h warmup before test window for indicators

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

// ── Signal generators (lifted from v3 / v2) ───────────────────────────────
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

function emaPullback(candles: Candle[], emaP: number, driftDir: 1 | -1, kAtr: number): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const ema = EMA.calculate({ period: emaP, values: closes });
  const offset = candles.length - ema.length;
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 1; i < ema.length; i++) {
    const idx = i + offset;
    const prev = closes[idx - 1], cur = closes[idx], e = ema[i], ePrev = ema[i - 1];
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    if (driftDir === 1 && prev > ePrev && cur <= e) sigs.push(eqSig(idx, "BUY", cur, kAtr * atr));
    else if (driftDir === -1 && prev < ePrev && cur >= e) sigs.push(eqSig(idx, "SELL", cur, kAtr * atr));
  }
  return sigs;
}

function bollingerEqd(candles: Candle[], period: number, sd: number, kAtr: number): SimSignal[] {
  const closes = candles.map((c) => c.close);
  const bb = BollingerBands.calculate({ period, values: closes, stdDev: sd });
  const offset = candles.length - bb.length;
  const atrSeries = ATR.calculate({ period: 14, high: candles.map((c) => c.high), low: candles.map((c) => c.low), close: closes });
  const aOff = candles.length - atrSeries.length;
  const atrAt = (i: number) => (i < aOff ? 0 : atrSeries[i - aOff]);
  const sigs: SimSignal[] = [];
  for (let i = 0; i < bb.length; i++) {
    const idx = i + offset;
    const { upper, lower } = bb[i];
    const c = closes[idx];
    const atr = atrAt(idx);
    if (atr <= 0) continue;
    if (c > upper) sigs.push(eqSig(idx, "SELL", c, kAtr * atr));
    else if (c < lower) sigs.push(eqSig(idx, "BUY", c, kAtr * atr));
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

// ── Account simulator with REAL martingale + bankruptcy detection ─────────
type LedgerRow = {
  tradeIdx: number;
  candleIdx: number;
  side: "BUY" | "SELL";
  level: number;        // ladder level at trade open
  stake: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: "tp" | "sl" | "bankrupt";
  rawPnlUsd: number;
  balanceAfter: number;
};
type AcctResult = {
  strategy: string;
  startBalance: number;
  endBalance: number;
  peakBalance: number;
  troughBalance: number;
  maxDD: number;
  trades: number;
  wins: number;
  losses: number;
  busts: number;
  bankrupt: boolean;
  bankruptAtTrade: number | null;
  ledger: LedgerRow[];
};

function simulateAccount(
  strategy: string,
  candles: Candle[],
  signals: SimSignal[],
  testStartEpoch: number,
): AcctResult {
  const costFrac = COST_BPS / 10000;
  let balance = ACCT_BALANCE;
  let peak = ACCT_BALANCE;
  let trough = ACCT_BALANCE;
  let level = 0;
  const ledger: LedgerRow[] = [];
  let busts = 0;
  let bankrupt = false;
  let bankruptAtTrade: number | null = null;

  // Filter signals to test window only.
  const sigInWindow = signals.filter((s) => candles[s.idx].epoch >= testStartEpoch);

  // Open-position tracking (one at a time).
  let open: {
    side: "BUY" | "SELL";
    level: number;
    stake: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    openIdx: number;
  } | null = null;

  const sigByIdx = new Map<number, SimSignal[]>();
  for (const s of sigInWindow) {
    const arr = sigByIdx.get(s.idx) ?? [];
    arr.push(s);
    sigByIdx.set(s.idx, arr);
  }
  const minIdx = sigInWindow[0]?.idx ?? candles.length;

  for (let i = minIdx; i < candles.length; i++) {
    if (bankrupt) break;
    const bar = candles[i];

    if (open) {
      let hit: "tp" | "sl" | null = null;
      if (open.side === "BUY") {
        if (bar.low <= open.stopPrice) hit = "sl";
        else if (bar.high >= open.targetPrice) hit = "tp";
      } else {
        if (bar.high >= open.stopPrice) hit = "sl";
        else if (bar.low <= open.targetPrice) hit = "tp";
      }
      if (hit) {
        const exitPrice = hit === "tp" ? open.targetPrice : open.stopPrice;
        const gross = open.side === "BUY"
          ? (exitPrice - open.entryPrice) / open.entryPrice
          : (open.entryPrice - exitPrice) / open.entryPrice;
        const pnlPct = gross - costFrac;
        const pnlUsd = open.stake * Math.max(-1, pnlPct * TRADE_MULT);
        balance += pnlUsd;
        if (balance > peak) peak = balance;
        if (balance < trough) trough = balance;
        ledger.push({
          tradeIdx: ledger.length,
          candleIdx: i,
          side: open.side,
          level: open.level,
          stake: open.stake,
          entryPrice: open.entryPrice,
          exitPrice,
          exitReason: hit,
          rawPnlUsd: pnlUsd,
          balanceAfter: balance,
        });
        if (hit === "tp") {
          // Win — reset ladder
          level = 0;
        } else {
          // Loss — escalate
          level++;
          if (level >= MAX_LEVELS) {
            busts++;
            level = 0; // reset after bust
          }
        }
        open = null;
        if (balance <= 0) {
          bankrupt = true;
          bankruptAtTrade = ledger.length - 1;
          break;
        }
      }
    }

    if (!open) {
      const sigs = sigByIdx.get(i);
      if (sigs) {
        for (const sig of sigs) {
          // Martingale stake at current level; cap at remaining balance
          // (so trade simulation doesn't fake an open it can't afford).
          const wantStake = BASE_STAKE * Math.pow(MULT, level);
          if (wantStake > balance) {
            // Can't afford this level — record as bankruptcy.
            ledger.push({
              tradeIdx: ledger.length,
              candleIdx: i,
              side: sig.side,
              level,
              stake: wantStake,
              entryPrice: bar.close,
              exitPrice: bar.close,
              exitReason: "bankrupt",
              rawPnlUsd: 0,
              balanceAfter: balance,
            });
            bankrupt = true;
            bankruptAtTrade = ledger.length - 1;
            break;
          }
          open = {
            side: sig.side,
            level,
            stake: wantStake,
            entryPrice: bar.close,
            stopPrice: sig.stopPrice,
            targetPrice: sig.targetPrice,
            openIdx: i,
          };
          break; // one open at a time
        }
      }
    }
  }

  return {
    strategy,
    startBalance: ACCT_BALANCE,
    endBalance: balance,
    peakBalance: peak,
    troughBalance: trough,
    maxDD: peak - trough,
    trades: ledger.filter((l) => l.exitReason !== "bankrupt").length,
    wins: ledger.filter((l) => l.exitReason === "tp").length,
    losses: ledger.filter((l) => l.exitReason === "sl").length,
    busts,
    bankrupt,
    bankruptAtTrade,
    ledger,
  };
}

async function main() {
  console.log("Yesterday-only martingale stress test.");
  console.log(`Account: $${ACCT_BALANCE} starting | Base stake: $${BASE_STAKE} | Multiplier: ${MULT}× | Max levels: ${MAX_LEVELS}`);
  const bustLoss = BASE_STAKE * (Math.pow(MULT, MAX_LEVELS) - 1) / (MULT - 1);
  const lvl5 = BASE_STAKE * Math.pow(MULT, MAX_LEVELS - 1);
  console.log(`Cumulative bust cost: $${bustLoss.toFixed(2)} (level ${MAX_LEVELS - 1} stake = $${lvl5.toFixed(2)})`);
  console.log(`A bust EXCEEDS account balance — single bust → bankruptcy.`);
  console.log("");

  const c = new C(); await c.ready;

  // Fetch enough bars to cover yesterday + 4h warmup.
  // 1m: 24h + 4h = 28h × 60 = 1680 bars (round up to 2000)
  // 5m: 24h + 4h = 28h × 12 = 336 bars (round up to 500)
  // Fetch generously to ensure indicators have warmup history.
  type Test = {
    name: string;
    symbol: string;
    granularity: number;
    barsNeeded: number;
    build: (candles: Candle[]) => SimSignal[];
  };

  const TESTS: Test[] = [
    {
      name: "driftPullback-BOOM300N-5m-k3-kAtr1.0",
      symbol: "BOOM300N", granularity: 300, barsNeeded: 600,
      build: (c) => driftPullback(c, -1, 3, 1.0),
    },
    {
      name: "driftPullback-CRASH300N-5m-k3-kAtr1.0",
      symbol: "CRASH300N", granularity: 300, barsNeeded: 600,
      build: (c) => driftPullback(c, 1, 3, 1.0),
    },
    {
      name: "emaPullback-BOOM300N-5m-ema50-kAtr1.0",
      symbol: "BOOM300N", granularity: 300, barsNeeded: 600,
      build: (c) => emaPullback(c, 50, -1, 1.0),
    },
    {
      name: "bollingerEqd-CRASH300N-5m-p20-sd2.5-k0.5",
      symbol: "CRASH300N", granularity: 300, barsNeeded: 600,
      build: (c) => bollingerEqd(c, 20, 2.5, 0.5),
    },
    {
      name: "spikeFade-BOOM300N-1m-n3.0-buf0.2-tp0.4",
      symbol: "BOOM300N", granularity: 60, barsNeeded: 2000,
      build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true),
    },
    {
      name: "spikeFade-CRASH300N-1m-n3.0-buf0.2-tp0.4",
      symbol: "CRASH300N", granularity: 60, barsNeeded: 2000,
      build: (c) => spikeFade(c, 3.0, 0.2, 0.4, true),
    },
  ];

  // Prefetch unique (sym, gr) tuples.
  const cache = new Map<string, Candle[]>();
  const fetchKeys = Array.from(new Set(TESTS.map((t) => `${t.symbol}|${t.granularity}|${t.barsNeeded}`)));
  for (const k of fetchKeys) {
    const [sym, grStr, cntStr] = k.split("|");
    const gr = Number(grStr);
    const cnt = Number(cntStr);
    process.stdout.write(`Fetching ${sym} ${gr === 60 ? "1m" : "5m"} (${cnt} bars)...`);
    let candles: Candle[] | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { candles = await fetchPaged(c, sym, gr, cnt); break; }
      catch (e) { if (attempt === 2) console.log(` FAIL ${(e as Error).message}`); else { try { await c.reconnect(); } catch {} } }
    }
    if (candles) {
      const span = (candles[candles.length - 1].epoch - candles[0].epoch) / 86400;
      console.log(` ${candles.length} bars (${span.toFixed(1)}d)`);
      cache.set(`${sym}|${gr}`, candles);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  c.close();

  console.log("");
  console.log(`Test window: epoch ≥ ${YESTERDAY_START} (= ${new Date(YESTERDAY_START * 1000).toISOString()} UTC)`);
  console.log("");

  const results: AcctResult[] = [];
  for (const t of TESTS) {
    const candles = cache.get(`${t.symbol}|${t.granularity}`);
    if (!candles) { console.log(`  ${t.name} — no data`); continue; }
    const signals = t.build(candles);
    const r = simulateAccount(t.name, candles, signals, YESTERDAY_START);
    results.push(r);
  }

  // ── Print summary ─────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("YESTERDAY-ONLY MARTINGALE STRESS TEST — RESULTS");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("");
  for (const r of results) {
    const wr = r.trades > 0 ? r.wins / r.trades : 0;
    const pnl = r.endBalance - r.startBalance;
    const sign = pnl >= 0 ? "+" : "";
    const status = r.bankrupt ? "💀 BANKRUPT" : (pnl >= 0 ? "✅ profit" : "❌ loss");
    console.log(`${r.strategy}`);
    console.log(`  ${status}  start=$${r.startBalance.toFixed(2)}  end=$${r.endBalance.toFixed(2)}  P&L=${sign}$${pnl.toFixed(2)}  peak=$${r.peakBalance.toFixed(2)}  trough=$${r.troughBalance.toFixed(2)}  DD=$${r.maxDD.toFixed(2)}`);
    console.log(`  ${r.trades} trades  ${r.wins}W/${r.losses}L  WR=${(wr * 100).toFixed(0)}%  busts=${r.busts}${r.bankrupt ? `  BANKRUPT @ trade #${r.bankruptAtTrade}` : ""}`);
    if (r.ledger.length > 0) {
      // Show ladder excursion summary.
      const maxLevel = r.ledger.reduce((m, l) => Math.max(m, l.level), 0);
      const maxStake = r.ledger.reduce((m, l) => Math.max(m, l.stake), 0);
      console.log(`  max ladder level: ${maxLevel}  max stake: $${maxStake.toFixed(2)}`);
    }
    console.log("");
  }

  // ── Summary line ──────────────────────────────────────────────────────
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  console.log("SUMMARY");
  console.log("══════════════════════════════════════════════════════════════════════════════════════════════════════════════");
  for (const r of results) {
    const pnl = r.endBalance - r.startBalance;
    const sign = pnl >= 0 ? "+" : "";
    const tag = r.bankrupt ? "💀" : (pnl > 0 ? "✅" : (pnl < 0 ? "❌" : "—"));
    console.log(`  ${tag} ${r.strategy.padEnd(48)}  end=$${r.endBalance.toFixed(2).padStart(7)}  P&L=${sign}$${pnl.toFixed(2).padStart(6)}  ${r.trades}t (${r.wins}W/${r.losses}L)  ${r.busts} busts`);
  }

  try { mkdirSync(".tmp", { recursive: true }); } catch {}
  writeFileSync(".tmp/fast-yesterday-results.json", JSON.stringify({
    timestamp: new Date().toISOString(),
    account: { balance: ACCT_BALANCE, baseStake: BASE_STAKE, multiplier: MULT, maxLevels: MAX_LEVELS, tradeMultiplier: TRADE_MULT },
    yesterdayStartEpoch: YESTERDAY_START,
    results,
  }, null, 2));
  console.log("");
  console.log("Saved .tmp/fast-yesterday-results.json (with per-trade ledger)");
}

main().catch((e) => { console.error(e); process.exit(1); });

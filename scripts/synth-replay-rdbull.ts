// Production-code replay of RDBULL FVG strategy through historical 1h bars,
// stopping the day before yesterday. Wires the EXACT same production classes
// the live bot uses — Engine, PaperEngine, strategy filter, regimeFor — so we
// can verify what would have happened end-to-end.
//
// What this exercises:
//   - Engine seeded with rdbullFvg.detectors (validated FVG params, not defaults)
//   - Engine.onCandle(sym, candle, isNewBar=true) on each new historical bar
//   - passesStrategyFilters() applied to every signal (BUY-only / minAdx etc.)
//   - PaperEngine.openPosition() with the synth strategy's atrTpMult/atrSlMult
//   - PaperEngine.onCandle() settles TP/SL on each subsequent bar
//   - Adaptive shift modulation on stake (same as production)

import WebSocket from "ws";
import { Engine } from "../src/main/engine/runner";
import { rdbullFvg } from "../src/main/engine/synth-strategies";
import { PaperEngine, emptyPaperState } from "../src/bot/paper-engine";
import type { Candle, Signal, SymbolCode } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOL = "RDBULL";
const GR = 3600;
const STARTING_BALANCE = 500;

// Today is 2026-04-29; yesterday = 2026-04-28; the day before = 2026-04-27.
// We stop the replay at the END of 2026-04-27 so trades fire only on/before that.
const STOP_AT = Math.floor(new Date("2026-04-28T00:00:00Z").getTime() / 1000);
const REPLAY_DAYS = 7;
const REPLAY_FROM = STOP_AT - REPLAY_DAYS * 86400;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(p: any): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  const CHUNK = 5000; let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(CHUNK, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

function fmt(epoch: number): string {
  return new Date(epoch * 1000).toISOString().replace("T", " ").slice(0, 16);
}

// ── The same filter the production bot now applies to signals ────────────────
function passesStrategyFilters(s: typeof rdbullFvg, sig: Signal, adx: number): boolean {
  if (s.buyOnly && sig.action !== "BUY") return false;
  if (s.sellOnly && sig.action !== "SELL") return false;
  if (s.minAdx != null && adx < s.minAdx) return false;
  if (s.maxAdx != null && adx > s.maxAdx) return false;
  return true;
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Production-code replay — ${rdbullFvg.id} on ${SYMBOL} 1h`);
  console.log(`Replay window: ${fmt(REPLAY_FROM)} → ${fmt(STOP_AT)} (stops ~24h before yesterday)`);
  console.log(`Strategy: ${rdbullFvg.name}`);
  console.log(`  buyOnly=${rdbullFvg.buyOnly ?? false} · minAdx=${rdbullFvg.minAdx ?? "—"} · maxAdx=${rdbullFvg.maxAdx ?? "—"}`);
  console.log(`  atrTpMult=${rdbullFvg.atrTpMult} · atrSlMult=${rdbullFvg.atrSlMult}\n`);

  // Fetch enough history that the warmup is well-seeded and the replay range is included.
  // ~250 days × 24 bars/day ≈ 6000 bars. We'll trim to STOP_AT later.
  const all = await fetchPaged(c, SYMBOL, GR, 6000);
  c.close();
  // Drop everything strictly after STOP_AT — we only want bars up to the day before yesterday.
  const candles = all.filter((cd) => cd.epoch <= STOP_AT);
  if (candles.length < 200) { console.log(`only ${candles.length} bars — abort`); return; }
  console.log(`Fetched ${candles.length} bars (${fmt(candles[0].epoch)} → ${fmt(candles[candles.length-1].epoch)})\n`);

  // Find the index where the replay window starts; everything before that is warmup.
  let warmupEnd = 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].epoch >= REPLAY_FROM) { warmupEnd = i; break; }
  }
  if (warmupEnd === 0) warmupEnd = Math.max(0, candles.length - REPLAY_DAYS * 24);
  console.log(`Warmup: ${warmupEnd} bars · Replay: ${candles.length - warmupEnd} bars\n`);

  // Build a production Engine seeded with the warmup history.
  const eng = new Engine(rdbullFvg.detectors, { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
  eng.seed(SYMBOL as SymbolCode, candles.slice(0, warmupEnd));

  // Build a production PaperEngine starting at $500.
  const paper = new PaperEngine(emptyPaperState(STARTING_BALANCE));

  // Walk replay bars one at a time. For each new bar:
  //   - paper.onCandle settles any TP/SL hits this bar
  //   - eng.onCandle(isNewBar=true) emits live-style signals
  //   - passesStrategyFilters gates the signal
  //   - paper.openPosition opens a new sim trade
  console.log(`────── REPLAY ──────`);
  let signalCount = 0;
  for (let i = warmupEnd; i < candles.length; i++) {
    const candle = candles[i];

    // Settle first (so TP/SL of yesterday's open is closed before today's signal).
    const settled = paper.onCandle(SYMBOL as SymbolCode, GR, candle);
    for (const c of settled) {
      const bal = paper.getState().balance;
      console.log(`[${fmt(candle.epoch)}]  SETTLE  ${c.side.padEnd(4)} ${c.result.padEnd(4)}  pnl=${c.pnl >= 0 ? "+" : ""}$${c.pnl.toFixed(2)}  R=${c.rMultiple >= 0 ? "+" : ""}${c.rMultiple.toFixed(2)}  bal=$${bal.toFixed(2)}`);
    }

    // Engine.onCandle on a NEW bar → emits any signals.
    const r = eng.onCandle(SYMBOL as SymbolCode, candle, true);
    for (const sig of r.signals) {
      signalCount++;
      const adx = r.regime?.adx ?? 0;
      const passes = passesStrategyFilters(rdbullFvg, sig, adx);
      if (!passes) {
        console.log(`[${fmt(candle.epoch)}]  REJECT  ${sig.action.padEnd(4)} ${sig.detector}  adx=${adx.toFixed(1)}  (filter rejected)`);
        continue;
      }
      const alreadyOpen = paper.getState().open.some((p) => p.symbol === SYMBOL && p.side === sig.action);
      if (alreadyOpen) {
        console.log(`[${fmt(candle.epoch)}]  SKIP    ${sig.action.padEnd(4)} ${sig.detector}  (same-side position already open)`);
        continue;
      }
      const atr = eng.atrFor(SYMBOL as SymbolCode);
      const entry = eng.lastCloseFor(SYMBOL as SymbolCode) ?? candle.close;
      const pos = paper.openPosition({
        signalId: sig.id, symbol: SYMBOL as SymbolCode, side: sig.action, detector: sig.detector,
        entryPrice: entry, atr,
        atrTpMult: rdbullFvg.atrTpMult, atrSlMult: rdbullFvg.atrSlMult,
        multiplier: 30, granularity: GR, candleEpoch: candle.epoch,
        baseStake: 50, minStake: 1, nowMs: Date.now(),
      });
      if (pos) {
        console.log(`[${fmt(candle.epoch)}]  OPEN    ${sig.action.padEnd(4)} ${sig.detector}  entry=${pos.entryPrice.toFixed(5)}  sl=${pos.stopPrice.toFixed(5)}  tp=${pos.takeProfitPrice.toFixed(5)}  stake=$${pos.stake.toFixed(2)}  shift=${pos.appliedShiftReasons}`);
      } else {
        console.log(`[${fmt(candle.epoch)}]  REJECT  ${sig.action.padEnd(4)} (paper rejected — atr=${atr.toFixed(5)}, balance=$${paper.getState().balance.toFixed(2)})`);
      }
    }
  }

  // ── Final summary ──
  const s = paper.stats();
  const state = paper.getState();
  console.log(`\n────── REPLAY COMPLETE ──────`);
  console.log(`Replay bars: ${candles.length - warmupEnd} · Engine signals: ${signalCount}`);
  console.log(`Closed trades: ${s.trades} (${s.wins}W/${s.losses}L · ${(s.winRate * 100).toFixed(0)}% WR · avg ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R)`);
  console.log(`Open at end:  ${state.open.length}`);
  console.log(`Balance:      $${s.startingBalance.toFixed(2)} → $${s.balance.toFixed(2)} (${s.totalPnl >= 0 ? "+" : ""}$${s.totalPnl.toFixed(2)} · ${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(1)}%)`);
  console.log(`Peak / DD:    $${s.peak.toFixed(2)} / -${s.ddPct.toFixed(1)}% from peak`);

  if (state.open.length > 0) {
    console.log(`\nOpen positions at cutoff:`);
    for (const p of state.open) {
      console.log(`  ${fmt(p.openedAtCandleEpoch)}  ${p.side}  entry=${p.entryPrice.toFixed(5)}  sl=${p.stopPrice.toFixed(5)}  tp=${p.takeProfitPrice.toFixed(5)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

// Validate Gold + Plat strategies separately (Gold/Plat 1h history is ~136d so fetch 4000 bars max).

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { goldOb } from "../src/main/engine/strategies/gold-ob";
import { goldSweep } from "../src/main/engine/strategies/gold-sweep";
import { goldFvg } from "../src/main/engine/strategies/gold-fvg";
import { platFvg } from "../src/main/engine/strategies/plat-fvg";
import type { Candle, StrategyDescriptor } from "../src/shared/types";
import type { StrategyDescriptor as Sd } from "../src/main/engine/strategies/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 50; const MULT = 30;

class C {
  ws: WebSocket; reqId = 1;
  pending = new Map<number, any>();
  ready: Promise<void>;
  constructor() { this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => { try { const m = JSON.parse(String(raw)); const id = m.req_id;
      if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(p: any): Promise<any> { const id = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id })); setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
  close() { this.ws.close(); } }

async function fetchPaged(c: C, sym: string, gr: number, cnt: number): Promise<Candle[]> {
  let cursor: any = "latest"; let collected: Candle[] = [];
  while (collected.length < cnt) {
    const want = Math.min(5000, cnt - collected.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch: Candle[] = raw.map((cd) => ({ epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close }));
    collected = ch.concat(collected); cursor = String(ch[0].epoch - 1); if (ch.length < want) break;
  }
  const seen = new Set<number>(); const out: Candle[] = [];
  for (const cn of collected) if (!seen.has(cn.epoch)) { seen.add(cn.epoch); out.push(cn); }
  out.sort((a, b) => a.epoch - b.epoch); return out;
}

async function runWindowed(s: StrategyDescriptor, allCandles: Candle[], windowStart: number, windowEnd: number) {
  let endIdx = allCandles.length - 1;
  for (let i = allCandles.length - 1; i >= 0; i--) {
    if (allCandles[i].epoch < windowEnd) { endIdx = i; break; }
  }
  const candles = allCandles.slice(0, endIdx + 1);
  const sd = s as Sd;
  const r = await runBacktest({
    symbol: s.symbols[0], granularity: s.granularity as any, count: candles.length,
    atrSlMult: s.atrSlMult, atrTpMult: s.atrTpMult, costBps: s.costBps,
    maxAdx: sd.maxAdx, minAdx: sd.minAdx,
    withTrendOnlyAboveAdx: sd.withTrendOnlyAboveAdx,
    skipDaysOfWeekUtc: sd.skipDaysOfWeekUtc,
    buyOnly: sd.buyOnly, sellOnly: sd.sellOnly,
    detectors: s.detectors,
    strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
  } as any, candles);
  const inWin = r.trades.filter((t) => candles[t.openedAtIndex].epoch >= windowStart);
  const wins = inWin.filter((t) => t.pnlPct > 0).length;
  let totalR = 0, pnlUsd = 0;
  for (const t of inWin) {
    const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    if (risk > 0) totalR += t.pnlPct / risk;
    pnlUsd += STAKE * Math.max(-1, t.pnlPct * MULT);
  }
  const expR = inWin.length ? totalR / inWin.length : 0;
  return { trades: inWin.length, wins, expR, pnlUsd };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`Validating Gold + Plat (1h, max depth ~137d)\n`);
  const candles = await fetchPaged(c, "frxXAUUSD", 3600, 4000);
  c.close();
  const c2 = new C(); await c2.ready;
  const platCandles = await fetchPaged(c2, "frxXPTUSD", 3600, 4000);
  c2.close();
  console.log(`Gold: ${candles.length} 1h bars from ${new Date(candles[0].epoch*1000).toISOString().slice(0,10)} to ${new Date(candles[candles.length-1].epoch*1000).toISOString().slice(0,10)}`);
  console.log(`Plat: ${platCandles.length} 1h bars from ${new Date(platCandles[0].epoch*1000).toISOString().slice(0,10)} to ${new Date(platCandles[platCandles.length-1].epoch*1000).toISOString().slice(0,10)}`);

  // Gold has ~136d. Use 60/45/27 split (W0/TRAIN/TEST).
  const goldLatest = candles[candles.length-1].epoch;
  const TEST_END = goldLatest + 1;
  const TEST_START = TEST_END - 27 * 86400;
  const TRAIN_END = TEST_START;
  const TRAIN_START = TRAIN_END - 60 * 86400;
  const W0_END = TRAIN_START;
  const W0_START = W0_END - 45 * 86400;
  console.log(`Gold windows: W0 ${new Date(W0_START*1000).toISOString().slice(0,10)} → TRAIN → TEST (45/60/27)\n`);

  const verdicts: any[] = [];
  for (const s of [goldOb, goldSweep, goldFvg]) {
    const w0 = await runWindowed(s, candles, W0_START, W0_END);
    const tr = await runWindowed(s, candles, TRAIN_START, TRAIN_END);
    const te = await runWindowed(s, candles, TEST_START, TEST_END);
    const passes = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
    verdicts.push({ id: s.id, w0, tr, te, passes });
    const fmt = (r: any) => `${String(r.trades).padStart(3)}t ${(r.trades?(100*r.wins/r.trades).toFixed(0):"0").padStart(3)}% ${(r.expR>=0?"+":"")}${r.expR.toFixed(2)}R ${(r.pnlUsd>=0?"+":"")}$${r.pnlUsd.toFixed(0).padStart(5)}`;
    console.log(`  ${s.id.padEnd(14)} ${passes?"✓ PASS":"✗ FAIL"} | W0 ${fmt(w0)} | TRAIN ${fmt(tr)} | TEST ${fmt(te)}`);
  }

  // Plat: same windows
  console.log(``);
  for (const s of [platFvg]) {
    const w0 = await runWindowed(s, platCandles, W0_START, W0_END);
    const tr = await runWindowed(s, platCandles, TRAIN_START, TRAIN_END);
    const te = await runWindowed(s, platCandles, TEST_START, TEST_END);
    const passes = w0.pnlUsd >= 0 && tr.pnlUsd >= 0 && te.pnlUsd >= 0;
    verdicts.push({ id: s.id, w0, tr, te, passes });
    const fmt = (r: any) => `${String(r.trades).padStart(3)}t ${(r.trades?(100*r.wins/r.trades).toFixed(0):"0").padStart(3)}% ${(r.expR>=0?"+":"")}${r.expR.toFixed(2)}R ${(r.pnlUsd>=0?"+":"")}$${r.pnlUsd.toFixed(0).padStart(5)}`;
    console.log(`  ${s.id.padEnd(14)} ${passes?"✓ PASS":"✗ FAIL"} | W0 ${fmt(w0)} | TRAIN ${fmt(tr)} | TEST ${fmt(te)}`);
  }

  console.log(`\n══════════════════════════════════════════════════════════════════════════════`);
  console.log(`SUMMARY: ${verdicts.filter((v:any)=>v.passes).length}/${verdicts.length} pass`);
  for (const v of verdicts) console.log(`  ${v.id.padEnd(14)} ${v.passes?"✓ PASS":"✗ FAIL"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

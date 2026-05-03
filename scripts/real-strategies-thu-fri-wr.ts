// Real strategies Thu-Fri + win-rate / P&L resolution.
// Each signal walks forward through subsequent bars to find TP or SL hit.

import { Engine, ALL_DETECTORS } from "../src/main/engine/runner";
import { STRATEGIES } from "../src/main/engine/strategies";
import type { Candle, DetectorConfig, SymbolCode } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const STAKE = Number(process.env.STAKE ?? 5);
const ACCT_INIT = Number(process.env.ACCT ?? 41);
const MULT = 30;
const COMMISSION_FRAC = 0.005;

// February 2026: 2026-02-01 00:00 UTC → 2026-03-01 00:00 UTC
const THU_START = Math.floor(Date.UTC(2026, 1, 1, 0, 0, 0) / 1000);
const FRI_END = Math.floor(Date.UTC(2026, 2, 1, 0, 0, 0) / 1000);
const RESOLVE_END = FRI_END + 7 * 86400;
const HISTORY_LOOKBACK = 300;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchCandles(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  // Try both numeric end and "latest" — some markets close on weekends so latest is safer
  const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count, end: end > 0 ? String(end) : "latest", style: "candles", granularity: gr });
  const raw = (r.candles ?? []) as any[];
  return raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
    .sort((a, b) => a.epoch - b.epoch);
}

function buildEngineDetectorConfigs(sym: string, gr: number): DetectorConfig[] {
  const merged: DetectorConfig[] = ALL_DETECTORS.map((d) => ({ id: d.id, label: d.label, enabled: false, params: { ...d.defaultParams } }));
  for (const strat of STRATEGIES) {
    if (!strat.symbols.includes(sym as any) || strat.granularity !== gr) continue;
    for (const sd of strat.detectors) {
      if (!sd.enabled) continue;
      const slot = merged.find((m) => m.id === sd.id);
      if (!slot) continue;
      slot.enabled = true;
      slot.params = { ...sd.params };
    }
  }
  return merged;
}

type ResolvedTrade = { strategy: string; sym: string; epoch: number; side: "BUY" | "SELL"; entry: number; sl: number; tp: number; result: "TP" | "SL" | "OPEN"; barsToExit: number; rMultiple: number; pnl: number };

function resolve(side: "BUY" | "SELL", entry: number, sl: number, tp: number, futureBars: Candle[]): { result: "TP" | "SL" | "OPEN"; barsToExit: number } {
  for (let i = 0; i < futureBars.length; i++) {
    const b = futureBars[i];
    if (side === "BUY") {
      if (b.low <= sl) return { result: "SL", barsToExit: i + 1 };
      if (b.high >= tp) return { result: "TP", barsToExit: i + 1 };
    } else {
      if (b.high >= sl) return { result: "SL", barsToExit: i + 1 };
      if (b.low <= tp) return { result: "TP", barsToExit: i + 1 };
    }
  }
  return { result: "OPEN", barsToExit: futureBars.length };
}

async function main() {
  const c = new C(); await c.ready;
  const realStrategies = STRATEGIES.filter((s) => ["silver_ob", "silver_fvg", "gold_ob", "gold_fvg", "plat_fvg", "pall_sweep"].includes(s.id));

  const symGrMap = new Map<string, Map<number, typeof realStrategies>>();
  for (const s of realStrategies) {
    for (const sym of s.symbols) {
      if (!symGrMap.has(sym)) symGrMap.set(sym, new Map());
      const grMap = symGrMap.get(sym)!;
      if (!grMap.has(s.granularity)) grMap.set(s.granularity, []);
      grMap.get(s.granularity)!.push(s);
    }
  }

  const allTrades: ResolvedTrade[] = [];

  for (const [sym, grMap] of symGrMap) {
    for (const [gr, strats] of grMap) {
      // Fetch enough to cover lookback + Thu-Fri + 1 week resolution buffer
      const totalBars = HISTORY_LOOKBACK + Math.ceil((RESOLVE_END - THU_START) / gr);
      let candles: Candle[] = [];
      try { candles = await fetchCandles(c, sym, gr, totalBars, RESOLVE_END); } catch (e) { continue; }
      if (candles.length === 0) continue;

      const cfgs = buildEngineDetectorConfigs(sym, gr);
      const eng = new Engine(cfgs, { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });

      const seedBars = candles.filter((b) => b.epoch < THU_START);
      const evalBars = candles.filter((b) => b.epoch >= THU_START && b.epoch < FRI_END);
      eng.seed(sym as SymbolCode, seedBars);

      // Track signals + their bar index for forward resolution
      for (const bar of evalBars) {
        const r = eng.onCandle(sym as SymbolCode, bar, true);
        for (const s of r.signals) {
          if (s.stopPrice == null || s.targetPrice == null) continue;
          const entry = s.price ?? bar.close;
          const sl = s.stopPrice;
          const tp = s.targetPrice;
          const idx = candles.findIndex((c) => c.epoch === bar.epoch);
          const future = candles.slice(idx + 1);
          const { result, barsToExit } = resolve(s.action as any, entry, sl, tp, future);
          // R-multiple: distance to TP vs distance to SL
          const slDist = Math.abs(entry - sl);
          const tpDist = Math.abs(entry - tp);
          const rrRatio = slDist > 0 ? tpDist / slDist : 0;
          let rMult = 0;
          if (result === "TP") rMult = rrRatio;
          else if (result === "SL") rMult = -1;
          // PnL approximation via multiplier: stake × MULT × moveFrac − commission(open+close)
          const moveFrac = result === "TP"
            ? (s.action === "BUY" ? (tp - entry) / entry : (entry - tp) / entry)
            : result === "SL"
            ? (s.action === "BUY" ? (sl - entry) / entry : (entry - sl) / entry)
            : 0;
          const commission = STAKE * COMMISSION_FRAC * 2;
          let pnl = STAKE * MULT * moveFrac - commission;
          if (pnl < -STAKE) pnl = -STAKE;
          // Strategy attribution: find which loaded strategy uses this detector
          const strat = strats.find((st) => st.detectors.some((d) => d.id === s.detector && d.enabled))?.id ?? `${sym}_${s.detector}`;
          allTrades.push({ strategy: strat, sym, epoch: bar.epoch, side: s.action as any, entry, sl, tp, result, barsToExit, rMultiple: rMult, pnl });
        }
      }
    }
  }
  c.close();

  // Sort all trades chronologically and walk balance with bust check
  allTrades.sort((a, b) => a.epoch - b.epoch);
  let balance = ACCT_INIT;
  let peak = ACCT_INIT, trough = ACCT_INIT;
  let bust = false, bustEpoch = 0;
  let tradesTaken = 0, tradesBlocked = 0;
  for (const t of allTrades) {
    if (bust) { tradesBlocked++; continue; }
    const commission = STAKE * COMMISSION_FRAC * 2;
    if (balance < STAKE + commission) { bust = true; bustEpoch = t.epoch; tradesBlocked++; continue; }
    if (t.result === "OPEN") { tradesTaken++; continue; }
    balance += t.pnl;
    if (balance > peak) peak = balance;
    if (balance < trough) trough = balance;
    tradesTaken++;
  }

  // Per-strategy summary (only counted from trades actually taken)
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`REAL STRATEGIES — Feb 2026 · $${ACCT_INIT} acct / $${STAKE} stake / ${MULT}x mult`);
  console.log(`${"".padEnd(110, "═")}`);
  const groups = new Map<string, ResolvedTrade[]>();
  for (const t of allTrades) {
    if (!groups.has(t.strategy)) groups.set(t.strategy, []);
    groups.get(t.strategy)!.push(t);
  }
  console.log(`  strategy        trades   W   L   open   WR     net R     net $       per-trade $`);
  let totalT = 0, totalW = 0, totalL = 0, totalOpen = 0, totalR = 0, totalPnl = 0;
  for (const [strat, ts] of groups) {
    const w = ts.filter((t) => t.result === "TP").length;
    const l = ts.filter((t) => t.result === "SL").length;
    const o = ts.filter((t) => t.result === "OPEN").length;
    const settled = w + l;
    const wr = settled > 0 ? w / settled : 0;
    const r = ts.reduce((s, t) => s + t.rMultiple, 0);
    const pnl = ts.filter((t) => t.result !== "OPEN").reduce((s, t) => s + t.pnl, 0);
    totalT += ts.length; totalW += w; totalL += l; totalOpen += o; totalR += r; totalPnl += pnl;
    console.log(`  ${strat.padEnd(14)}  ${String(ts.length).padStart(5)}t   ${String(w).padStart(2)}  ${String(l).padStart(2)}   ${String(o).padStart(2)}    ${(wr*100).toFixed(0).padStart(2)}%   ${r >= 0 ? "+" : ""}${r.toFixed(2)}R   ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2).padStart(7)}    ${ts.length > 0 ? (pnl/Math.max(1,settled)).toFixed(2) : "0"}`);
  }
  console.log(`  ──────────`);
  const totalWr = (totalW + totalL) > 0 ? totalW / (totalW + totalL) : 0;
  console.log(`  TOTAL           ${String(totalT).padStart(5)}t   ${String(totalW).padStart(2)}  ${String(totalL).padStart(2)}   ${String(totalOpen).padStart(2)}    ${(totalWr*100).toFixed(0).padStart(2)}%   ${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R   ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2).padStart(7)}`);
  console.log(`\nPERSISTENT BALANCE (chronological, $${ACCT_INIT} starting):`);
  console.log(`  Trades taken: ${tradesTaken}  blocked (insufficient balance): ${tradesBlocked}`);
  console.log(`  Final balance: $${balance.toFixed(2)}  (Δ ${balance - ACCT_INIT >= 0 ? "+" : ""}$${(balance - ACCT_INIT).toFixed(2)})`);
  console.log(`  Peak: $${peak.toFixed(2)}   Trough: $${trough.toFixed(2)}`);
  console.log(`  Bust: ${bust ? `💀 YES at ${new Date(bustEpoch * 1000).toISOString().slice(0, 16)} UTC` : "no"}`);

  // Trade-by-trade detail
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`TRADE-BY-TRADE`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`  ts (UTC)              strategy        side  entry        SL       TP       result   bars   R       $`);
  allTrades.sort((a, b) => a.epoch - b.epoch);
  for (const t of allTrades) {
    const ts = new Date(t.epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
    const r = t.result === "TP" ? "WIN " : t.result === "SL" ? "LOSS" : "open";
    console.log(`  ${ts}    ${t.strategy.padEnd(14)}  ${t.side.padEnd(4)}  ${t.entry.toFixed(4).padStart(9)}  ${t.sl.toFixed(4).padStart(9)}  ${t.tp.toFixed(4).padStart(9)}  ${r}    ${String(t.barsToExit).padStart(3)}    ${t.rMultiple >= 0 ? "+" : ""}${t.rMultiple.toFixed(2)}    ${t.result === "OPEN" ? "—" : (t.pnl >= 0 ? "+" : "") + "$" + t.pnl.toFixed(2)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });

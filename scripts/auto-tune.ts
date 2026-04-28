// Automated grid-search tuner for the orderBlock detector.
//
// Fetches all real-history symbols once, then sweeps multiple parameter
// configurations + R:R ratios. Picks the config that maximises the count of
// symbols clearing a "recommendable" bar (Expectancy ≥ MIN_EXPECTANCY R on
// ≥ MIN_TRADES trades). Prints the winning config and the symbol whitelist.

import WebSocket from "ws";
import { runBacktest } from "../src/main/engine/backtest";
import { defaultDetectorConfigs } from "../src/main/engine/runner";
import { SYMBOLS } from "../src/shared/symbols";
import type { Candle, DetectorConfig } from "../src/shared/types";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const GRANULARITY = 60;       // 1m bars
const COUNT = 1440;           // exactly 24 hours per symbol — "one trading day"
const COST_BPS = 2.0;         // tighter cost — realistic FX major
const STAKE_USD = 50;
const MULTIPLIER = 30;

// Recommendable bar (relaxed for single-day sample).
const MIN_EXPECTANCY = 0.20;  // ≥ +0.20R per trade
const MIN_TRADES = 20;        // 1-day sample → lower threshold
const MIN_QUALIFIED_SYMBOLS = 3;

type ObParams = Record<string, number>;

type Configuration = {
  name: string;
  obParams: ObParams;
  atrSlMult: number;
  atrTpMult: number;
  /** Whether to also run the liquiditySweep detector (required for the OB
   *  detector's `requireLiquiditySweep` filter to ever pass). */
  enableSweep: boolean;
};

// Six base parameter sets, ranged from loose → strict ICT.
const baseConfigs: Array<{ name: string; params: ObParams }> = [
  {
    name: "loose (current defaults)",
    params: {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
      requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
    },
  },
  {
    name: "+FVG",
    params: {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
      requireFVG: 1, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
    },
  },
  {
    name: "+FVG +quality(10)",
    params: {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
      requireFVG: 1, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 10,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
    },
  },
  {
    name: "+FVG +quality +4candle",
    params: {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3,
      requireFVG: 1, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 1, retestConfirmationBars: 2, qualityFilterLookback: 10,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
    },
  },
  {
    name: "+FVG +quality +4candle +disp1.2",
    params: {
      lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 1.2, obSearchMaxBack: 3,
      requireFVG: 1, requireLiquiditySweep: 0, sweepLookbackBars: 30,
      fourCandleValidation: 1, retestConfirmationBars: 2, qualityFilterLookback: 10,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0,
    },
  },
  {
    name: "strict ICT (FVG+sweep+quality+4candle+disp1.2+CE)",
    params: {
      lookback: 20, atrPeriod: 14, displacementAtrMultiplier: 1.2, obSearchMaxBack: 2,
      requireFVG: 1, requireLiquiditySweep: 1, sweepLookbackBars: 30,
      fourCandleValidation: 1, retestConfirmationBars: 2, qualityFilterLookback: 10,
      rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 1,
    },
  },
];

const rrPairs: Array<{ slMult: number; tpMult: number; label: string }> = [
  { slMult: 1.0, tpMult: 2.0, label: "2:1" },
  { slMult: 1.0, tpMult: 3.0, label: "3:1" },
  { slMult: 1.5, tpMult: 2.0, label: "1.33:1" },
];

const configurations: Configuration[] = [];
for (const b of baseConfigs) {
  for (const rr of rrPairs) {
    configurations.push({
      name: `${b.name} · ${rr.label}`,
      obParams: b.params,
      atrSlMult: rr.slMult,
      atrTpMult: rr.tpMult,
      // Sweep detector must run when the OB filter requires sweeps.
      enableSweep: (b.params.requireLiquiditySweep ?? 0) >= 1,
    });
  }
}

function tradeUsd(pnlPct: number, stake: number, mult: number): number {
  return stake * Math.max(-1, pnlPct * mult);
}

class Client {
  ws: WebSocket;
  reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((resolve, reject) => {
      this.ws.on("open", () => resolve());
      this.ws.on("error", reject);
    });
    this.ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw));
        const id = msg.req_id as number | undefined;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (msg.error) reject(new Error(msg.error.message ?? "WS error"));
          else resolve(msg);
        }
      } catch {}
    });
  }
  send(payload: Record<string, unknown>): Promise<any> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...payload, req_id: id }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout"));
        }
      }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function fetchPaged(c: Client, symbol: string, granularity: number, count: number): Promise<Candle[]> {
  const CHUNK = 5000;
  let cursor: string = "latest";
  let collected: Candle[] = [];
  while (collected.length < count) {
    const want = Math.min(CHUNK, count - collected.length);
    const r = await c.send({
      ticks_history: symbol, adjust_start_time: 1, count: want,
      end: cursor, style: "candles", granularity,
    });
    const raw = (r.candles ?? []) as Array<{ epoch: number; open: number; high: number; low: number; close: number }>;
    if (raw.length === 0) break;
    const chunk: Candle[] = raw.map((cd) => ({
      epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close,
    }));
    collected = chunk.concat(collected);
    cursor = String(chunk[0].epoch - 1);
    if (chunk.length < want) break;
  }
  const seen = new Set<number>();
  const out: Candle[] = [];
  for (const cd of collected) {
    if (seen.has(cd.epoch)) continue;
    seen.add(cd.epoch);
    out.push(cd);
  }
  out.sort((a, b) => a.epoch - b.epoch);
  return out;
}

type SymbolResult = {
  symbol: string;
  label: string;
  group: string;
  trades: number;
  wins: number;
  winRate: number;
  expectancyR: number;
  pnlPct: number;
  pnlUsd: number;
  qualifies: boolean; // ≥ MIN_TRADES and ≥ MIN_EXPECTANCY
};

type ConfigResult = {
  config: Configuration;
  perSymbol: SymbolResult[];
  qualifiedCount: number;
  totalTrades: number;
  totalUsd: number;
  avgExpR: number; // mean across symbols (equal weight)
  qualifiedAvgExpR: number; // mean across qualified symbols only
};

async function main() {
  const realSymbols = SYMBOLS.filter((s) => s.group !== "Synthetic");
  const c = new Client();
  await c.ready;
  console.log(`[tune] connected · fetching history for ${realSymbols.length} symbols (1h × ${COUNT} bars)…\n`);

  // Fetch all candles once.
  const candleMap = new Map<string, { def: typeof realSymbols[number]; candles: Candle[] }>();
  for (const def of realSymbols) {
    process.stdout.write(`  ${def.label.padEnd(22)} `);
    try {
      const cs = await fetchPaged(c, def.code, GRANULARITY, COUNT);
      if (cs.length < 100) {
        console.log(`SKIP (only ${cs.length})`);
        continue;
      }
      candleMap.set(def.code, { def, candles: cs });
      console.log(`${cs.length} bars`);
    } catch (e) {
      console.log(`SKIP (${(e as Error).message})`);
    }
  }
  c.close();

  console.log(`\n[tune] running ${configurations.length} configurations × ${candleMap.size} symbols…\n`);

  const allResults: ConfigResult[] = [];
  for (const cfg of configurations) {
    const baseDetectors: DetectorConfig[] = defaultDetectorConfigs().map((d) => ({
      ...d,
      enabled: d.id === "orderBlock" || (cfg.enableSweep && d.id === "liquiditySweep"),
      params: d.id === "orderBlock" ? cfg.obParams : d.params,
    }));

    const perSymbol: SymbolResult[] = [];
    for (const { def, candles } of candleMap.values()) {
      const r = await runBacktest({
        symbol: def.code,
        granularity: GRANULARITY as any,
        count: candles.length,
        atrSlMult: cfg.atrSlMult,
        atrTpMult: cfg.atrTpMult,
        costBps: COST_BPS,
        detectors: baseDetectors,
        strategy: { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 },
      }, candles);
      const wins = r.trades.filter((t) => t.pnlPct > 0).length;
      let totalR = 0, pnlUsd = 0;
      for (const t of r.trades) {
        const risk = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
        if (risk > 0) totalR += t.pnlPct / risk;
        pnlUsd += tradeUsd(t.pnlPct, STAKE_USD, MULTIPLIER);
      }
      const expectancyR = r.trades.length > 0 ? totalR / r.trades.length : 0;
      const qualifies = r.trades.length >= MIN_TRADES && expectancyR >= MIN_EXPECTANCY;
      perSymbol.push({
        symbol: def.code, label: def.label, group: def.group,
        trades: r.trades.length, wins,
        winRate: r.trades.length ? wins / r.trades.length : 0,
        expectancyR, pnlPct: r.stats.totalPnlPct, pnlUsd, qualifies,
      });
    }

    const qualified = perSymbol.filter((s) => s.qualifies);
    const totalTrades = perSymbol.reduce((s, r) => s + r.trades, 0);
    const totalUsd = perSymbol.reduce((s, r) => s + r.pnlUsd, 0);
    const avgExpR = perSymbol.length ? perSymbol.reduce((s, r) => s + r.expectancyR, 0) / perSymbol.length : 0;
    const qualifiedAvgExpR = qualified.length ? qualified.reduce((s, r) => s + r.expectancyR, 0) / qualified.length : 0;

    allResults.push({
      config: cfg, perSymbol, qualifiedCount: qualified.length,
      totalTrades, totalUsd, avgExpR, qualifiedAvgExpR,
    });
    console.log(
      `  [${cfg.name.padEnd(48)}] qualified=${String(qualified.length).padStart(2)}/${candleMap.size} · ` +
      `trades=${String(totalTrades).padStart(4)} · avgExpR=${avgExpR >= 0 ? "+" : ""}${avgExpR.toFixed(2)}R · ` +
      `qual.avgExpR=${qualifiedAvgExpR >= 0 ? "+" : ""}${qualifiedAvgExpR.toFixed(2)}R · pnl=${totalUsd >= 0 ? "+" : ""}$${totalUsd.toFixed(2)}`,
    );
  }

  // Pick the winning config: maximise qualified count, then qualified avg expectancy.
  allResults.sort((a, b) => b.qualifiedCount - a.qualifiedCount || b.qualifiedAvgExpR - a.qualifiedAvgExpR);

  console.log("\n========== TOP CONFIGURATIONS ==========");
  for (const r of allResults.slice(0, 5)) {
    console.log(`${r.config.name}`);
    console.log(`  qualified=${r.qualifiedCount} · totalTrades=${r.totalTrades} · avgExpR=${r.avgExpR.toFixed(2)}R · qual.avgExpR=${r.qualifiedAvgExpR.toFixed(2)}R · pnl=$${r.totalUsd.toFixed(2)}`);
  }

  const best = allResults[0];
  console.log(`\n========== WINNER ==========`);
  console.log(`Configuration: ${best.config.name}`);
  console.log(`SL ${best.config.atrSlMult}×ATR · TP ${best.config.atrTpMult}×ATR`);
  console.log(`Qualified symbols: ${best.qualifiedCount} / ${candleMap.size}`);
  console.log(`Total trades: ${best.totalTrades}`);
  console.log(`Average Expectancy R (qualified only): ${best.qualifiedAvgExpR >= 0 ? "+" : ""}${best.qualifiedAvgExpR.toFixed(2)}R`);
  console.log(`Combined P&L: ${best.totalUsd >= 0 ? "+" : ""}$${best.totalUsd.toFixed(2)}`);
  console.log(`\nDetector params:`);
  console.log(JSON.stringify(best.config.obParams, null, 2));

  console.log(`\n========== TRADEABLE ASSETS (qualified) ==========`);
  const sorted = best.perSymbol.filter((s) => s.qualifies).sort((a, b) => b.expectancyR - a.expectancyR);
  if (sorted.length === 0) {
    console.log("(none meet the bar — see closest below)");
    const close = best.perSymbol
      .filter((s) => s.trades >= MIN_TRADES)
      .sort((a, b) => b.expectancyR - a.expectancyR)
      .slice(0, 5);
    for (const r of close) {
      console.log(`  ${r.label.padEnd(22)} ${r.group.padEnd(12)} trades=${r.trades} WR=${(r.winRate*100).toFixed(0)}% expR=${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R pnl=${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
    }
  } else {
    for (const r of sorted) {
      console.log(`  ${r.label.padEnd(22)} ${r.group.padEnd(12)} trades=${r.trades} WR=${(r.winRate*100).toFixed(0)}% expR=${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R pnl=${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`);
    }
  }

  // Verdict
  const recommendable = best.qualifiedCount >= MIN_QUALIFIED_SYMBOLS && best.qualifiedAvgExpR >= MIN_EXPECTANCY;
  console.log(`\n========== VERDICT ==========`);
  if (recommendable) {
    console.log(`✓ RECOMMENDABLE — at least ${MIN_QUALIFIED_SYMBOLS} symbols clear ≥${MIN_EXPECTANCY}R on ≥${MIN_TRADES} trades.`);
  } else {
    console.log(`✗ NOT YET RECOMMENDABLE — best config qualifies only ${best.qualifiedCount} symbols.`);
    console.log(`  Need ≥${MIN_QUALIFIED_SYMBOLS} symbols with expR ≥ +${MIN_EXPECTANCY}R on ≥${MIN_TRADES} trades.`);
    console.log(`  Closest gap: avg qualifying expR=${best.qualifiedAvgExpR.toFixed(2)}R.`);
  }
}

main().catch((e) => { console.error("[tune] failed:", e); process.exit(1); });

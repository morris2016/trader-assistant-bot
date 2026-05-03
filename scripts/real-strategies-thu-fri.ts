// Simulate the 6 real-asset strategies on Thu (2026-04-30) and Fri (2026-05-01)
// using the FIXED engine logic — detectors now evaluate on bar-CLOSE.
// Pulls 1h candles from Deriv, seeds engine, replays bar-by-bar.

import { Engine, ALL_DETECTORS, defaultDetectorConfigs } from "../src/main/engine/runner";
import { STRATEGIES } from "../src/main/engine/strategies";
import type { Candle, DetectorConfig, SymbolCode } from "../src/shared/types";

const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

// Thu 00:00 UTC → Fri 23:59 UTC (2 calendar days × 24h = 48h, 48 1h bars + ~200 lookback for ATR/swings)
const THU_START = Math.floor(Date.UTC(2026, 3, 30, 0, 0, 0) / 1000); // April 30 00:00 UTC
const FRI_END = Math.floor(Date.UTC(2026, 4, 2, 0, 0, 0) / 1000);    // May 2 00:00 UTC (Fri end)
const HISTORY_LOOKBACK = 250;  // bars before THU_START for indicator warmup
const FETCH_END = FRI_END;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchCandles(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count, end: String(end), style: "candles", granularity: gr });
  const raw = (r.candles ?? []) as any[];
  return raw.map((k) => ({ epoch: k.epoch, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: 0 } as Candle))
    .sort((a, b) => a.epoch - b.epoch);
}

// Build per-(sym,gr) detector configs by merging all matching strategies
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

async function main() {
  const c = new C(); await c.ready;

  // The 6 real strategies all use 1h granularity. Symbols and matching strats:
  const realStrategies = STRATEGIES.filter((s) =>
    ["silver_ob", "silver_fvg", "gold_ob", "gold_fvg", "plat_fvg", "pall_sweep"].includes(s.id)
  );
  if (realStrategies.length === 0) { console.error("Real strategies not found"); c.close(); return; }
  console.log(`Real-asset strategies: ${realStrategies.map((s) => s.id).join(", ")}\n`);

  // Build symbol → (gr → strategies) map
  const symGrMap = new Map<string, Map<number, typeof realStrategies>>();
  for (const s of realStrategies) {
    for (const sym of s.symbols) {
      if (!symGrMap.has(sym)) symGrMap.set(sym, new Map());
      const grMap = symGrMap.get(sym)!;
      if (!grMap.has(s.granularity)) grMap.set(s.granularity, []);
      grMap.get(s.granularity)!.push(s);
    }
  }

  // Fetch + replay each (sym, gr)
  for (const [sym, grMap] of symGrMap) {
    for (const [gr, strats] of grMap) {
      const totalBars = HISTORY_LOOKBACK + Math.ceil((FRI_END - THU_START) / gr);
      console.log(`${"".padEnd(90, "═")}`);
      console.log(`${sym}@${gr}s · strategies: ${strats.map((s) => s.id).join(", ")}`);
      console.log(`Fetching ${totalBars} bars ending ${new Date(FETCH_END * 1000).toISOString()}...`);
      let candles: Candle[] = [];
      try {
        candles = await fetchCandles(c, sym, gr, totalBars, FETCH_END);
      } catch (e) {
        console.log(`  fetch failed: ${(e as Error).message}\n`);
        continue;
      }
      if (candles.length === 0) { console.log(`  no data\n`); continue; }
      console.log(`  Got ${candles.length} bars from ${new Date(candles[0].epoch * 1000).toISOString()} to ${new Date(candles[candles.length - 1].epoch * 1000).toISOString()}\n`);

      // Build engine
      const cfgs = buildEngineDetectorConfigs(sym, gr);
      const enabled = cfgs.filter((d) => d.enabled);
      console.log(`  Detectors enabled: ${enabled.map((d) => d.id).join(", ")}`);

      const eng = new Engine(cfgs, { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
      // Seed all bars BEFORE the Thu-Fri window (lookback for indicator warmup)
      const seedBars = candles.filter((b) => b.epoch < THU_START);
      const evalBars = candles.filter((b) => b.epoch >= THU_START && b.epoch < FRI_END);
      console.log(`  Seeding ${seedBars.length} bars (warmup), then replaying ${evalBars.length} bars (Thu-Fri)\n`);

      eng.seed(sym as SymbolCode, seedBars);

      // Replay each Thu-Fri bar via onCandle (mimicking live tick stream)
      const signals: Array<{ epoch: number; detector: string; action: string; price: number; sl: number | undefined; tp: number | undefined }> = [];
      for (const bar of evalBars) {
        // Production receives ohlc updates as ticks flow. To mimic the FIXED engine
        // behavior properly: deliver each closed bar as a SINGLE isNew=true call
        // (using the bar's final close as if it just closed). This is what the
        // post-fix engine evaluates on (the previous bar's accumulated close).
        const r = eng.onCandle(sym as SymbolCode, bar, true);
        for (const s of r.signals) {
          signals.push({ epoch: bar.epoch, detector: s.detector, action: s.action, price: s.price ?? bar.close, sl: s.stopPrice, tp: s.targetPrice });
        }
      }

      console.log(`  Signals fired during Thu-Fri: ${signals.length}`);
      if (signals.length === 0) {
        console.log(`  (no detector emitted a signal in this window)\n`);
        continue;
      }
      console.log(`  ts (UTC)              detector            side  entry        SL           TP`);
      for (const s of signals) {
        const ts = new Date(s.epoch * 1000).toISOString().slice(0, 16).replace("T", " ");
        console.log(`  ${ts}    ${s.detector.padEnd(18)}  ${s.action.padEnd(4)}  ${s.price.toFixed(5)}    ${s.sl?.toFixed(5) ?? "—"}    ${s.tp?.toFixed(5) ?? "—"}`);
      }
      console.log();
    }
  }

  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });

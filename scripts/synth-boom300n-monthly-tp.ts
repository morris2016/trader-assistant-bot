// BOOM 300N monthly breakdown for top TP candidates: 0.5 (current), 0.7, 1.0, 1.5.
import type { Candle } from "../src/shared/types";
const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const STAKE = 3, MULT = 100, COMMISSION_FRAC = 0.005, ENTRY_SPREAD_FRAC = 1/10000, SL_SLIPPAGE_FRAC = 5/10000;
const ATR_PERIOD = 14, SPIKE_NATR = 3.0, BUFFER_ATR = 0.05;
const SYM = "BOOM300N", GR = 60;
const JAN_1_2025 = Math.floor(Date.UTC(2025, 0, 1) / 1000);
const TODAY = Math.floor(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) / 1000);

class C {
  ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 60_000); }); }
  close() { try { this.ws.close(); } catch {} }
}
async function fetchPaged(c: C, sym: string, gr: number, count: number, end: number): Promise<Candle[]> {
  const candles: Candle[] = []; let cursor = end;
  while (candles.length < count) { const want = Math.min(5000, count - candles.length);
    const r = await c.send({ ticks_history: sym, adjust_start_time: 1, count: want, end: cursor, style: "candles", granularity: gr });
    const raw = (r.candles ?? []) as any[]; if (raw.length === 0) break;
    const ch = raw.map((k) => ({ epoch: k.epoch, open: k.open, high: k.high, low: k.low, close: k.close, volume: 0 } as Candle));
    candles.unshift(...ch); cursor = ch[0].epoch - 1; if (ch.length < want) break;
  }
  return candles.sort((a, b) => a.epoch - b.epoch);
}
function atr(c: Candle[], i: number, period: number): number { if (i < period) return 0; let s = 0; for (let j = i - period + 1; j <= i; j++) { const tr = Math.max(c[j].high - c[j].low, Math.abs(c[j].high - c[j-1].close), Math.abs(c[j].low - c[j-1].close)); s += tr; } return s / period; }
function sim(candles: Candle[], tpFrac: number, from: number, to: number) {
  let trades = 0, wins = 0, net = 0;
  for (let i = ATR_PERIOD + 2; i < candles.length; i++) {
    if (candles[i].epoch < from || candles[i].epoch >= to) continue;
    const a = atr(candles, i - 1, ATR_PERIOD); if (a <= 0) continue;
    const spike = candles[i - 1]; const range = spike.high - spike.low;
    if (range < SPIKE_NATR * a) continue;
    const confirm = candles[i];
    if (!(spike.close > spike.open)) continue;
    if (!(confirm.close < spike.close)) continue;
    if (i + 1 >= candles.length) continue;
    const finBar = candles[i + 1]; const finalE = confirm.close - confirm.close * ENTRY_SPREAD_FRAC;
    const stop = spike.high + BUFFER_ATR * a; const target = confirm.close - tpFrac * range;
    if (target <= 0 || stop <= confirm.close) continue;
    const delta = finalE - confirm.close; const stopAdj = stop + delta; const targetAdj = target + delta;
    let exit: "TP" | "SL" | null = null; let exitPrice = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const b = candles[j];
      if (b.high >= stopAdj) { exit = "SL"; exitPrice = stopAdj + stopAdj * SL_SLIPPAGE_FRAC; break; }
      if (b.low <= targetAdj) { exit = "TP"; exitPrice = targetAdj; break; }
    }
    if (!exit) continue;
    const move = (finalE - exitPrice) / finalE; let pnl = STAKE * MULT * move - STAKE * COMMISSION_FRAC;
    if (pnl < -STAKE) pnl = -STAKE;
    if (exit === "TP") wins++; trades++; net += pnl;
  }
  return { trades, wins, net, wr: trades > 0 ? wins / trades : 0 };
}

async function main() {
  console.log(`BOOM 300N — per-month TP comparison (buf=0.05, spike=3.0)\n`);
  const c = new C(); await c.ready;
  const candles = await fetchPaged(c, SYM, GR, Math.ceil((TODAY - JAN_1_2025) / GR) + 200, TODAY);
  c.close();
  // Find earliest month with data
  const firstEpoch = candles.find((b) => b.epoch >= JAN_1_2025)?.epoch ?? JAN_1_2025;
  const firstD = new Date(firstEpoch * 1000);
  const startYear = firstD.getUTCFullYear(); const startMonth = firstD.getUTCMonth();
  console.log(`Data starts: ${firstD.toISOString().slice(0, 10)}\n`);

  const TPS = [0.5, 0.7, 1.0, 1.5];
  console.log(`  month        TP=0.5             TP=0.7             TP=1.0             TP=1.5`);
  console.log(`               trades WR  net    trades WR  net    trades WR  net    trades WR  net`);
  // Iterate months
  let y = startYear, m = startMonth;
  const totals: Record<string, { trades: number; wins: number; net: number }> = {};
  for (const tp of TPS) totals[`${tp}`] = { trades: 0, wins: 0, net: 0 };
  while (true) {
    const start = Math.floor(Date.UTC(y, m, 1) / 1000);
    const nextM = m === 11 ? 0 : m + 1; const nextY = m === 11 ? y + 1 : y;
    const end = Math.floor(Date.UTC(nextY, nextM, 1) / 1000);
    if (start >= TODAY) break;
    const monthLabel = `${y}-${String(m + 1).padStart(2, "0")}`;
    const cells: string[] = [];
    for (const tp of TPS) {
      const r = sim(candles, tp, start, Math.min(end, TODAY));
      totals[`${tp}`].trades += r.trades;
      totals[`${tp}`].wins += r.wins;
      totals[`${tp}`].net += r.net;
      const cell = `${String(r.trades).padStart(4)}t ${(r.wr*100).toFixed(0).padStart(2)}% ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(0).padStart(4)}`;
      cells.push(cell);
    }
    console.log(`  ${monthLabel}      ${cells.join("    ")}`);
    if (m === 11) { y++; m = 0; } else m++;
  }
  console.log(`  ──────────`);
  const totalCells = TPS.map((tp) => {
    const t = totals[`${tp}`];
    const wr = t.trades > 0 ? t.wins / t.trades : 0;
    return `${String(t.trades).padStart(4)}t ${(wr*100).toFixed(0).padStart(2)}% ${t.net >= 0 ? "+" : ""}$${t.net.toFixed(0).padStart(4)}`;
  });
  console.log(`  TOTAL        ${totalCells.join("    ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });

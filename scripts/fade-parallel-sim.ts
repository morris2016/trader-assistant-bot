// Parallel-trade-aware Fade simulation.
//
// The old simulation (fade-bug-vs-fix.ts) processes trades sequentially:
// trade A's outcome advances the ladder BEFORE trade B opens, even if A and B
// were truly concurrent in time. That biases the result.
//
// This script models the bot's true execution semantics:
//   1. Find every signal in the candle data (one per qualifying bar)
//   2. For each signal, pre-simulate the trade's exit (open_epoch, close_epoch,
//      pnl_at_flat_stake) independently from other trades
//   3. Walk forward in TIME, processing events in epoch order:
//        OPEN event: stake set from ladder level AT OPEN TIME (computed from
//                    closed trades only — open trades haven't settled yet)
//        CLOSE event: apply pnl, advance ladder, return stake to balance
//   4. Track concurrent open-trade count, balance per-event, skipped signals,
//      and a parallel-vs-sequential delta so we know how much the simplified
//      sim was over/under-stating.
//
// Output is a per-day breakdown so the operator can compare the bot's live
// signal-and-execution log against what the strategy SHOULD be doing.
//
// Usage:
//   DERIV_TOKEN=<token> npx ts-node scripts/fade-parallel-sim.ts
//   (uses fade-bug-vs-fix.ts pattern; reads same env vars)

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOL = "BOOM300N";
const GR = 60;
const DAYS = Number(process.env.DAYS ?? 30);
const START_EPOCH = process.env.START_EPOCH ? Number(process.env.START_EPOCH) : null;
const END_EPOCH = process.env.END_EPOCH ? Number(process.env.END_EPOCH) : null;
const STAKE = Number(process.env.STAKE ?? 1);
const MULT = 100;
const COMMISSION_PCT = 0.03;
const SL_TP_FLOOR_USD = 0.10;
const ATR_PERIOD = 14;
const MAX_HOLD_BARS = 60;

const BALANCE = Number(process.env.BALANCE ?? 15);
const MART_MULT = Number(process.env.MART_MULT ?? 2.2);
const MART_MAX_LEVELS = Number(process.env.MART_LEVELS ?? 5);
const DERIV_MIN_STAKE = 1.0;
// Production live-bot gate: skip signal if any trade is still open for this
// strategy. Set ALLOW_PARALLEL=1 to remove the gate (matches the original
// sim assumption). Default = 0 = match production behaviour.
const ALLOW_PARALLEL = Number(process.env.ALLOW_PARALLEL ?? 0) === 1;

const CONSEC = 1;
const B_ATR_SL_MULT = Number(process.env.SL_MULT ?? 0.3);
const B_ATR_TP_MULT = Number(process.env.TP_MULT ?? 3.0);
const TRAIL_ARM_PCT = Number(process.env.TRAIL_ARM_PCT ?? 0.95);
const TRAIL_RETRACE_PCT = Number(process.env.TRAIL_RETRACE_PCT ?? 0.20);
const TRAIL_SLIP_BPS = Number(process.env.TRAIL_SLIP_BPS ?? 5);

type Candle = { epoch: number; open: number; high: number; low: number; close: number };
type ExitType = "SL" | "TP" | "TIME" | "TRAIL";
type Signal = {
  openEpoch: number;
  closeEpoch: number;
  entry: number;
  exitPrice: number;
  exitType: ExitType;
  pnlAtFlatStake: number;
  rMult: number;
};

class C {
  ws: any;
  reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(WS_URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve } = this.pending.get(id)!;
          this.pending.delete(id);
          resolve(m);
        }
      } catch {}
    });
  }
  send(req: any) {
    return new Promise<any>((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout")); } }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function fetchCandles(c: C, days: number): Promise<Candle[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - days * 86400;
  const result: Candle[] = [];
  let cursor = end;
  let pageNum = 0;
  while (cursor > start) {
    pageNum++;
    const r = await c.send({
      ticks_history: SYMBOL, granularity: GR, style: "candles",
      end: String(cursor), start: 1, count: 5000, adjust_start_time: 1,
    });
    const candles = r.candles ?? [];
    if (!candles.length) break;
    for (const cd of candles) {
      result.push({
        epoch: cd.epoch, open: +cd.open, high: +cd.high, low: +cd.low, close: +cd.close,
      });
    }
    const oldest = candles[0].epoch;
    if (oldest <= start || oldest >= cursor) break;
    cursor = oldest - 1;
    if (pageNum % 5 === 0) console.log(`  page ${pageNum}: ${result.length} candles fetched, cursor at ${new Date(cursor * 1000).toISOString()}`);
  }
  result.sort((a, b) => a.epoch - b.epoch);
  const filtered = START_EPOCH != null && END_EPOCH != null
    ? result.filter((c) => c.epoch >= START_EPOCH && c.epoch <= END_EPOCH)
    : result;
  console.log(`  total candles: ${filtered.length} (${new Date(filtered[0]?.epoch * 1000).toISOString()} -> ${new Date(filtered[filtered.length - 1]?.epoch * 1000).toISOString()})`);
  return filtered;
}

function computeATR(candles: Candle[], period: number): (number | null)[] {
  const atr: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return atr;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close),
    );
    trs.push(tr);
  }
  let val = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atr[period] = val;
  for (let i = period + 1; i < candles.length; i++) {
    val = (val * (period - 1) + trs[i - 1]) / period;
    atr[i] = val;
  }
  return atr;
}

function priceDistToPnl(dist: number, entry: number): number {
  return STAKE * MULT * (dist / entry);
}
function pnlToPriceDist(pnl: number, entry: number): number {
  return (pnl / (STAKE * MULT)) * entry;
}

function simulateOne(candles: Candle[], signalIdx: number, atrVal: number): Signal | null {
  const entry = candles[signalIdx].close;
  let slDist = B_ATR_SL_MULT * atrVal;
  let tpDist = B_ATR_TP_MULT * atrVal;
  let slPnl = priceDistToPnl(slDist, entry);
  let tpPnl = priceDistToPnl(tpDist, entry);
  if (slPnl < SL_TP_FLOOR_USD) { slPnl = SL_TP_FLOOR_USD; slDist = pnlToPriceDist(slPnl, entry); }
  if (tpPnl < SL_TP_FLOOR_USD) { tpPnl = SL_TP_FLOOR_USD; tpDist = pnlToPriceDist(tpPnl, entry); }
  const slPrice = entry + slDist;
  const armThreshold = tpPnl * TRAIL_ARM_PCT;
  const lastIdx = Math.min(signalIdx + MAX_HOLD_BARS, candles.length - 1);
  let exitIdx = -1, exitPrice = 0;
  let exitType: ExitType = "TIME";
  let peakProfit = 0;
  let armed = false;
  for (let j = signalIdx + 1; j <= lastIdx; j++) {
    const bar = candles[j];
    const profAtLow = STAKE * MULT * ((entry - bar.low) / entry);
    if (profAtLow > peakProfit) peakProfit = profAtLow;
    if (!armed && peakProfit >= armThreshold) armed = true;
    if (bar.high >= slPrice) { exitIdx = j; exitPrice = slPrice; exitType = "SL"; break; }
    if (armed) {
      const exitProfit = peakProfit * (1 - TRAIL_RETRACE_PCT);
      const trailExitPrice = entry - (exitProfit / (STAKE * MULT)) * entry;
      if (bar.high >= trailExitPrice) {
        exitPrice = trailExitPrice * (1 + TRAIL_SLIP_BPS / 10000);
        exitIdx = j;
        exitType = "TRAIL";
        break;
      }
    }
  }
  if (exitIdx === -1) { exitIdx = lastIdx; exitPrice = candles[lastIdx].close; exitType = "TIME"; }
  const moveFrac = (entry - exitPrice) / entry;
  const grossPnl = Math.max(-STAKE, STAKE * MULT * moveFrac);
  const pnl = +(grossPnl - STAKE * COMMISSION_PCT).toFixed(4);
  const rMult = slDist > 0 ? +((entry - exitPrice) / slDist).toFixed(3) : 0;
  return {
    openEpoch: candles[signalIdx].epoch,
    closeEpoch: candles[exitIdx].epoch,
    entry, exitPrice, exitType, pnlAtFlatStake: pnl, rMult,
  };
}

function findAllSignals(candles: Candle[], atr: (number | null)[]): Signal[] {
  const signals: Signal[] = [];
  let upStreak = 0;
  for (let i = 1; i < candles.length - 1; i++) {
    const cc = Math.sign(candles[i].close - candles[i - 1].close);
    if (cc === 1) upStreak++; else upStreak = 0;
    const a = atr[i];
    if (upStreak < CONSEC || a == null) continue;
    const s = simulateOne(candles, i, a);
    if (s) signals.push(s);
    upStreak = 0;
  }
  return signals;
}

type EventType = "OPEN" | "CLOSE";
type SimEvent = { epoch: number; type: EventType; sigIdx: number };

interface OpenTrade {
  sigIdx: number;
  signal: Signal;
  level: number;
  stake: number;
  expectedClosePnl: number;
}

function runParallelSim(signals: Signal[], startBalance: number) {
  const events: SimEvent[] = [];
  for (let i = 0; i < signals.length; i++) {
    events.push({ epoch: signals[i].openEpoch, type: "OPEN", sigIdx: i });
    events.push({ epoch: signals[i].closeEpoch, type: "CLOSE", sigIdx: i });
  }
  // OPEN before CLOSE at the same epoch: lets a signal arrive on the close-bar
  // get queued before processing the close (more realistic for fast back-to-back).
  events.sort((a, b) => a.epoch - b.epoch || (a.type === "OPEN" ? -1 : 1));

  let balance = startBalance;
  let level = 0;
  const open = new Map<number, OpenTrade>();
  let totalSignals = signals.length;
  let executed = 0;
  let skippedNoBalance = 0;
  let skippedAlreadyOpen = 0;
  let clampedStake = 0;
  let wins = 0, losses = 0;
  let peak = startBalance, maxDD = 0;
  let minBalance = startBalance;
  let maxConcurrent = 0;
  let busted = false;
  let firstBustEpoch: number | null = null;
  // Bucket per-day to compare to live bot's daily trade count
  const perDay = new Map<string, { signals: number; executed: number; skipped: number; skippedAlreadyOpen: number; pnl: number; wins: number; losses: number; maxConcurrentInDay: number }>();

  // Track parallelism over time: sum (open_count × event_duration) / total_duration
  let parallelismTimeAccum = 0;
  let lastEventEpoch = events[0]?.epoch ?? 0;
  const totalDuration = (events[events.length - 1]?.epoch ?? 0) - (events[0]?.epoch ?? 0);

  function dayKey(epoch: number): string {
    return new Date(epoch * 1000).toISOString().slice(0, 10);
  }
  function bumpDay(epoch: number, field: string, delta = 1) {
    const k = dayKey(epoch);
    if (!perDay.has(k)) perDay.set(k, { signals: 0, executed: 0, skipped: 0, skippedAlreadyOpen: 0, pnl: 0, wins: 0, losses: 0, maxConcurrentInDay: 0 });
    (perDay.get(k)! as any)[field] += delta;
  }

  for (const ev of events) {
    // Accumulate parallelism between previous event and this one
    parallelismTimeAccum += open.size * (ev.epoch - lastEventEpoch);
    lastEventEpoch = ev.epoch;

    if (ev.type === "OPEN") {
      const sig = signals[ev.sigIdx];
      bumpDay(ev.epoch, "signals");
      // Production behaviour: skip signal if any trade is currently open
      // for this strategy. ALLOW_PARALLEL=1 removes the gate.
      if (!ALLOW_PARALLEL && open.size > 0) {
        skippedAlreadyOpen++;
        bumpDay(ev.epoch, "skippedAlreadyOpen");
        continue;
      }
      if (balance < DERIV_MIN_STAKE) {
        // Bot would be unable to open ANYTHING — but might recover later from a close
        skippedNoBalance++;
        bumpDay(ev.epoch, "skipped");
        if (!busted) { busted = true; firstBustEpoch = ev.epoch; }
        continue;
      }
      // Ladder-based stake (level set by previously-CLOSED trades only)
      let stake = Math.max(DERIV_MIN_STAKE, +(STAKE * Math.pow(MART_MULT, level)).toFixed(2));
      if (stake > balance) {
        stake = Math.max(DERIV_MIN_STAKE, Math.floor(balance * 100) / 100);
        clampedStake++;
      }
      // Deduct stake at open time (mirrors Deriv: amount paid is the stake)
      balance = +(balance - stake).toFixed(4);
      // Scale the pre-computed pnl from flat-STAKE to this trade's actual stake
      const scaledPnl = +(sig.pnlAtFlatStake * stake / STAKE).toFixed(4);
      open.set(ev.sigIdx, { sigIdx: ev.sigIdx, signal: sig, level, stake, expectedClosePnl: scaledPnl });
      executed++;
      bumpDay(ev.epoch, "executed");
      if (open.size > maxConcurrent) maxConcurrent = open.size;
      const dk = dayKey(ev.epoch);
      const day = perDay.get(dk)!;
      if (open.size > day.maxConcurrentInDay) day.maxConcurrentInDay = open.size;
      if (balance < minBalance) minBalance = balance;
    } else {
      // CLOSE
      const t = open.get(ev.sigIdx);
      if (!t) continue;
      open.delete(ev.sigIdx);
      // Return stake + pnl to balance
      balance = +(balance + t.stake + t.expectedClosePnl).toFixed(4);
      bumpDay(ev.epoch, "pnl", t.expectedClosePnl);
      if (t.expectedClosePnl > 0) {
        wins++;
        level = 0;
        bumpDay(ev.epoch, "wins");
      } else {
        losses++;
        level = Math.min(MART_MAX_LEVELS, level + 1);
        bumpDay(ev.epoch, "losses");
      }
      if (balance > peak) peak = balance;
      const dd = (peak - balance) / peak;
      if (dd > maxDD) maxDD = dd;
      if (balance < minBalance) minBalance = balance;
    }
  }

  return {
    totalSignals,
    executed,
    skippedNoBalance,
    skippedAlreadyOpen,
    clampedStake,
    wins,
    losses,
    finalBalance: balance,
    netPnl: +(balance - startBalance).toFixed(2),
    peak,
    maxDDPct: +(maxDD * 100).toFixed(2),
    minBalance,
    maxConcurrent,
    avgConcurrent: totalDuration > 0 ? +(parallelismTimeAccum / totalDuration).toFixed(3) : 0,
    busted,
    firstBustEpoch,
    perDay,
  };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`\n══ Parallel-Trade-Aware Fade Simulation ══`);
  console.log(`Symbol: ${SYMBOL}, granularity: ${GR}s, days: ${DAYS}`);
  console.log(`Stake: $${STAKE}, MULT: ${MULT}, commission: ${(COMMISSION_PCT * 100).toFixed(1)}%`);
  console.log(`SL/TP geometry: ${B_ATR_SL_MULT}/${B_ATR_TP_MULT} × ATR, floor $${SL_TP_FLOOR_USD}`);
  console.log(`Trailing: armPct ${TRAIL_ARM_PCT}, retracePct ${TRAIL_RETRACE_PCT}, slip ${TRAIL_SLIP_BPS}bps`);
  console.log(`Martingale: mult ${MART_MULT}, max levels ${MART_MAX_LEVELS}, start balance $${BALANCE}\n`);

  console.log(`Fetching ${DAYS}d of candles...`);
  const candles = await fetchCandles(c, DAYS);
  if (candles.length < ATR_PERIOD + 10) {
    console.error(`Not enough candles (${candles.length})`);
    c.close(); process.exit(1);
  }

  const atr = computeATR(candles, ATR_PERIOD);
  console.log(`\nFinding signals...`);
  const signals = findAllSignals(candles, atr);
  console.log(`  ${signals.length} signals found in ${candles.length} candles`);
  console.log(`  ${(signals.length / DAYS).toFixed(1)} signals/day average\n`);

  // Distribution of trade duration in bars (= closeEpoch - openEpoch)/60
  const durations = signals.map((s) => Math.round((s.closeEpoch - s.openEpoch) / 60));
  const avgDur = durations.reduce((a, b) => a + b, 0) / durations.length;
  const maxDur = Math.max(...durations);
  console.log(`Trade duration: avg ${avgDur.toFixed(1)} bars, max ${maxDur} bars`);

  // Run sim
  console.log(`\n── Parallel-aware simulation ──`);
  const r = runParallelSim(signals, BALANCE);
  console.log(`Mode                  : ${ALLOW_PARALLEL ? "PARALLEL (all signals)" : "SINGLE-POSITION (mirrors live bot)"}`);
  console.log(`Signals (raw)         : ${r.totalSignals}`);
  console.log(`Executed              : ${r.executed} (${(r.executed / r.totalSignals * 100).toFixed(1)}%)`);
  console.log(`Skipped (already-open): ${r.skippedAlreadyOpen}`);
  console.log(`Skipped (no balance)  : ${r.skippedNoBalance}`);
  console.log(`Clamped (sub-ladder)  : ${r.clampedStake}`);
  console.log(`Wins / Losses        : ${r.wins} / ${r.losses} (${(r.wins / (r.wins + r.losses) * 100).toFixed(1)}% WR)`);
  console.log(`Net P&L              : $${r.netPnl}`);
  console.log(`Final balance        : $${r.finalBalance}`);
  console.log(`Peak balance         : $${r.peak}`);
  console.log(`Min balance          : $${r.minBalance}`);
  console.log(`Max drawdown         : ${r.maxDDPct}%`);
  console.log(`Max concurrent open  : ${r.maxConcurrent}`);
  console.log(`Avg concurrent open  : ${r.avgConcurrent}`);
  console.log(`Busted?              : ${r.busted ? `YES (first at ${new Date(r.firstBustEpoch! * 1000).toISOString()})` : "no"}`);

  console.log(`\n── Per-day breakdown ──`);
  console.log(`${"day".padEnd(12)} ${"sigs".padStart(5)} ${"exec".padStart(5)} ${"skip".padStart(5)} ${"win".padStart(5)} ${"loss".padStart(5)} ${"pnl".padStart(8)} ${"maxConc".padStart(8)}`);
  const days = Array.from(r.perDay.keys()).sort();
  for (const d of days) {
    const v = r.perDay.get(d)!;
    console.log(`${d.padEnd(12)} ${String(v.signals).padStart(5)} ${String(v.executed).padStart(5)} ${String(v.skipped).padStart(5)} ${String(v.wins).padStart(5)} ${String(v.losses).padStart(5)} ${("$" + v.pnl.toFixed(2)).padStart(8)} ${String(v.maxConcurrentInDay).padStart(8)}`);
  }

  c.close();
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });

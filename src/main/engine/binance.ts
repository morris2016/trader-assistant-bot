// Binance Futures live engine for the crypto SMC strategy.
//
// Lifecycle per asset:
//   1. On startup, REST-fetch last 200 × 1h klines and seed the rolling buffer
//   2. Every 1m, check if a new 1h bar closed. When yes:
//      a. Append new 1h bar to buffer
//      b. Run patterns (OB_BULL, OB_BEAR, BOS_UP) with trained direction
//      c. For each new signal: set leverage(30) + isolated margin, place MARKET order
//   3. While position is open, poll mark price every 5s:
//      a. Update peakFav for each logical trade
//      b. Once peak ≥ entry + 1.0×ATR → ARMED; place STOP_MARKET TP at peak − 0.3×ATR
//      c. As peak advances, cancel old TP + place tighter one (ratchet)
//      d. When position closes (size = 0), log result
//
// One open logical trade per (asset, pattern, side) at a time. New signal on
// same combo while one is open is skipped. State persisted via load/save.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { BinanceClient, type Kline, type OrderResponse, type SymbolFilters } from "../binance/client";
import { evaluateRiskGate, evaluateHfQualityFilter, DEFAULT_RISK_RULES, DEFAULT_HF_QUALITY_FILTER, PER_ASSET_MAX_LEV, type RiskRulesConfig, type HfQualityFilterConfig } from "./risk-rules";

export type BinanceTradeSide = "LONG" | "SHORT";

// SMC 1h patterns: OB_BULL, OB_BEAR, BOS_UP.
// HF 15m patterns: M1..M5 (mined 2026-05-26, 3-window CV-validated). BB_UP_SHORT and
// BB_LOW_LONG are LEGACY — kept in the type union only so persisted state from
// older bot versions still loads. They are NEVER fired by the live engine.
export type BinancePattern = "OB_BULL" | "OB_BEAR" | "BOS_UP" | "BB_UP_SHORT" | "BB_LOW_LONG" | "M1" | "M2" | "M3" | "M4" | "M5";
export const HF_PATTERNS: ReadonlySet<BinancePattern> = new Set(["M1", "M2", "M3", "M4", "M5"]);
export function isHfPattern(p: BinancePattern): boolean { return HF_PATTERNS.has(p); }
export const HF_RULE_IDS = ["M1", "M2", "M3", "M4", "M5"] as const;
export type HfRuleId = (typeof HF_RULE_IDS)[number];

export type BinanceTrade = {
  id: string;
  asset: string;          // e.g., BTCUSDT
  pattern: BinancePattern;
  side: BinanceTradeSide;
  stake: number;          // $ committed (margin)
  leverage: number;       // e.g., 30
  notional: number;       // stake × leverage
  qty: number;            // base-asset quantity
  entryEpoch: number;
  entryPrice: number;
  atrEntry: number;
  peakFav: number;
  armed: boolean;
  tpOrderId: number | null;  // current STOP_MARKET TP order id (null if not armed)
  status: "OPEN" | "CLOSED";
  closeEpoch?: number;
  closePrice?: number;
  /** Net realized P&L in USDT. Initially set from the local estimate
   *  (stake×leverage×pctMove) at close time; overwritten with the exchange's
   *  real net (`realizedPnlExchange − commissionEntry − commissionExit`)
   *  once both fill events arrive via the user-data stream. */
  pnl?: number;
  /** Exchange-reported realized profit from ORDER_TRADE_UPDATE.rp. Sums
   *  every fill on the close order. Zero on entry-only fills. */
  realizedPnlExchange?: number;
  /** Sum of commissions paid on the entry-side fills (USDT, always
   *  positive). Populated from ORDER_TRADE_UPDATE.n on each entry fill. */
  commissionEntry?: number;
  /** Sum of commissions on the close-side fills (USDT, positive). */
  commissionExit?: number;
  /** Current mark price (updated every positionTick poll). UI reads this
   *  to display REAL current Δ% from entry, not peak-from-entry which
   *  only moves favorably. */
  markPrice?: number;
  /** Last time markPrice was refreshed (epoch seconds) — UI uses this
   *  to fade stale values if the polling loop stalls. */
  markUpdatedAt?: number;
  /** Hard stop-loss price computed at openTrade. When defined, positionTick
   *  closes at market once mark crosses it. For HF: derived from slAtr×ATR
   *  when exitMode="fixedRR", or from slPct/leverage when exitMode="trail".
   *  Runs alongside trail-arm — whichever triggers first wins. */
  slPrice?: number;
  /** Hard take-profit price (HF fixedRR mode only). When defined, positionTick
   *  closes at market once mark crosses it. Derived from tpAtr×ATR. */
  tpPrice?: number;
  /** Exit mode at trade open (frozen — doesn't change mid-trade). */
  exitMode?: "trail" | "fixedRR";
};

export type BinanceState = {
  open: BinanceTrade[];
  closed: BinanceTrade[];
  daily: { date: string; profit: number; tradesOpened: number; capHit: boolean };
  /** Anti-martingale win-streak counters per (asset:pattern:side). Persists
   *  across restarts so we don't lose Paroli ladder progress on Railway redeploy. */
  winStreaks?: Record<string, number>;
  /** Paper-mode only: virtual USDT balance. Starts at paperStartBalance,
   *  moves by realized P&L on each close. Persisted alongside trades. */
  paperWallet?: number;
};

export type BinanceEngineEvents = {
  opened: [BinanceTrade];
  closed: [BinanceTrade];
  error: [Error];
  stateChanged: [];
  capHit: [dailyLoss: number, cap: number];
  /** Free-form info events for the Logs UI — warmup, signals, skips, trail armed. */
  info: [message: string, meta?: Record<string, any>];
};

// Strategy parameters (matches our validated sim)
const HORIZON_BARS = 48;
const DISP_ATR_MIN = 1.0;
const OB_RETURN_BARS = 20;
const SWING_LB = 5;
const TRAIL_ARM_ATR = 1.0;
const TRAIL_RETRACE_ATR = 0.3;
const ATR_PERIOD = 14;
const SMA_PERIOD = 50;
const KLINE_HISTORY = 500;  // ~21 days of 1h bars — gives swing-detection + SMA50 + pending OBs from past 3 weeks
const STRUCTURE_OB_MAX_AGE = 50; // bars — pending OB zones older than this get pruned

// ─── HF 15m strategy constants (M1..M5 mined rules) ────────────────────
// Validated 2026-05-26: factor-mining over 47,775 signals × 37 months → 5
// rules survive 3-window CV at TRAIN-locked breakpoints. See scripts/hf-screen
// for the derivation pipeline. Each rule = (factor-quintile combo on 15m
// + 1h trend filter) → SHORT or LONG, with strength-bucketed dynamic stake.
const HF_KLINE_HISTORY = 200;       // 15m bars retained per asset (~50h)
const HF_KLINE_HISTORY_1H = 200;    // 1h bars retained for HTF factors

// TRAIN-derived quintile breakpoints. Computed once on signals fired in the
// TRAIN window (2025-05-26 → 2025-12-31) and frozen. Apply to ALL bars.
//   q0 = value < breaks[0],  q4 = value ≥ breaks[3].
const TRAIN_QUINTILES = {
  z50:  [-1.28493, -0.44737, 0.48367, 1.27882],
  z100: [-1.28510, -0.46865, 0.46281, 1.28837],
  htf1hTrend: [0, 0, 1, 1],          // binary: q2 = below 1h EMA50, q4 = above
  htf4hRet:   [-0.02351, -0.00589, 0.00614, 0.02206],
};

// Per-rule strength quintile breakpoints (also TRAIN-derived).
const STRENGTH_BREAKS: Record<HfRuleId, number[]> = {
  M1: [0.098081, 0.206674, 0.369093, 0.648186],
  M2: [0.023435, 0.050112, 0.088686, 0.147909],
  M3: [0.113817, 0.205593, 0.319585, 0.480758],
  M4: [0.088573, 0.210573, 0.364843, 0.640640],
  M5: [0.209156, 0.360243, 0.544899, 0.888320],
};

// Per-rule stake MULTIPLIERS by strength quintile (q0..q4). undefined = skip.
// Mean-revert-in-trend rules (M1/M3/M4) reward stronger signals; extreme-fade
// rules (M2/M5) get worse at extremes so we cap or skip the top end.
const HF_STAKE_MULTS: Record<HfRuleId, Array<number | undefined>> = {
  M1: [undefined, undefined, 1.0, 1.25, 1.5],
  M2: [1.25, 1.25, 1.25, 1.25, undefined],
  M3: [undefined, undefined, 1.0, 1.25, 1.5],
  M4: [undefined, undefined, 1.0, 1.25, 1.5],
  M5: [1.0, 1.0, undefined, undefined, undefined],
};

function quintile(v: number, breaks: number[]): number {
  let q = 0; for (const t of breaks) if (v >= t) q++; return q;
}
function zscore(closes: number[], n: number, i: number): number | null {
  if (i < n - 1) return null;
  let s = 0; for (let j = i - n + 1; j <= i; j++) s += closes[j];
  const m = s / n;
  let v = 0; for (let j = i - n + 1; j <= i; j++) v += (closes[j] - m) ** 2;
  const sd = Math.sqrt(v / n);
  return sd === 0 ? 0 : (closes[i] - m) / sd;
}
function emaAt(closes: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  const k = 2 / (n + 1);
  let e = closes[i - n + 1];
  for (let j = i - n + 2; j <= i; j++) e = closes[j] * k + e * (1 - k);
  return e;
}
function alignTo1hIndex(bars1h: Kline[], epoch15m: number): number {
  const target = Math.floor(epoch15m / 3600) * 3600;
  let lo = 0, hi = bars1h.length - 1, found = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (bars1h[m].epoch === target) { found = m; break; }
    if (bars1h[m].epoch < target) { found = m; lo = m + 1; } else hi = m - 1;
  }
  return found;
}

/** HF detector v2: evaluates 5 mined rules at the latest 15m bar.
 *  Each rule needs 15m closes (for z50/z100) and the aligned 1h bar
 *  (for htf1hTrend / htf4hRet). When useFilter=true (default), only signals
 *  in the SCHEDULE-defined quintiles fire (with the matching stake mult).
 *  When false, every M1..M5 hit fires at stakeMult=1.0. */
function detectMinedSignals(bars15m: Kline[], bars1h: Kline[], i: number, useFilter = true): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars15m, i);
  if (!isFinite(a) || a <= 0) return out;
  const closes15 = bars15m.map(b => b.close);
  const z50 = zscore(closes15, 50, i);
  const z100 = zscore(closes15, 100, i);
  if (z50 === null || z100 === null) return out;
  const i1h = alignTo1hIndex(bars1h, bars15m[i].epoch);
  if (i1h < 50) return out;
  const closes1h = bars1h.slice(0, i1h + 1).map(b => b.close);
  const ema50_1h = emaAt(closes1h, 50, i1h);
  if (!isFinite(ema50_1h)) return out;
  const htf1hTrend = bars1h[i1h].close > ema50_1h ? 1 : 0;
  const ref1h = bars1h[Math.max(0, i1h - 16)];
  const htf4hRet = (bars1h[i1h].close - ref1h.close) / ref1h.close;

  const refPrice = bars15m[i].close;
  const Q = TRAIN_QUINTILES;

  function emit(rule: HfRuleId, side: BinanceTradeSide, strength: number) {
    if (useFilter) {
      const qstr = quintile(strength, STRENGTH_BREAKS[rule]);
      const mult = HF_STAKE_MULTS[rule][qstr];
      if (mult === undefined) return;
      out.push({ pattern: rule, side, entryPrice: refPrice, atrEntry: a, strength, qstr, stakeMult: mult });
    } else {
      out.push({ pattern: rule, side, entryPrice: refPrice, atrEntry: a, strength, qstr: -1, stakeMult: 1.0 });
    }
  }

  if (quintile(htf1hTrend, Q.htf1hTrend) === 4 && quintile(z100, Q.z100) === 0)
    emit("M1", "LONG", Math.max(0, -1.29 - z100) + Math.max(0, htf4hRet) * 10);
  if (quintile(htf4hRet, Q.htf4hRet) === 0 && quintile(z100, Q.z100) === 2)
    emit("M2", "SHORT", Math.max(0, -0.0235 - htf4hRet) * 10);
  if (quintile(htf4hRet, Q.htf4hRet) === 1 && quintile(z100, Q.z100) === 3)
    emit("M3", "SHORT", Math.max(0, z100 - 0.46) + Math.max(0, -0.0059 - htf4hRet) * 10);
  if (quintile(htf1hTrend, Q.htf1hTrend) === 2 && quintile(z100, Q.z100) === 4)
    emit("M4", "SHORT", Math.max(0, z100 - 1.29));
  if (quintile(htf4hRet, Q.htf4hRet) === 0 && quintile(z50, Q.z50) === 4)
    emit("M5", "SHORT", Math.max(0, z50 - 1.28) + Math.max(0, -0.0235 - htf4hRet) * 10);

  return out;
}

function utcToday(): string { return new Date().toISOString().slice(0, 10); }
function emptyDaily(): BinanceState["daily"] { return { date: utcToday(), profit: 0, tradesOpened: 0, capHit: false }; }

function computeATR(bars: Kline[], i: number): number {
  if (i < ATR_PERIOD) return NaN;
  let sum = 0;
  for (let j = i - ATR_PERIOD + 1; j <= i; j++) {
    const tr = Math.max(bars[j].high - bars[j].low, Math.abs(bars[j].high - bars[j - 1].close), Math.abs(bars[j].low - bars[j - 1].close));
    sum += tr;
  }
  return sum / ATR_PERIOD;
}

function smaSignAt(bars: Kline[], i: number): "UP" | "DOWN" | "FLAT" {
  if (i < SMA_PERIOD + 5) return "FLAT";
  let now = 0, prev = 0;
  for (let j = i - SMA_PERIOD + 1; j <= i; j++) now += bars[j].close;
  for (let j = i - SMA_PERIOD - 4; j <= i - 5; j++) prev += bars[j].close;
  const a = now / SMA_PERIOD, b = prev / SMA_PERIOD;
  if (a > b * 1.0005) return "UP";
  if (a < b * 0.9995) return "DOWN";
  return "FLAT";
}

function decideSide(pattern: string, sign: string): BinanceTradeSide {
  if (pattern === "OB_BULL" || pattern === "BOS_UP") return sign === "DOWN" ? "SHORT" : "LONG";
  if (pattern === "OB_BEAR") return sign === "UP" ? "LONG" : "SHORT";
  return "LONG";
}

// Round value DOWN to nearest multiple of step. e.g. roundStep(1.2345, 0.001) = 1.234
function roundStep(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.floor(value / step) * step;
}
// Round to symbol's quantity precision (number of decimals)
function fmtQty(qty: number, precision: number): string {
  return qty.toFixed(Math.max(0, precision));
}
function fmtPrice(price: number, precision: number): string {
  return price.toFixed(Math.max(0, precision));
}

type Signal = {
  pattern: BinanceTrade["pattern"];
  side: BinanceTradeSide;
  entryPrice: number;
  atrEntry: number;
  /** Mined HF signals only: strength score (raw), strength quintile (0..4),
   *  and stake multiplier per HF_STAKE_MULTS. SMC signals leave these unset. */
  strength?: number;
  qstr?: number;
  stakeMult?: number;
};

/** Cached "active" structure per asset — built during warmup replay, updated
 *  per bar in live mode. Lets the engine fire on OB zones that formed before
 *  startup but haven't been retraced yet. */
type ActiveStructure = {
  /** OB zones that have formed but haven't been retraced (still pending entry).
   *  When current bar's wick enters the zone, fire OB_BULL or OB_BEAR. */
  pendingOBs: Array<{
    bull: boolean;       // true=bullish OB (entry on long retrace), false=bearish
    formedAt: number;    // bar index when the OB displacement happened
    obIdx: number;       // bar index of the OB candle itself
    zoneHigh: number;
    zoneLow: number;
  }>;
  /** Most recent confirmed swing high (for BOS_UP detection). */
  lastSwingHigh: number;
  lastSwingHighAt: number;
  lastSwingLow: number;
  lastSwingLowAt: number;
};

function emptyStructure(): ActiveStructure {
  return { pendingOBs: [], lastSwingHigh: -Infinity, lastSwingHighAt: -1, lastSwingLow: Infinity, lastSwingLowAt: -1 };
}

/** Update structure cache for a single bar transition. Idempotent per bar.
 *  Used by both warmup replay and live forward-walk. */
function updateStructure(structure: ActiveStructure, bars: Kline[], i: number): void {
  // 1) Detect new OB formations: current bar i is a displacement candle
  const a = computeATR(bars, i);
  if (isFinite(a) && a > 0) {
    // Bullish displacement → look back for the bearish OB candle
    if (bars[i].close > bars[i].open && (bars[i].close - bars[i].open) >= DISP_ATR_MIN * a) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].close < bars[j].open) {
          structure.pendingOBs.push({
            bull: true, formedAt: i, obIdx: j,
            zoneHigh: Math.max(bars[j].open, bars[j].close),
            zoneLow: bars[j].low,
          });
          break;
        }
      }
    }
    // Bearish displacement
    if (bars[i].close < bars[i].open && (bars[i].open - bars[i].close) >= DISP_ATR_MIN * a) {
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        if (bars[j].close > bars[j].open) {
          structure.pendingOBs.push({
            bull: false, formedAt: i, obIdx: j,
            zoneHigh: bars[j].high,
            zoneLow: Math.min(bars[j].open, bars[j].close),
          });
          break;
        }
      }
    }
  }

  // 2) Confirm a new swing high/low (looks back SWING_LB on each side of bar j = i - SWING_LB)
  const j = i - SWING_LB;
  if (j >= SWING_LB) {
    let isHigh = true, isLow = true;
    for (let k = j - SWING_LB; k <= j + SWING_LB; k++) {
      if (k === j) continue;
      if (bars[k].high > bars[j].high) isHigh = false;
      if (bars[k].low < bars[j].low) isLow = false;
    }
    if (isHigh && bars[j].high > structure.lastSwingHigh) {
      structure.lastSwingHigh = bars[j].high;
      structure.lastSwingHighAt = j;
    }
    if (isLow && bars[j].low < structure.lastSwingLow) {
      structure.lastSwingLow = bars[j].low;
      structure.lastSwingLowAt = j;
    }
  }

  // 3) Prune OBs that are already retraced OR too old
  structure.pendingOBs = structure.pendingOBs.filter((ob) => {
    if (i - ob.formedAt > STRUCTURE_OB_MAX_AGE) return false;
    // Check if any bar BETWEEN obIdx+1 and i has touched the zone
    for (let k = ob.formedAt + 1; k <= i; k++) {
      const touched = ob.bull
        ? (bars[k].low <= ob.zoneHigh && bars[k].low >= ob.zoneLow)
        : (bars[k].high >= ob.zoneLow && bars[k].high <= ob.zoneHigh);
      if (touched) return false; // already fired its signal — gone
    }
    return true;
  });
}

/** Warmup: replay all historical bars to build the structure cache.
 *  Does NOT emit signals (we're past those bars already). */
function buildStructureFromHistory(bars: Kline[]): ActiveStructure {
  const s = emptyStructure();
  // Start from the earliest bar that has both ATR + lookback context
  const startIdx = Math.max(SWING_LB * 2 + 5, ATR_PERIOD + 1);
  for (let i = startIdx; i < bars.length; i++) {
    updateStructure(s, bars, i);
  }
  return s;
}

/** Cache-aware signal detection. Checks current bar against pending OBs from
 *  the structure cache (including ones formed long before the bot started). */
function detectSignalsFromCache(bars: Kline[], i: number, structure: ActiveStructure): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars, i);
  if (!isFinite(a) || a <= 0) return out;
  const sign = smaSignAt(bars, i);

  // OB triggers: any pending zone touched by THIS bar
  for (const ob of structure.pendingOBs) {
    if (ob.formedAt >= i) continue; // can't re-trigger on the formation bar itself
    if (ob.bull) {
      if (bars[i].low <= ob.zoneHigh && bars[i].low >= ob.zoneLow) {
        out.push({ pattern: "OB_BULL", side: decideSide("OB_BULL", sign), entryPrice: ob.zoneHigh, atrEntry: a });
      }
    } else {
      if (bars[i].high >= ob.zoneLow && bars[i].high <= ob.zoneHigh) {
        out.push({ pattern: "OB_BEAR", side: decideSide("OB_BEAR", sign), entryPrice: ob.zoneLow, atrEntry: a });
      }
    }
  }

  // BOS_UP: close > most recent confirmed swing high (from cache, no lookback limit)
  if (isFinite(structure.lastSwingHigh) && bars[i].close > structure.lastSwingHigh && bars[i - 1].close <= structure.lastSwingHigh) {
    out.push({ pattern: "BOS_UP", side: decideSide("BOS_UP", sign), entryPrice: bars[i].close, atrEntry: a });
  }

  return out;
}

function detectSignals(bars: Kline[], i: number): Signal[] {
  const out: Signal[] = [];
  const a = computeATR(bars, i);
  if (!isFinite(a) || a <= 0) return out;
  const sign = smaSignAt(bars, i);

  // OB_BULL / OB_BEAR — first retrace into a recent OB zone
  for (let mvIdx = i - 1; mvIdx >= Math.max(5, i - OB_RETURN_BARS); mvIdx--) {
    const aMv = computeATR(bars, mvIdx);
    if (!isFinite(aMv) || aMv <= 0) continue;
    if (bars[mvIdx].close > bars[mvIdx].open && bars[mvIdx].close - bars[mvIdx].open >= DISP_ATR_MIN * aMv) {
      let obIdx = -1;
      for (let j = mvIdx - 1; j >= Math.max(0, mvIdx - 5); j--) if (bars[j].close < bars[j].open) { obIdx = j; break; }
      if (obIdx < 0) continue;
      const obHigh = Math.max(bars[obIdx].open, bars[obIdx].close);
      const obLow = bars[obIdx].low;
      if (bars[i].low <= obHigh && bars[i].low >= obLow) {
        let alreadyHit = false;
        for (let k = mvIdx + 1; k < i; k++) if (bars[k].low <= obHigh && bars[k].low >= obLow) { alreadyHit = true; break; }
        if (!alreadyHit) out.push({ pattern: "OB_BULL", side: decideSide("OB_BULL", sign), entryPrice: obHigh, atrEntry: a });
        break;
      }
    }
    if (bars[mvIdx].close < bars[mvIdx].open && bars[mvIdx].open - bars[mvIdx].close >= DISP_ATR_MIN * aMv) {
      let obIdx = -1;
      for (let j = mvIdx - 1; j >= Math.max(0, mvIdx - 5); j--) if (bars[j].close > bars[j].open) { obIdx = j; break; }
      if (obIdx < 0) continue;
      const obHigh = bars[obIdx].high;
      const obLow = Math.min(bars[obIdx].open, bars[obIdx].close);
      if (bars[i].high >= obLow && bars[i].high <= obHigh) {
        let alreadyHit = false;
        for (let k = mvIdx + 1; k < i; k++) if (bars[k].high >= obLow && bars[k].high <= obHigh) { alreadyHit = true; break; }
        if (!alreadyHit) out.push({ pattern: "OB_BEAR", side: decideSide("OB_BEAR", sign), entryPrice: obLow, atrEntry: a });
        break;
      }
    }
  }

  // BOS_UP — current bar closes above a confirmed past swing high
  if (i >= SWING_LB * 2 + 5) {
    let lastSwingHigh = -Infinity;
    for (let j = i - 1; j >= SWING_LB; j--) {
      if (j + SWING_LB >= i) continue;
      let isHigh = true;
      for (let k = j - SWING_LB; k <= j + SWING_LB; k++) { if (k === j) continue; if (bars[k].high > bars[j].high) { isHigh = false; break; } }
      if (isHigh) { lastSwingHigh = bars[j].high; break; }
    }
    if (isFinite(lastSwingHigh) && bars[i].close > lastSwingHigh && bars[i - 1].close <= lastSwingHigh) {
      out.push({ pattern: "BOS_UP", side: decideSide("BOS_UP", sign), entryPrice: bars[i].close, atrEntry: a });
    }
  }
  return out;
}

export class BinanceEngine extends EventEmitter {
  private client: BinanceClient;
  private bars: Map<string, Kline[]> = new Map();
  /** Per-asset active-structure cache: pending OB zones + latest swing levels.
   *  Built once during startup replay; updated incrementally on each new bar. */
  private structures: Map<string, ActiveStructure> = new Map();
  private filters: Record<string, SymbolFilters> = {};
  /** Hedge mode = LONG and SHORT positions tracked separately by Binance.
   *  Required for our multi-pattern same-asset overlaps. Set on startup. */
  private hedgeMode = true;
  private open: BinanceTrade[] = [];
  private closed: BinanceTrade[] = [];
  private daily: BinanceState["daily"] = emptyDaily();
  private assets: string[] = [];
  private stake = 15;
  private leverage = 30;
  private dailyMaxLoss = 100;
  private perTradeMaxStake = 30;
  private perAssetEnabled: Record<string, boolean> = {};
  private perPatternEnabled: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean } = { OB_BULL: true, OB_BEAR: true, BOS_UP: true };
  // ── Anti-martingale (Paroli) state ──
  // Tracks consecutive wins per key (asset:pattern:side). Used by openTrade
  // to scale stake = baseStake × multiplier^streak. Resets on loss.
  // Persisted via state() so streaks survive bot restarts.
  private martMode: "off" | "anti" = "off";
  private martMultiplier = 2.0;
  private martMaxLevels = 3;
  private winStreaks: Record<string, number> = {};  // key=asset:pattern:side
  // Independent Paroli ladder for HF (15m BB) — HF win-streaks share the same
  // winStreaks map but key prefixes (BB_*) keep them naturally separate;
  // these knobs control sizing math distinctly from SMC mart above.
  private hfMartMode: "off" | "anti" = "off";
  private hfMartMultiplier = 2.0;
  private hfMartMaxLevels = 3;
  /** Hard SL as % of entry — separate config per stack (0 = disabled). */
  private smcSlPct = 0;
  private hfSlPct = 0;
  /** Per-asset HF leverage override (validated 2026-05-25: each asset's
   *  exchange-max delivers +29% better edge than uniform 75×). Defaults to
   *  PER_ASSET_MAX_LEV from risk-rules. Falls back to hfLeverage when an
   *  asset isn't in the map. */
  private hfPerAssetLeverage: Record<string, number> = { ...PER_ASSET_MAX_LEV };
  /** HF quality filter — rolling-percentile gate on signal bar's bbWidth,
   *  volume, and entry hour. Validated 2026-05-25: filtered subset shows
   *  27/27 months profitable across the 2024-2026 dataset. */
  private hfQualityFilter: HfQualityFilterConfig = { ...DEFAULT_HF_QUALITY_FILTER };
  // ── HF (15m) state — separate from the 1h SMC stack above ──
  private hfEnabled = false;
  private hfStake = 1;
  // Sizing mode: "fixed" uses hfStake as-is. "percent" scales stake to
  // currentEquity × hfStakePct on every signal, so position size grows
  // (and shrinks) with wallet PnL. Sim-validated 2026-05-27: percent-sizing
  // on $100 wallet over 37 months survived ALL drawdowns and compounded to
  // 84× while flat $2 stake busted on the first losing streak.
  private hfStakeMode: "fixed" | "percent" = "fixed";
  private hfStakePct = 0.02;
  // M1..M5 strength filter — true = only fire signals where SCHEDULE multiplier
  // is defined (current shipped). False = fire every M1..M5 signal at uniform
  // stake (37mo sim: unfiltered+fixed-2:1 = 84× winner).
  private hfUseStrengthFilter = true;
  // Exit mode: "trail" = current (trail-arm at +1×ATR + 0.3 retrace + hard SL).
  // "fixedRR" = fixed TP at +hfTpAtr×ATR + SL at −hfSlAtr×ATR, no trail.
  private hfExitMode: "trail" | "fixedRR" = "trail";
  private hfTpAtr = 2.0;
  private hfSlAtr = 1.0;
  private hfLeverage = 30;
  private hfAllowMultiplePerKey = false;
  // M5 default OFF (extreme-fade rules invert at strength extremes — weakest contributor in 37-mo CV).
  private hfPerPatternEnabled: Record<HfRuleId, boolean> = { M1: true, M2: true, M3: true, M4: true, M5: false };
  private hfPerAssetEnabled: Record<string, boolean> = {};
  /** Separate rolling 15m kline buffer — keyed by asset. Populated lazily on
   *  first HF tick after enabling, so disabling HF doesn't waste bandwidth. */
  private bars15m: Map<string, Kline[]> = new Map();
  private hfSignalLoopTimer: NodeJS.Timeout | null = null;
  private hfTickCount = 0;
  // ── End HF state ──
  private running = false;
  private signalLoopTimer: NodeJS.Timeout | null = null;
  private positionLoopTimer: NodeJS.Timeout | null = null;
  private incomeReconcileTimer: NodeJS.Timeout | null = null;
  // Pending API actions per trade, to prevent racing duplicate orders
  private busy: Set<string> = new Set();
  // Heartbeat: cycle counter + per-tick signal counter (set inside checkSignalsFor)
  private tickCount = 0;
  private signalsThisTick = 0;

  /** Paper mode: when true, the engine runs the FULL signal-detection and
   *  trade-lifecycle pipeline but skips every authenticated exchange call.
   *  Orders are simulated against the current mark price; positions and
   *  fees are tracked in-memory; `paperWallet` moves by realized P&L on
   *  each close.
   *
   *  CRITICAL: paper mode also skips its own kline/mark-price polling — it
   *  reads from an attached live engine's `bars` buffers and `markCache`
   *  instead. Without this, running paper alongside live DOUBLES the per-IP
   *  API request rate and triggers Binance HTTP 418 IP bans. */
  private paperMode = false;
  private paperWallet = 0;
  /** Paper-mode round-trip cost applied to each simulated trade close:
   *  taker fees + slippage. Defaults to 0.04%×2 + 1.8bps×2 = 0.0836%. */
  private paperCostRoundTrip = 0.000836;

  /** Cross-engine data sharing (live ↔ paper).
   *  - `dataSource` (set on paper): the live engine to read bars/marks from
   *  - `dataConsumer` (set on live): the paper engine whose open positions
   *    should also have their mark prices fetched and cached.
   *  Live caches every fetched mark price in `markCache` so paper can read
   *  it without making its own API call. */
  private dataSource: BinanceEngine | null = null;
  private dataConsumer: BinanceEngine | null = null;
  private markCache = new Map<string, { price: number; ts: number }>();

  // ── Risk rules (Elder / Williams / Vantage / Kaufman) ──
  // All gates OFF by default in live config; paper opts in via PAPER_DEFAULT_RISK_RULES.
  private riskRules: RiskRulesConfig = { ...DEFAULT_RISK_RULES };
  /** Tracks YYYY-MM, equity at start of that month, and realized P&L since.
   *  Rolls when a new month begins (UTC). Used by the 6% monthly circuit. */
  private monthly: { month: string; startEquity: number; realizedPnl: number } = {
    month: new Date().toISOString().slice(0, 7),
    startEquity: 0,
    realizedPnl: 0,
  };
  private rollMonthIfNeeded() {
    const m = new Date().toISOString().slice(0, 7);
    if (this.monthly.month !== m) {
      this.monthly = { month: m, startEquity: this.paperMode ? this.paperWallet : this.cachedEquity, realizedPnl: 0 };
      this.emit("info", `monthly roll: new month=${m} startEquity=$${this.monthly.startEquity.toFixed(2)}`, {
        month: m, startEquity: this.monthly.startEquity,
      });
    }
  }

  /** Current account equity in USDT — used by the per-trade risk gate.
   *  For paper: paperWallet (real-time). For live: cached wallet balance
   *  updated by refreshLiveEquity() on engine start + on each close (+= pnl).
   *  Avoids hitting /fapi/v2/balance on every signal. */
  private cachedEquity = 0;
  private async refreshLiveEquity() {
    if (this.paperMode) return;
    try {
      const bals = await this.client.getBalances();
      const usdt = bals.find((b) => b.asset === "USDT");
      if (usdt) {
        this.cachedEquity = +usdt.balance;
        this.emit("info", `equity refreshed: $${this.cachedEquity.toFixed(2)}`, { equity: this.cachedEquity });
      }
    } catch (e) { /* silent — fall back to incremental updates */ }
  }
  getCurrentEquity(): number { return this.paperMode ? this.paperWallet : this.cachedEquity; }
  attachDataSource(source: BinanceEngine) { this.dataSource = source; }
  attachDataConsumer(consumer: BinanceEngine) { this.dataConsumer = consumer; }
  /** Read accessor: latest cached mark price for a symbol, or null if not
   *  cached or stale (>30s old). Used by paper to avoid its own fetch. */
  getCachedMarkPrice(sym: string): number | null {
    const c = this.markCache.get(sym);
    if (!c) return null;
    if (Date.now() - c.ts > 30_000) return null;
    return c.price;
  }
  /** Read accessor: shared bar buffers — paper reads these instead of
   *  calling client.getKlines(). Returned by reference; do not mutate. */
  getBarsRef(sym: string): Kline[] | undefined { return this.bars.get(sym); }
  getBars15mRef(sym: string): Kline[] | undefined { return this.bars15m.get(sym); }

  constructor(client: BinanceClient, opts?: { paperMode?: boolean; paperStartBalance?: number }) {
    super();
    this.client = client;
    this.paperMode = !!opts?.paperMode;
    this.paperWallet = opts?.paperStartBalance ?? 0;
  }

  isPaperMode(): boolean { return this.paperMode; }
  getPaperWallet(): number { return this.paperWallet; }

  load(state: Partial<BinanceState>) {
    this.open = state.open ?? [];
    this.closed = state.closed ?? [];
    this.daily = state.daily ?? emptyDaily();
    this.winStreaks = state.winStreaks ?? {};
    if (this.paperMode && typeof state.paperWallet === "number") this.paperWallet = state.paperWallet;
    this.rollDayIfNeeded();
  }

  state(): BinanceState {
    const out: BinanceState = { open: this.open, closed: this.closed, daily: this.daily, winStreaks: this.winStreaks };
    if (this.paperMode) out.paperWallet = this.paperWallet;
    return out;
  }

  /** Returns wallet-truth daily P&L: REALIZED from Binance income (since
   *  midnight, in EAT) MINUS commissions, plus UNREALIZED from currently-
   *  open positions. This is the true number to display in the UI, vs the
   *  bot's local `daily.profit` which misses external cancellations and
   *  doesn't include unrealized. */
  async getWalletTruthPnl(): Promise<{ realized: number; commission: number; unrealized: number; wallet: number; events: number; sinceMs: number }> {
    // EAT midnight = UTC midnight - 3h
    const now = new Date();
    const eatMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), -3, 0, 0));
    // If we're in the EAT day after UTC midnight, the EAT-day-start is in UTC time
    // "yesterday 21:00 UTC". Use it directly.
    const sinceMs = eatMidnight.getTime();
    const income = await this.client.getRealizedIncomeSince(sinceMs);
    const positions = await this.client.getPositions();
    const unrealized = positions.reduce((s, p) => s + (Math.abs(+p.positionAmt) > 0 ? +p.unRealizedProfit : 0), 0);
    const balances = await this.client.getBalances();
    const usdt = balances.find((b) => b.asset === "USDT");
    return {
      realized: income.realizedPnl,
      commission: income.commission,
      unrealized,
      wallet: usdt ? usdt.balance : 0,
      events: income.events,
      sinceMs,
    };
  }

  /** Returns the list of Binance positions that the bot does NOT track in
   *  its local open[] — i.e., positions opened directly on Binance (manual
   *  trades) or zombies left behind by older bot versions. Used by the
   *  External tab in the UI. */
  async externalPositions(): Promise<Array<{
    symbol: string; positionSide: BinanceTradeSide;
    qty: number; entryPrice: number; markPrice: number;
    unRealizedProfit: number; leverage: number;
    liquidationPrice: number; updateTime: number;
    botQty: number; externalQty: number;
  }>> {
    const positions = await this.client.getPositions();
    const out: Array<any> = [];
    for (const p of positions) {
      const qty = Math.abs(+p.positionAmt);
      if (qty < 1e-9) continue;
      const side: BinanceTradeSide = p.positionSide === "SHORT" ? "SHORT" :
                                      p.positionSide === "LONG"  ? "LONG"  :
                                      (+p.positionAmt >= 0 ? "LONG" : "SHORT");
      // How much of this Binance position does the bot account for?
      const botQty = this.open
        .filter((t) => t.asset === p.symbol && t.side === side)
        .reduce((s, t) => s + t.qty, 0);
      const externalQty = Math.max(0, qty - botQty);
      // Only surface positions with material un-tracked qty (>1% of total).
      if (externalQty / Math.max(qty, 1e-9) < 0.01) continue;
      out.push({
        symbol: p.symbol, positionSide: side,
        qty, entryPrice: p.entryPrice, markPrice: p.markPrice,
        unRealizedProfit: p.unRealizedProfit, leverage: p.leverage,
        liquidationPrice: p.liquidationPrice, updateTime: p.updateTime,
        botQty, externalQty,
      });
    }
    return out;
  }

  /** Close a Binance position directly by symbol + side, regardless of
   *  whether the bot tracks it. Used by the External tab's Cancel button —
   *  reduce-only MARKET that drains the un-tracked quantity. */
  async closeExternal(symbol: string, side: BinanceTradeSide, qty: number): Promise<{ ok: boolean; error?: string }> {
    if (this.paperMode) return { ok: false, error: "External-position close is a live-only action" };
    const lockKey = `external-close:${symbol}:${side}`;
    if (this.busy.has(lockKey)) return { ok: false, error: "Close already in progress" };
    this.busy.add(lockKey);
    try {
      const f = this.filters[symbol];
      const stepSize = f?.stepSize ?? 0.001;
      const qP = f?.quantityPrecision ?? 3;
      // Round qty DOWN to nearest stepSize, then format to required precision
      const safeQty = Math.floor(qty / stepSize) * stepSize;
      if (safeQty <= 0) return { ok: false, error: `qty ${qty} rounds to 0 at stepSize ${stepSize}` };
      const closeSide = side === "LONG" ? "SELL" : "BUY";
      const positionSide = this.hedgeMode ? side : "BOTH";
      this.emit("info", `external cancel ${symbol} ${side} qty=${safeQty} (user-requested via External tab)`, {
        asset: symbol, side, qty: safeQty,
      });
      await this.client.placeMarketOrder({
        symbol, side: closeSide as any,
        quantity: Number(fmtQty(safeQty, qP)),
        positionSide: positionSide as any,
        clientOrderId: `ext-${Date.now()}`,
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.busy.delete(lockKey);
    }
  }

  /** Force-close a single open trade at market. Used by the UI Cancel button.
   *  Places a MARKET reduce-only order; the closeTradeFromFill path is invoked
   *  via the user-data stream when Binance acks the fill, so P&L is captured
   *  at the actual exit price. */
  async cancelTrade(tradeId: string): Promise<{ ok: boolean; error?: string }> {
    const t = this.open.find((x) => x.id === tradeId);
    if (!t) return { ok: false, error: `Trade ${tradeId} not open` };
    const lockKey = `close:${t.id}`;
    if (this.busy.has(lockKey)) return { ok: false, error: "Cancel already in progress" };
    this.busy.add(lockKey);
    try {
      const f = this.filters[t.asset];
      const closeSide = t.side === "LONG" ? "SELL" : "BUY";
      const positionSide = this.hedgeMode ? t.side : "BOTH";
      this.emit("info", `cancel ${t.asset} ${t.pattern}/${t.side} qty=${t.qty} — placing market close${this.paperMode ? " (paper)" : ""}`, {
        asset: t.asset, pattern: t.pattern, side: t.side, qty: t.qty, tradeId: t.id,
      });
      if (!this.paperMode) {
        await this.client.placeMarketOrder({
          symbol: t.asset, side: closeSide as any,
          quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
          positionSide: positionSide as any,
          clientOrderId: `cancel-${t.id.slice(0, 8)}-${Date.now()}`,
        });
      }
      // Best-effort immediate local close at current mark / peak / entry —
      // for paper this IS the final settlement. For live, user-data stream
      // refines the price.
      await this.closeTradeFromFill(t, t.markPrice || t.peakFav || t.entryPrice);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    } finally {
      this.busy.delete(lockKey);
    }
  }

  configure(opts: {
    assets?: string[];
    stake?: number;
    leverage?: number;
    dailyMaxLoss?: number;
    perTradeMaxStake?: number;
    perAssetEnabled?: Record<string, boolean>;
    perPatternEnabled?: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean };
    martingale?: { mode: "off" | "anti"; multiplier: number; maxLevels: number };
    hf?: {
      enabled?: boolean;
      stake?: number;
      stakeMode?: "fixed" | "percent";
      stakePct?: number;
      useStrengthFilter?: boolean;
      exitMode?: "trail" | "fixedRR";
      tpAtr?: number;
      slAtr?: number;
      leverage?: number;
      allowMultiplePerKey?: boolean;
      perPatternEnabled?: Record<HfRuleId, boolean>;
      perAssetEnabled?: Record<string, boolean>;
      martingale?: { mode: "off" | "anti"; multiplier: number; maxLevels: number };
      slPct?: number;
      perAssetLeverage?: Record<string, number>;
      qualityFilter?: HfQualityFilterConfig;
    };
    riskRules?: RiskRulesConfig;
    slPctSmc?: number;
  }) {
    if (opts.assets) this.assets = opts.assets;
    if (opts.stake !== undefined) this.stake = opts.stake;
    if (opts.leverage !== undefined) this.leverage = opts.leverage;
    if (opts.dailyMaxLoss !== undefined) this.dailyMaxLoss = opts.dailyMaxLoss;
    if (opts.perTradeMaxStake !== undefined) this.perTradeMaxStake = opts.perTradeMaxStake;
    if (opts.perAssetEnabled) this.perAssetEnabled = opts.perAssetEnabled;
    if (opts.perPatternEnabled) this.perPatternEnabled = opts.perPatternEnabled;
    if (opts.martingale) {
      this.martMode = opts.martingale.mode;
      this.martMultiplier = opts.martingale.multiplier;
      this.martMaxLevels = opts.martingale.maxLevels;
    }
    if (opts.hf) {
      const wasEnabled = this.hfEnabled;
      if (opts.hf.enabled !== undefined) this.hfEnabled = opts.hf.enabled;
      if (opts.hf.stake !== undefined) this.hfStake = opts.hf.stake;
      if (opts.hf.stakeMode !== undefined) this.hfStakeMode = opts.hf.stakeMode;
      if (opts.hf.stakePct !== undefined) this.hfStakePct = opts.hf.stakePct;
      if (opts.hf.useStrengthFilter !== undefined) this.hfUseStrengthFilter = opts.hf.useStrengthFilter;
      if (opts.hf.exitMode !== undefined) this.hfExitMode = opts.hf.exitMode;
      if (opts.hf.tpAtr !== undefined) this.hfTpAtr = opts.hf.tpAtr;
      if (opts.hf.slAtr !== undefined) this.hfSlAtr = opts.hf.slAtr;
      if (opts.hf.leverage !== undefined) this.hfLeverage = opts.hf.leverage;
      if (opts.hf.allowMultiplePerKey !== undefined) this.hfAllowMultiplePerKey = opts.hf.allowMultiplePerKey;
      if (opts.hf.perPatternEnabled) this.hfPerPatternEnabled = opts.hf.perPatternEnabled;
      if (opts.hf.perAssetEnabled) this.hfPerAssetEnabled = opts.hf.perAssetEnabled;
      if (opts.hf.martingale) {
        this.hfMartMode = opts.hf.martingale.mode;
        this.hfMartMultiplier = opts.hf.martingale.multiplier;
        this.hfMartMaxLevels = opts.hf.martingale.maxLevels;
      }
      if (opts.hf.slPct !== undefined) this.hfSlPct = opts.hf.slPct;
      if (opts.hf.perAssetLeverage) this.hfPerAssetLeverage = opts.hf.perAssetLeverage;
      if (opts.hf.qualityFilter) this.hfQualityFilter = opts.hf.qualityFilter;
      // Immediate proof-of-life log when operator flips HF on/off at runtime.
      if (!wasEnabled && this.hfEnabled) {
        const stakeDesc = this.hfStakeMode === "percent"
          ? `${(this.hfStakePct * 100).toFixed(1)}% of wallet`
          : `$${this.hfStake}`;
        const enabledRules = Object.entries(this.hfPerPatternEnabled).filter(([, on]) => on).map(([r]) => r).join(",");
        this.emit("info", `HF stack ENABLED at runtime: M1..M5 mined rules (${enabledRules}) · stake ${stakeDesc} × ${this.hfLeverage}× · exitMode=${this.hfExitMode} · tp=${this.hfTpAtr}×ATR sl=${this.hfSlAtr}×ATR · filter=${this.hfUseStrengthFilter ? "ON" : "OFF"}`, {
          stake: this.hfStake, stakeMode: this.hfStakeMode, stakePct: this.hfStakePct,
          leverage: this.hfLeverage, allowMultiplePerKey: this.hfAllowMultiplePerKey,
          exitMode: this.hfExitMode, tpAtr: this.hfTpAtr, slAtr: this.hfSlAtr,
          useStrengthFilter: this.hfUseStrengthFilter, enabledRules,
        });
        // Don't wait for the next 30s tick — kick a warmup pass right now so
        // the Logs panel shows activity within a second of the Save click.
        if (this.running) {
          this.hfSignalTick().catch((e) => this.emit("error", e as Error));
        }
      } else if (wasEnabled && !this.hfEnabled) {
        this.emit("info", `HF stack DISABLED at runtime`, {});
      }
    }
    if (opts.riskRules) this.riskRules = opts.riskRules;
    if (opts.slPctSmc !== undefined) this.smcSlPct = opts.slPctSmc;
  }

  private rollDayIfNeeded() {
    const today = utcToday();
    if (this.daily.date !== today) this.daily = emptyDaily();
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.tickCount = 0;
    this.emit("info", `engine starting: ${this.assets.length} assets, stake $${this.stake}, lev ${this.leverage}x`, {
      assets: this.assets.length, stake: this.stake, leverage: this.leverage,
    });
    try { await this.client.syncTime(); } catch (e) { this.emit("error", e as Error); }

    // Fetch exchangeInfo once — gives us per-symbol qty/price precision rules.
    try {
      this.filters = await this.client.getExchangeInfo();
    } catch (e) {
      this.emit("error", new Error(`Failed to fetch exchangeInfo: ${(e as Error).message}`));
    }

    // Set hedge mode (allows separate LONG + SHORT positions per symbol).
    // -4059 = "No need to change position side" — already in hedge mode, safe to ignore.
    if (!this.paperMode) {
      try {
        await this.client["signedRequest"]?.("POST", "/fapi/v1/positionSide/dual", { dualSidePosition: "true" });
      } catch (e: any) {
        if (!/4059/.test(String(e?.message ?? ""))) this.emit("error", e as Error);
      }
    }

    // Subscribe to user-data stream for real-time order fills + position updates.
    // Paper mode skips this — no real fills to listen for; simulation drives state.
    if (!this.paperMode) {
      try {
        await this.client.startUserDataStream();
        this.client.on("userEvent", (ev) => this.onUserEvent(ev));
      } catch (e) {
        this.emit("error", new Error(`Failed to start user-data stream: ${(e as Error).message}`));
      }
    }

    // Seed klines for each asset + replay structure cache so bot recognises
    // pending OB zones that formed before startup.
    // Paper mode with dataSource attached: copy from live's already-loaded
    // buffers — saves 15 × KLINE_HISTORY-pagination kline requests on boot
    // and is exactly what we'd otherwise fetch from Binance anyway.
    for (const sym of this.assets) {
      try {
        let k: Kline[];
        if (this.dataSource) {
          const srcBuf = this.dataSource.getBarsRef(sym);
          if (!srcBuf || srcBuf.length === 0) {
            this.emit("info", `warmup ${sym}: upstream not ready yet, will catch up via signalTick`, { asset: sym });
            continue;
          }
          k = [...srcBuf];
        } else {
          k = await this.client.getKlines(sym, "1h", KLINE_HISTORY);
        }
        this.bars.set(sym, k);
        const struct = buildStructureFromHistory(k);
        this.structures.set(sym, struct);
        // Logging warmup outcome helps verify the cache populated properly
        const pending = struct.pendingOBs.length;
        this.emit("info", `warmup ${sym}: ${k.length} bars, ${pending} pending OBs`, {
          asset: sym, bars: k.length, pendingOBs: pending,
          swingHigh: isFinite(struct.lastSwingHigh) ? +struct.lastSwingHigh.toFixed(4) : null,
          swingLow: isFinite(struct.lastSwingLow) ? +struct.lastSwingLow.toFixed(4) : null,
        });
        if (!this.paperMode) {
          await this.client.setMarginType(sym, "ISOLATED").catch(() => undefined);
          // Per-asset max leverage. Binance USDT-M Futures rejects values
          // above each symbol's tier-0 cap (BTC/ETH=125×, alts=75×, low-caps=50×).
          // Using uniform this.leverage=100 caused boot-time -4028 rejections
          // for every alt with max<100. Prefer the user's per-asset override
          // (hf.perAssetLeverage), then clamp to PER_ASSET_MAX_LEV, then fall
          // back to this.leverage if neither is set.
          const maxLev = PER_ASSET_MAX_LEV[sym] ?? this.leverage;
          const userLev = this.hfPerAssetLeverage[sym] ?? this.leverage;
          const effectiveBootLev = Math.min(userLev, maxLev);
          await this.client.setLeverage(sym, effectiveBootLev).catch((e) => this.emit("error", e as Error));
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Signal loop: every minute check if a new 1h bar closed
    this.signalLoopTimer = setInterval(() => this.signalTick().catch((e) => this.emit("error", e as Error)), 60_000);
    // Position loop: every 5s update peakFav + ratchet trailing TP
    this.positionLoopTimer = setInterval(() => this.positionTick().catch((e) => this.emit("error", e as Error)), 5_000);
    // HF signal loop: every 30s check if a new 15m bar closed
    this.hfSignalLoopTimer = setInterval(() => this.hfSignalTick().catch((e) => this.emit("error", e as Error)), 30_000);
    // Income reconcile loop: every 5 min backfill exchange-truth P&L on
    // closed trades whose user-data stream events arrived late or never
    // (bot restart, stream drop). Without this the UI shows local estimate
    // forever, which is often optimistic (no fees) and diverges from wallet.
    // Paper mode skips this — there's no exchange income to reconcile against.
    if (!this.paperMode) {
      this.incomeReconcileTimer = setInterval(() => this.reconcileIncomeFromExchange().catch((e) => this.emit("error", e as Error)), 300_000);
      // Run once on start (don't wait 5 min for first reconcile after restart).
      setTimeout(() => this.reconcileIncomeFromExchange().catch((e) => this.emit("error", e as Error)), 10_000);
      // Refresh cached equity on start + every 5 min (used by per-trade risk gate).
      setTimeout(() => this.refreshLiveEquity(), 5_000);
      setInterval(() => this.refreshLiveEquity(), 300_000);
    }
    if (this.hfEnabled) {
      const stakeDesc = this.hfStakeMode === "percent"
        ? `${(this.hfStakePct * 100).toFixed(1)}% of wallet`
        : `$${this.hfStake}`;
      const enabledRules = Object.entries(this.hfPerPatternEnabled).filter(([, on]) => on).map(([r]) => r).join(",");
      this.emit("info", `HF stack enabled: M1..M5 mined rules (${enabledRules}) · stake ${stakeDesc} × ${this.hfLeverage}× · exitMode=${this.hfExitMode} · tp=${this.hfTpAtr}×ATR sl=${this.hfSlAtr}×ATR · filter=${this.hfUseStrengthFilter ? "ON" : "OFF"}`, {
        stake: this.hfStake, stakeMode: this.hfStakeMode, stakePct: this.hfStakePct,
        leverage: this.hfLeverage, allowMultiplePerKey: this.hfAllowMultiplePerKey,
        exitMode: this.hfExitMode, tpAtr: this.hfTpAtr, slAtr: this.hfSlAtr,
        useStrengthFilter: this.hfUseStrengthFilter, enabledRules,
      });
    }
    this.emit("stateChanged");
  }

  async stop() {
    this.running = false;
    if (this.signalLoopTimer) { clearInterval(this.signalLoopTimer); this.signalLoopTimer = null; }
    if (this.positionLoopTimer) { clearInterval(this.positionLoopTimer); this.positionLoopTimer = null; }
    if (this.hfSignalLoopTimer) { clearInterval(this.hfSignalLoopTimer); this.hfSignalLoopTimer = null; }
    if (this.incomeReconcileTimer) { clearInterval(this.incomeReconcileTimer); this.incomeReconcileTimer = null; }
  }

  private async signalTick() {
    this.rollDayIfNeeded();
    if (this.daily.capHit) return;
    // If the client is in an IP-ban suspension, skip the whole tick.
    // Logs one heartbeat line per minute instead of N × 15 error spam.
    if (!this.dataSource && this.client.isBanned()) {
      const secs = Math.ceil(this.client.bannedFor() / 1000);
      if (this.tickCount % 10 === 0) this.emit("info", `signalTick suspended: IP banned for ${secs}s more`, { bannedForMs: this.client.bannedFor() });
      this.tickCount++;
      return;
    }
    this.tickCount++;
    this.signalsThisTick = 0;
    void this.hfTickCount; // referenced by HF loop
    const barsClosed: string[] = [];
    for (const sym of this.assets) {
      const buf = this.bars.get(sym);
      if (!buf || buf.length === 0) continue;
      try {
        // Fetch the most recent 2 × 1h klines.
        // Paper mode (dataSource attached): read live's bars instead of
        // calling the API — prevents doubling the per-IP rate and getting
        // HTTP 418 banned.
        let latest: Kline[];
        if (this.dataSource) {
          const srcBars = this.dataSource.getBarsRef(sym);
          if (!srcBars || srcBars.length === 0) continue;
          latest = srcBars.slice(-2);
        } else {
          latest = await this.client.getKlines(sym, "1h", 2);
        }
        if (latest.length === 0) continue;
        const newest = latest[latest.length - 1];
        // Use the SECOND-MOST-RECENT (last fully-closed) bar
        const closed = latest[latest.length - 2] ?? newest;
        const tail = buf[buf.length - 1];
        if (!tail || closed.epoch > tail.epoch) {
          // New 1h bar closed — append and run signal detection
          buf.push(closed);
          if (buf.length > KLINE_HISTORY) buf.splice(0, buf.length - KLINE_HISTORY);
          barsClosed.push(sym);
          await this.checkSignalsFor(sym);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Heartbeat: log if any new bars closed this cycle, OR every 15 idle minutes
    const idleHeartbeat = this.tickCount % 15 === 0;
    if (barsClosed.length > 0 || idleHeartbeat) {
      this.emit("info", `tick: bars closed=${barsClosed.length}${barsClosed.length ? ` (${barsClosed.join(",")})` : ""}, signals=${this.signalsThisTick}, open=${this.open.length}/${this.assets.length} assets`, {
        tickCount: this.tickCount, barsClosed, signals: this.signalsThisTick, open: this.open.length, assets: this.assets.length,
      });
    }
  }

  private async checkSignalsFor(sym: string) {
    const buf = this.bars.get(sym);
    if (!buf || buf.length < SMA_PERIOD + 10) return;
    if (this.perAssetEnabled[sym] === false) return;
    const i = buf.length - 1;
    const structure = this.structures.get(sym) ?? emptyStructure();
    const sigs = detectSignalsFromCache(buf, i, structure);
    if (sigs.length > 0) {
      this.signalsThisTick += sigs.length;
      this.emit("info", `signals on ${sym}: ${sigs.map(s => `${s.pattern}/${s.side}`).join(", ")}`, {
        asset: sym, count: sigs.length, signals: sigs.map(s => ({ pattern: s.pattern, side: s.side, entryPrice: s.entryPrice })),
      });
    }
    for (const s of sigs) {
      // detectSignalsFromCache only returns SMC patterns; safe cast.
      const smcKey = s.pattern as "OB_BULL" | "OB_BEAR" | "BOS_UP";
      if (this.perPatternEnabled[smcKey] === false) {
        this.emit("info", `skip ${sym} ${s.pattern}: pattern disabled`, { asset: sym, pattern: s.pattern });
        continue;
      }
      if (this.open.find((t) => t.asset === sym && t.pattern === s.pattern && t.side === s.side)) {
        this.emit("info", `skip ${sym} ${s.pattern}/${s.side}: already open`, { asset: sym, pattern: s.pattern });
        continue;
      }
      // Anti-martingale (Paroli) stake scaling per (asset × pattern × side):
      // baseStake × multiplier^streak, capped at maxLevels. HF and SMC patterns
      // each have their own mart config so they can ladder independently.
      // Reset on any loss is handled in closeTradeFromFill → updateMartingale.
      const martKey = `${sym}:${s.pattern}:${s.side}`;
      const isHf = isHfPattern(s.pattern);
      const martMode = isHf ? this.hfMartMode : this.martMode;
      const martMultiplier = isHf ? this.hfMartMultiplier : this.martMultiplier;
      const martMaxLevels = isHf ? this.hfMartMaxLevels : this.martMaxLevels;
      const baseStake = isHf ? this.hfStake : this.stake;
      let stake = baseStake;
      if (martMode === "anti") {
        const streak = Math.min(this.winStreaks[martKey] ?? 0, martMaxLevels);
        stake = baseStake * Math.pow(martMultiplier, streak);
      }
      stake = Math.min(stake, this.perTradeMaxStake);
      if (stake < 1) {
        this.emit("info", `skip ${sym} ${s.pattern}: stake below $1`, { asset: sym });
        continue;
      }
      if (martMode === "anti" && (this.winStreaks[martKey] ?? 0) > 0) {
        this.emit("info", `martingale: ${sym} ${s.pattern}/${s.side} streak=${this.winStreaks[martKey]} → stake $${stake.toFixed(2)}${isHf ? " (HF)" : ""}`, {
          asset: sym, pattern: s.pattern, side: s.side, streak: this.winStreaks[martKey], stake, stack: isHf ? "hf" : "smc",
        });
      }
      await this.openTrade(sym, s, stake);
    }
    updateStructure(structure, buf, i);
    this.structures.set(sym, structure);
  }

  /** Update the win-streak counter after a trade closes. Called from
   *  closeTradeFromFill so it captures every close path (trail, cancel,
   *  reconcile, user-stream fill). */
  private updateMartingale(t: BinanceTrade): void {
    const isHf = isHfPattern(t.pattern);
    const martMode = isHf ? this.hfMartMode : this.martMode;
    const martMaxLevels = isHf ? this.hfMartMaxLevels : this.martMaxLevels;
    if (martMode !== "anti") return;
    const key = `${t.asset}:${t.pattern}:${t.side}`;
    const isWin = (t.pnl ?? 0) > 0;
    if (isWin) {
      const next = Math.min((this.winStreaks[key] ?? 0) + 1, martMaxLevels);
      // At cap: reset (Paroli "bank the run" rule)
      this.winStreaks[key] = next >= martMaxLevels ? 0 : next;
    } else {
      this.winStreaks[key] = 0;
    }
  }

  // ─── HF (15m) loop ────────────────────────────────────────────────────
  /** Per-30s poll: per asset, fetch the last 2 × 15m bars; if a new one
   *  closed since last poll, append it and check for HF signals. Lazy-
   *  seeds the 15m buffer on first call after enable. */
  private async hfSignalTick() {
    if (!this.hfEnabled) return;
    this.rollDayIfNeeded();
    if (this.daily.capHit) return;
    // Skip tick during IP-ban suspension.
    if (!this.dataSource && this.client.isBanned()) {
      const secs = Math.ceil(this.client.bannedFor() / 1000);
      if (this.hfTickCount % 10 === 0) this.emit("info", `hfSignalTick suspended: IP banned for ${secs}s more`, { bannedForMs: this.client.bannedFor() });
      this.hfTickCount++;
      return;
    }
    this.hfTickCount++;
    let signalsFired = 0;
    const barsClosed: string[] = [];
    for (const sym of this.assets) {
      if (this.hfPerAssetEnabled[sym] === false) continue;
      try {
        let buf = this.bars15m.get(sym);
        if (!buf) {
          // First touch — seed the buffer with HF_KLINE_HISTORY bars of 15m history.
          // Paper (dataSource attached): copy from live's already-warmed buffer
          // instead of making our own API call. Live must have HF enabled or
          // already warmed for this to work; otherwise we wait for live to warm
          // up first (next tick will retry).
          if (this.dataSource) {
            const srcBuf = this.dataSource.getBars15mRef(sym);
            if (!srcBuf || srcBuf.length === 0) continue;  // wait for live warmup
            buf = [...srcBuf];
          } else {
            // Binance's klines endpoint includes the CURRENTLY-FORMING bar at the
            // tail. We pop it so `buf` only contains fully-closed bars, otherwise
            // the next bar boundary's close would have the same openTime as our
            // tail and the close-detection branch would never fire.
            buf = await this.client.getKlines(sym, "15m", HF_KLINE_HISTORY);
            if (buf.length > 0) buf.pop();
          }
          this.bars15m.set(sym, buf);
          this.emit("info", `HF warmup ${sym}: ${buf.length} 15m bars${this.dataSource ? " (from upstream)" : " (in-progress bar dropped)"}`, { asset: sym, bars: buf.length });
          continue; // skip detection on warmup tick — next bar close fires it
        }
        // Paper: read latest 2 bars from upstream instead of calling API.
        let latest: Kline[];
        if (this.dataSource) {
          const srcBars = this.dataSource.getBars15mRef(sym);
          if (!srcBars || srcBars.length === 0) continue;
          latest = srcBars.slice(-2);
        } else {
          latest = await this.client.getKlines(sym, "15m", 2);
        }
        if (latest.length === 0) continue;
        const closed = latest[latest.length - 2] ?? latest[latest.length - 1];
        const tail = buf[buf.length - 1];
        if (!tail || closed.epoch > tail.epoch) {
          buf.push(closed);
          if (buf.length > HF_KLINE_HISTORY) buf.splice(0, buf.length - HF_KLINE_HISTORY);
          barsClosed.push(sym);
          signalsFired += await this.checkHfSignalsFor(sym);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Heartbeat — log when bars close OR every 4 idle ticks (~2min) so the
    // UI always sees activity within ~2 minutes of enabling.
    if (barsClosed.length > 0 || this.hfTickCount % 4 === 0) {
      this.emit("info", `HF tick: bars=${barsClosed.length}${barsClosed.length ? ` (${barsClosed.join(",")})` : ""}, signals=${signalsFired}, hfOpen=${this.open.filter(t => isHfPattern(t.pattern)).length}`, {
        tickCount: this.hfTickCount, barsClosed, signals: signalsFired,
      });
    }
  }

  private async checkHfSignalsFor(sym: string): Promise<number> {
    const buf = this.bars15m.get(sym);
    const bars1h = this.bars.get(sym);
    if (!buf || buf.length < 105 || !bars1h || bars1h.length < 50) return 0;
    const i = buf.length - 1;
    const sigs = detectMinedSignals(buf, bars1h, i, this.hfUseStrengthFilter);
    if (sigs.length === 0) return 0;
    this.emit("info", `HF signals on ${sym}: ${sigs.map(s => `${s.pattern}/${s.side}(q${s.qstr ?? "?"}×${s.stakeMult?.toFixed(2) ?? "1.0"})`).join(", ")}`, {
      asset: sym, count: sigs.length, signals: sigs.map(s => ({ pattern: s.pattern, side: s.side, entryPrice: s.entryPrice, strength: s.strength, qstr: s.qstr, stakeMult: s.stakeMult })),
    });

    let opened = 0;
    for (const s of sigs) {
      const rid = s.pattern as HfRuleId;
      if (this.hfPerPatternEnabled[rid] === false) {
        this.emit("info", `HF skip ${sym} ${rid}: pattern disabled`, { asset: sym, pattern: rid });
        continue;
      }
      if (!this.hfAllowMultiplePerKey) {
        const dup = this.open.find((t) => t.asset === sym && t.pattern === s.pattern && t.side === s.side);
        if (dup) {
          this.emit("info", `HF skip ${sym} ${rid}/${s.side}: already open (allowMultiplePerKey=false)`, { asset: sym, pattern: rid });
          continue;
        }
      }
      // Dynamic stake = base × strength-quintile multiplier (from HF_STAKE_MULTS).
      // The detector already filtered out skip-quintiles, so stakeMult is always defined.
      // Base stake is either fixed (hfStake) or percent-of-equity (currentEquity × stakePct).
      // Percent mode is sim-validated to survive drawdowns and compound — 84× over 37mo
      // at 2% on $100 vs flat $2 stake going bust on the first losing streak.
      const mult = s.stakeMult ?? 1.0;
      const baseStake = this.hfStakeMode === "percent"
        ? Math.max(0, this.getCurrentEquity()) * this.hfStakePct
        : this.hfStake;
      const stake = Math.min(baseStake * mult, this.perTradeMaxStake);
      if (stake < 0.5) {
        this.emit("info", `HF skip ${sym} ${rid}: stake $${stake.toFixed(2)} below $0.50 floor (mode=${this.hfStakeMode}${this.hfStakeMode === "percent" ? `, equity=$${this.getCurrentEquity().toFixed(2)}, pct=${(this.hfStakePct * 100).toFixed(1)}%` : ""})`, { asset: sym });
        continue;
      }
      const effectiveLev = this.hfPerAssetLeverage[sym] ?? this.hfLeverage;
      await this.openTrade(sym, s, stake, effectiveLev);
      opened++;
    }
    return opened;
  }
  // ─── End HF loop ──────────────────────────────────────────────────────

  private async openTrade(sym: string, s: Signal, stake: number, leverageOverride?: number) {
    const lockKey = `open:${sym}:${s.pattern}:${s.side}`;
    if (this.busy.has(lockKey)) return;
    this.busy.add(lockKey);
    try {
      const effectiveLeverage = leverageOverride ?? this.leverage;
      const notional = stake * effectiveLeverage;
      const refPrice = s.entryPrice;
      const f = this.filters[sym];
      if (!f) { this.emit("error", new Error(`No filters for ${sym} — cannot place order`)); return; }
      const qtyRaw = notional / refPrice;
      const qty = roundStep(qtyRaw, f.stepSize);
      if (qty < f.minQty) {
        // Not an error — it just means the stake×leverage is too small for
        // this asset's price tier. e.g., $30 notional on BTC at $77k rounds
        // to 0 quantity. Emit as info so it doesn't keep alerting.
        const minStakeNeeded = (f.minQty * refPrice / (leverageOverride ?? this.leverage)).toFixed(2);
        this.emit("info", `skip ${sym} ${s.pattern}: stake $${stake} too small (need ~$${minStakeNeeded} at ${leverageOverride ?? this.leverage}× for min qty ${f.minQty} @ $${refPrice})`, {
          asset: sym, pattern: s.pattern, stake, refPrice, minQty: f.minQty, minStakeNeeded,
        });
        return;
      }
      if (qty * refPrice < f.minNotional) {
        this.emit("info", `skip ${sym} ${s.pattern}: notional $${(qty * refPrice).toFixed(2)} below minNotional $${f.minNotional}`, {
          asset: sym, pattern: s.pattern, notional: qty * refPrice, minNotional: f.minNotional,
        });
        return;
      }

      // ── Risk-rules gate (Elder / Williams / Vantage / Kaufman) ──
      // Default OFF on live; ON in paper. Each gate returns a reason on
      // rejection — surfaced in logs so the operator sees why a signal
      // was skipped.
      const gate = evaluateRiskGate({
        signal: { asset: sym, pattern: s.pattern, side: s.side, entryPrice: refPrice },
        config: this.riskRules,
        openTrades: this.open.map((t) => ({ asset: t.asset, pattern: t.pattern, side: t.side })),
        monthStartEquity: this.monthly.startEquity,
        monthRealizedPnl: this.monthly.realizedPnl,
        signalAtr: s.atrEntry,
        proposedStake: stake,
        proposedLeverage: effectiveLeverage,
        currentEquity: this.getCurrentEquity(),
      });
      if (!gate.ok) {
        this.emit("info", `skip ${sym} ${s.pattern}/${s.side}: ${gate.reason}`, {
          asset: sym, pattern: s.pattern, side: s.side, gate: gate.reason,
        });
        return;
      }

      // Logical-trade UUID is embedded in clientOrderId so user-data stream
      // updates can be matched back to this trade. Prefix differs by group
      // so log readers can see at a glance whether a fill is HF or SMC.
      const tradeId = randomUUID();
      const prefix = isHfPattern(s.pattern) ? "hf" : "smc";
      const cid = `${prefix}-${tradeId.slice(0, 8)}`;
      const orderSide = s.side === "LONG" ? "BUY" : "SELL";
      const positionSide = this.hedgeMode ? (s.side === "LONG" ? "LONG" : "SHORT") : "BOTH";

      let resp: any;
      if (this.paperMode) {
        // Paper: simulate immediate fill at the signal's reference price (== last close).
        // No exchange call, no commission yet (charged on close).
        resp = { orderId: 0, clientOrderId: cid, avgPrice: String(refPrice), executedQty: String(qty), status: "FILLED" };
      } else {
        // Sync exchange leverage to the trade's effectiveLeverage BEFORE
        // placing the order — otherwise we get -2019 "Margin is insufficient"
        // when engine-side sizing (e.g., $20 stake × 75× = $1500 notional)
        // exceeds what Binance allows under the symbol's currently-set
        // leverage. Boot-time setLeverage only runs once per warmup, so
        // any operator change (or our own change for a different stack)
        // would otherwise stick until the next boot.
        // Clamp to the symbol's tier-0 max so we never resend the rejected
        // value that caused the -4028 boot errors.
        const maxLev = PER_ASSET_MAX_LEV[sym] ?? effectiveLeverage;
        const lev = Math.min(effectiveLeverage, maxLev);
        if (lev !== effectiveLeverage) {
          this.emit("info", `clamp lev ${sym}: requested ${effectiveLeverage}× → ${lev}× (per-asset max)`, {
            asset: sym, requested: effectiveLeverage, applied: lev,
          });
        }
        await this.client.setLeverage(sym, lev).catch((e) => this.emit("error", e as Error));
        resp = await this.client.placeMarketOrder({
          symbol: sym, side: orderSide as any, quantity: Number(fmtQty(qty, f.quantityPrecision)),
          positionSide: positionSide as any, clientOrderId: cid,
        });
      }
      // Per-stack hard SL — slPct is % of STAKE the operator is willing to
      // lose at SL (so $50 stake × 50% = $25 max loss). The price-move
      // distance is slPct / leverage. Example: stake $50, lev 30×, slPct 50
      // → price moves 50/30 = 1.67% before SL. UI displays max-$-loss as
      // stake × slPct/100 so the user knows exactly what they're risking.
      //
      // HF rules: prefer ATR-based SL/TP from hfSlAtr/hfTpAtr × atrEntry.
      // When exitMode="fixedRR", set both slPrice AND tpPrice (positionTick
      // closes at market when either is crossed). Trail mode still uses
      // peak-ratchet TP, just adds the ATR-based SL floor.
      const fillPrice = Number(resp.avgPrice) || refPrice;
      const isHf = isHfPattern(s.pattern);
      let slPrice: number | undefined;
      let tpPrice: number | undefined;
      const exitMode = isHf ? this.hfExitMode : "trail";
      if (isHf && s.atrEntry > 0) {
        // ATR-based SL (always for HF, regardless of exit mode)
        const slDist = this.hfSlAtr * s.atrEntry;
        slPrice = s.side === "LONG" ? fillPrice - slDist : fillPrice + slDist;
        // Fixed TP for fixedRR mode
        if (exitMode === "fixedRR") {
          const tpDist = this.hfTpAtr * s.atrEntry;
          tpPrice = s.side === "LONG" ? fillPrice + tpDist : fillPrice - tpDist;
        }
      } else {
        // SMC pattern (or HF with no ATR available): legacy slPct-of-stake path
        const slPctStake = isHf ? this.hfSlPct : this.smcSlPct;
        if (slPctStake > 0 && effectiveLeverage > 0) {
          const priceMovePct = slPctStake / effectiveLeverage;
          const slDist = fillPrice * (priceMovePct / 100);
          slPrice = s.side === "LONG" ? fillPrice - slDist : fillPrice + slDist;
        }
      }
      const trade: BinanceTrade = {
        id: tradeId,
        asset: sym,
        pattern: s.pattern,
        side: s.side,
        stake,
        leverage: effectiveLeverage,
        notional,
        qty,
        entryEpoch: Math.floor(resp.updateTime / 1000),
        entryPrice: fillPrice,
        atrEntry: s.atrEntry,
        peakFav: fillPrice,
        armed: false,
        tpOrderId: null,
        status: "OPEN",
        slPrice,
        tpPrice,
        exitMode: isHf ? exitMode : undefined,
      };
      (trade as any).clientOrderId = cid;
      this.open.push(trade);
      this.daily.tradesOpened++;
      this.emit("opened", trade);
      this.emit("stateChanged");
    } catch (e) {
      this.emit("error", e as Error);
    } finally {
      this.busy.delete(lockKey);
    }
  }

  /** Handle user-data stream events. Match orders to local trades via
   *  clientOrderId. Captures real fill prices, exchange-reported realized
   *  profit (`rp`), and commission (`n`) so the displayed PnL matches what
   *  actually hits the wallet, not the gross local estimate. */
  private onUserEvent(ev: any) {
    if (ev?.e !== "ORDER_TRADE_UPDATE") return;
    const o = ev.o;
    if (!o) return;
    const cid: string = o.c ?? "";
    const execType: string = o.x ?? "";        // "NEW" | "TRADE" | "CANCELED" | "EXPIRED"
    const status: string = o.X ?? "";          // "FILLED" | "PARTIALLY_FILLED" | "NEW" | "CANCELED"
    if (execType !== "TRADE") return;          // only care about actual fills
    const avgPrice = +o.ap || 0;
    const lastFillPrice = +o.L || 0;
    const fillPrice = avgPrice || lastFillPrice;
    const realizedPnl = +o.rp || 0;            // exchange realized profit for this fill
    const commission = Math.abs(+o.n || 0);    // fee paid for this fill (positive)

    // ── Entry fill: cid matches a logical trade in open[] exactly ──
    const entryMatch = this.open.find((t) => (t as any).clientOrderId === cid);
    if (entryMatch) {
      if (fillPrice > 0) {
        entryMatch.entryPrice = fillPrice;
        entryMatch.peakFav = fillPrice;
      }
      entryMatch.commissionEntry = (entryMatch.commissionEntry ?? 0) + commission;
      this.emit("stateChanged");
      return;
    }

    // ── Exit fill: clientOrderId carries the trade-id prefix ──
    // Prefixes: "tp-" (legacy STOP), "close-" (trail trigger), "cancel-" (manual)
    if (cid.startsWith("tp-") || cid.startsWith("close-") || cid.startsWith("cancel-")) {
      const parts = cid.split("-");
      const idPrefix = parts[1] ?? "";
      if (!idPrefix) return;
      // The trade may be in open[] (race: stream fired before closeTradeFromFill)
      // or already in closed[] (normal case).
      const inOpen = this.open.find((t) => t.id.startsWith(idPrefix));
      if (inOpen) {
        // Stream beat the local close path. Let closeTradeFromFill drive the
        // close (it'll move the trade to closed[]), then we'll reconcile fees
        // + rp via the next user-stream event if any further fill arrives.
        inOpen.commissionExit = (inOpen.commissionExit ?? 0) + commission;
        inOpen.realizedPnlExchange = (inOpen.realizedPnlExchange ?? 0) + realizedPnl;
        if (status === "FILLED") {
          this.closeTradeFromFill(inOpen, fillPrice).catch((e) => this.emit("error", e as Error));
        }
        return;
      }
      const inClosed = this.closed.find((t) => t.id.startsWith(idPrefix));
      if (!inClosed) return;
      // Reconcile real values onto the already-closed trade.
      inClosed.commissionExit = (inClosed.commissionExit ?? 0) + commission;
      inClosed.realizedPnlExchange = (inClosed.realizedPnlExchange ?? 0) + realizedPnl;
      const prevPnl = inClosed.pnl ?? 0;
      const entryComm = inClosed.commissionEntry ?? 0;
      const exitComm = inClosed.commissionExit ?? 0;
      const newPnl = (inClosed.realizedPnlExchange ?? 0) - entryComm - exitComm;
      inClosed.pnl = newPnl;
      // Daily profit was incremented with the gross estimate in
      // closeTradeFromFill — adjust by the delta.
      this.daily.profit += (newPnl - prevPnl);
      this.emit("stateChanged");
    }
  }

  private async closeTradeFromFill(t: BinanceTrade, fillPrice: number) {
    const pctMove = (fillPrice - t.entryPrice) / t.entryPrice;
    let gross = t.stake * t.leverage * (t.side === "LONG" ? 1 : -1) * pctMove;
    if (gross < -t.stake) gross = -t.stake;
    let pnl = gross;
    // Paper mode: deduct simulated round-trip cost so the equity curve
    // mirrors what a real broker would have netted (taker fees + slippage).
    if (this.paperMode) {
      const fees = t.stake * t.leverage * this.paperCostRoundTrip;
      pnl = gross - fees;
      // Persist exchange-truth fields so the UI's broker-truth resolver
      // displays the paper number directly (no "est" tag).
      t.realizedPnlExchange = gross;
      t.commissionEntry = fees / 2;
      t.commissionExit = fees / 2;
    }
    t.status = "CLOSED";
    t.closeEpoch = Math.floor(Date.now() / 1000);
    t.closePrice = fillPrice;
    t.pnl = pnl;
    this.open = this.open.filter((x) => x.id !== t.id);
    this.closed.push(t);
    this.daily.profit += pnl;
    if (this.paperMode) this.paperWallet += pnl;
    else this.cachedEquity += pnl;  // incremental live equity update — refreshLiveEquity() resyncs every 5 min
    // Track monthly realized P&L for the 6% circuit breaker.
    this.rollMonthIfNeeded();
    if (this.monthly.startEquity === 0) {
      this.monthly.startEquity = (this.paperMode ? this.paperWallet : this.cachedEquity) - pnl;
    }
    this.monthly.realizedPnl += pnl;
    if (this.daily.profit <= -this.dailyMaxLoss) {
      this.daily.capHit = true;
      this.emit("capHit", -this.daily.profit, this.dailyMaxLoss);
    }
    this.updateMartingale(t);
    this.emit("closed", t);
    this.emit("stateChanged");
  }

  private async positionTick() {
    // Paper mode with attached upstream: read marks from live's cache, don't
    // fetch premiumIndex ourselves. This is essential for avoiding the
    // doubled-API-rate ban that hit production earlier.
    if (this.dataSource) {
      if (this.open.length === 0) return;
      const assetsWithOpen = Array.from(new Set(this.open.map((t) => t.asset)));
      for (const sym of assetsWithOpen) {
        const markPrice = this.dataSource.getCachedMarkPrice(sym);
        if (markPrice === null) continue;  // live hasn't fetched yet — try next tick
        for (const t of this.open.filter((x) => x.asset === sym)) {
          await this.updateTrade(t, markPrice);
        }
      }
      return;
    }
    // Skip position tick entirely during IP-ban suspension.
    if (this.client.isBanned()) return;
    // Live: include consumer (paper)'s open assets so they get cached too.
    const localAssets = new Set(this.open.map((t) => t.asset));
    if (this.dataConsumer) {
      for (const t of this.dataConsumer["open"] as BinanceTrade[]) localAssets.add(t.asset);
    }
    if (localAssets.size === 0) return;
    for (const sym of localAssets) {
      try {
        // Mark price endpoint (public). Route through client's publicRequest
        // so the 418/429 ban-tracking applies — raw fetch() bypassed it and
        // contributed to the cascading bans on 2026-05-24.
        if (this.client.isBanned()) break;
        const data = await (this.client as any).publicRequest("GET", "/fapi/v1/premiumIndex", { symbol: sym });
        const markPrice = +data.markPrice;
        if (!isFinite(markPrice)) continue;
        // Cache for any attached paper consumer.
        this.markCache.set(sym, { price: markPrice, ts: Date.now() });
        for (const t of this.open.filter((x) => x.asset === sym)) {
          await this.updateTrade(t, markPrice);
        }
      } catch (e) {
        this.emit("error", e as Error);
      }
    }
    // Check if any trades have actually closed on Binance (filled via stop)
    await this.reconcilePositions();
  }

  private async updateTrade(t: BinanceTrade, markPrice: number) {
    const armDist = TRAIL_ARM_ATR * t.atrEntry;
    const trailDist = TRAIL_RETRACE_ATR * t.atrEntry;
    let stateChanged = false;
    const wasArmed = t.armed;
    // Always update markPrice so the UI sees real current price and Δ%
    // including adverse moves (peakFav by design only advances favorably).
    t.markPrice = markPrice;
    t.markUpdatedAt = Math.floor(Date.now() / 1000);
    stateChanged = true;
    if (t.side === "LONG") {
      if (markPrice > t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav >= t.entryPrice + armDist) { t.armed = true; stateChanged = true; }
    } else {
      if (markPrice < t.peakFav) { t.peakFav = markPrice; stateChanged = true; }
      if (!t.armed && t.peakFav <= t.entryPrice - armDist) { t.armed = true; stateChanged = true; }
    }
    if (!wasArmed && t.armed) {
      this.emit("info", `trail armed ${t.asset} ${t.pattern}/${t.side}: peak=${t.peakFav.toFixed(5)}`, {
        asset: t.asset, pattern: t.pattern, side: t.side, peakFav: t.peakFav, entryPrice: t.entryPrice,
      });
    }

    // Hard SL trigger (runs BEFORE trail-arm check so a fast adverse move
    // exits cleanly even if peak never reached the arm distance). If
    // slPrice is undefined (slPct=0), this is a no-op.
    if (t.slPrice !== undefined) {
      const slHit = t.side === "LONG" ? markPrice <= t.slPrice : markPrice >= t.slPrice;
      if (slHit) {
        const lockKey = `close:${t.id}`;
        if (this.busy.has(lockKey)) return;
        this.busy.add(lockKey);
        try {
          const f = this.filters[t.asset];
          const closeSide = t.side === "LONG" ? "SELL" : "BUY";
          const positionSide = this.hedgeMode ? t.side : "BOTH";
          this.emit("info", `SL hit ${t.asset} ${t.pattern}/${t.side}: mark=${markPrice.toFixed(5)} sl=${t.slPrice.toFixed(5)}`, {
            asset: t.asset, pattern: t.pattern, side: t.side, markPrice, slPrice: t.slPrice, entryPrice: t.entryPrice,
          });
          if (!this.paperMode) {
            await this.client.placeMarketOrder({
              symbol: t.asset, side: closeSide as any,
              quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
              positionSide: positionSide as any,
              clientOrderId: `sl-${t.id.slice(0, 8)}-${Date.now()}`,
            });
          }
          await this.closeTradeFromFill(t, markPrice);
          if (stateChanged) this.emit("stateChanged");
        } catch (e) {
          this.emit("error", e as Error);
        } finally {
          this.busy.delete(lockKey);
        }
        return;  // don't fall through to trail logic — trade is closed
      }
    }
    // Hard TP trigger (HF fixedRR mode only) — symmetric to SL. Closes
    // at market when mark crosses the fixed TP price. For "trail" mode,
    // tpPrice is undefined and this is a no-op (trail-arm handles winners).
    if (t.tpPrice !== undefined && t.exitMode === "fixedRR") {
      const tpHit = t.side === "LONG" ? markPrice >= t.tpPrice : markPrice <= t.tpPrice;
      if (tpHit) {
        const lockKey = `close:${t.id}`;
        if (this.busy.has(lockKey)) return;
        this.busy.add(lockKey);
        try {
          const f = this.filters[t.asset];
          const closeSide = t.side === "LONG" ? "SELL" : "BUY";
          const positionSide = this.hedgeMode ? t.side : "BOTH";
          this.emit("info", `TP hit ${t.asset} ${t.pattern}/${t.side}: mark=${markPrice.toFixed(5)} tp=${t.tpPrice.toFixed(5)}`, {
            asset: t.asset, pattern: t.pattern, side: t.side, markPrice, tpPrice: t.tpPrice, entryPrice: t.entryPrice,
          });
          if (!this.paperMode) {
            await this.client.placeMarketOrder({
              symbol: t.asset, side: closeSide as any,
              quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
              positionSide: positionSide as any,
              clientOrderId: `tp-${t.id.slice(0, 8)}-${Date.now()}`,
            });
          }
          await this.closeTradeFromFill(t, markPrice);
          if (stateChanged) this.emit("stateChanged");
        } catch (e) {
          this.emit("error", e as Error);
        } finally {
          this.busy.delete(lockKey);
        }
        return;
      }
      // In fixedRR mode, skip trail-arm logic entirely — only TP and SL drive exit.
      if (stateChanged) this.emit("stateChanged");
      return;
    }
    // Trail trigger: once armed, check if mark price has retraced to
    // peak − trailDist. Multi-Assets accounts reject STOP_MARKET via
    // /fapi/v1/order — so the bot fires a MARKET reduce-only order
    // in-process instead. This matches the live-test-validated approach.
    if (t.armed) {
      const trailLevel = t.side === "LONG" ? t.peakFav - trailDist : t.peakFav + trailDist;
      const triggered = t.side === "LONG" ? markPrice <= trailLevel : markPrice >= trailLevel;
      if (triggered) {
        const lockKey = `close:${t.id}`;
        if (this.busy.has(lockKey)) return;
        this.busy.add(lockKey);
        try {
          const f = this.filters[t.asset];
          const closeSide = t.side === "LONG" ? "SELL" : "BUY";
          const positionSide = this.hedgeMode ? t.side : "BOTH";
          if (!this.paperMode) {
            await this.client.placeMarketOrder({
              symbol: t.asset, side: closeSide as any,
              quantity: Number(fmtQty(t.qty, f?.quantityPrecision ?? 3)),
              positionSide: positionSide as any,
              clientOrderId: `close-${t.id.slice(0, 8)}-${Date.now()}`,
            });
          }
          // Close logic: position settles in next reconcile / user-data stream tick.
          // We pre-emptively close locally with current markPrice for fast UI feedback;
          // exact fill price will be refined by user-data stream ORDER_TRADE_UPDATE.
          // In paper mode, this IS the final settlement.
          await this.closeTradeFromFill(t, markPrice);
          stateChanged = true;
        } catch (e) {
          this.emit("error", e as Error);
        } finally {
          this.busy.delete(lockKey);
        }
      }
    }
    if (stateChanged) this.emit("stateChanged");
  }

  /** Safety-net reconciler. In hedge mode, Binance tracks one position per
   *  (symbol, side). Local "trades" are logical sub-positions that share that
   *  aggregated Binance position. Trade closes are normally driven by the
   *  user-data stream (ORDER_TRADE_UPDATE → closeTradeFromFill). This
   *  reconciler ONLY fires when the Binance position on a side is zero
   *  while we still have local trades open — i.e., a liquidation or manual
   *  close happened outside the bot, and the stream event was missed. */
  private async reconcilePositions() {
    // Paper mode: no exchange positions to reconcile against. Local open[] is
    // the truth; trail-trigger closes are the only exit path.
    if (this.paperMode) return;
    try {
      const positions = await this.client.getPositions();
      // Index by (symbol, positionSide)
      const posMap = new Map<string, number>();
      for (const p of positions) posMap.set(`${p.symbol}:${p.positionSide}`, Math.abs(p.positionAmt));
      const nowSec = Math.floor(Date.now() / 1000);
      for (const t of [...this.open]) {
        // Skip very young trades — Binance's positionRisk endpoint can lag
        // 1-5s behind a market order ack, so a fresh trade looks "flat" on
        // the API and the reconciler would spuriously close it at entry
        // price for $0 PnL. 30s is enough for any reasonable propagation lag.
        if (nowSec - t.entryEpoch < 30) continue;
        const sideKey = this.hedgeMode ? t.side : "BOTH";
        const amt = posMap.get(`${t.asset}:${sideKey}`) ?? 0;
        if (amt < 1e-9) {
          // Whole side flat on Binance — close locally (approx PnL via peakFav)
          await this.closeTradeFromReconcile(t);
        }
      }
    } catch (e) {
      this.emit("error", e as Error);
    }
  }

  private async closeTradeFromReconcile(t: BinanceTrade) {
    // Position vanished from Binance but we still think trade is open —
    // liquidation, manual close, or stale state. Best-effort PnL from peakFav.
    const exitPrice = t.peakFav;
    const pctMove = (exitPrice - t.entryPrice) / t.entryPrice;
    let pnl = t.stake * t.leverage * (t.side === "LONG" ? 1 : -1) * pctMove;
    if (pnl < -t.stake) pnl = -t.stake;
    t.status = "CLOSED";
    t.closeEpoch = Math.floor(Date.now() / 1000);
    t.closePrice = exitPrice;
    t.pnl = pnl;
    this.open = this.open.filter((x) => x.id !== t.id);
    this.closed.push(t);
    this.daily.profit += pnl;
    if (this.daily.profit <= -this.dailyMaxLoss) {
      this.daily.capHit = true;
      this.emit("capHit", -this.daily.profit, this.dailyMaxLoss);
    }
    this.updateMartingale(t);
    this.emit("closed", t);
    this.emit("stateChanged");
  }

  /** Pull REALIZED_PNL + COMMISSION income from Binance for the last 7 days
   *  and attribute each event to a closed trade by symbol + close-time window.
   *  Trades that already have `realizedPnlExchange` populated (from the
   *  user-data stream) are skipped. Trades without it get their `pnl` rewritten
   *  to exchange-truth (`realizedPnl − commissions`) and `daily.profit` is
   *  adjusted by the delta. Window: closeEpoch ± 90s on the same symbol.
   *
   *  Limitation: if multiple trades on the same symbol closed within the
   *  90s window, attribution is by nearest-time. Cleaner attribution would
   *  require persisting closeOrderId on each trade and matching by `info`. */
  private async reconcileIncomeFromExchange() {
    if (this.closed.length === 0) return;
    // Only reconcile trades from the last 7 days (Binance income window is finite
    // anyway, and older trades shouldn't be re-touched).
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const sinceMs = Date.now() - sevenDaysMs;
    const candidates = this.closed.filter(
      (t) => typeof t.realizedPnlExchange !== "number"
        && t.closeEpoch && t.closeEpoch * 1000 >= sinceMs,
    );
    if (candidates.length === 0) return;

    type IncomeEvent = { symbol: string; incomeType: string; income: number; timeMs: number; info: string; tradeId: string };
    let events: IncomeEvent[];
    try {
      events = await this.client.getIncomeHistory(sinceMs);
    } catch (e) {
      this.emit("error", e as Error);
      return;
    }
    if (events.length === 0) return;

    // Group income events by symbol for efficient lookup.
    const bySymbol = new Map<string, IncomeEvent[]>();
    for (const ev of events) {
      const arr = bySymbol.get(ev.symbol) ?? [];
      arr.push(ev);
      bySymbol.set(ev.symbol, arr);
    }
    // Within each symbol, sort by time ascending so we can scan once.
    for (const arr of bySymbol.values()) arr.sort((a, b) => a.timeMs - b.timeMs);

    // Track which events have been claimed by a trade so we don't double-attribute.
    const claimed = new Set<number>(); // index into the symbol's array

    let updated = 0;
    for (const t of candidates) {
      const closeMs = (t.closeEpoch ?? 0) * 1000;
      const symEvents = bySymbol.get(t.asset) ?? [];
      // Find unclaimed REALIZED_PNL within ±90s of close on this symbol.
      let realizedPnl: number | undefined;
      let commission = 0;
      let claimedThis: number[] = [];
      for (let i = 0; i < symEvents.length; i++) {
        if (claimed.has(i)) continue;
        const ev = symEvents[i];
        const dt = Math.abs(ev.timeMs - closeMs);
        if (dt > 90_000) continue;
        if (ev.incomeType === "REALIZED_PNL" && realizedPnl === undefined) {
          realizedPnl = ev.income;
          claimedThis.push(i);
        } else if (ev.incomeType === "COMMISSION") {
          // Commission events come in pairs (entry + exit); both fall in window.
          commission += Math.abs(ev.income); // ev.income is negative
          claimedThis.push(i);
        }
      }
      if (realizedPnl === undefined) continue;
      // Commit: claim the events and update the trade.
      for (const i of claimedThis) claimed.add(i);
      const prevPnl = t.pnl ?? 0;
      t.realizedPnlExchange = realizedPnl;
      // We can't easily split entry vs exit commission without orderId, so
      // put it all in commissionExit. Sum is what matters for net P&L display.
      t.commissionExit = commission;
      t.commissionEntry = 0;
      const newPnl = realizedPnl - commission;
      t.pnl = newPnl;
      this.daily.profit += (newPnl - prevPnl);
      updated++;
    }
    if (updated > 0) {
      this.emit("info", `income reconcile: backfilled exchange-truth P&L on ${updated} trade(s)`, {
        reconciled: updated, candidates: candidates.length,
      });
      this.emit("stateChanged");
    }
  }

  on<K extends keyof BinanceEngineEvents>(event: K, listener: (...args: BinanceEngineEvents[K]) => void): this { return super.on(event, listener as any); }
  emit<K extends keyof BinanceEngineEvents>(event: K, ...args: BinanceEngineEvents[K]): boolean { return super.emit(event, ...args); }
}

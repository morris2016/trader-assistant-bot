// Paper trading engine — simulates a virtual account that takes every signal
// the bot would have placed live, with the same stake-modulation rules.
//
// On signal: opens a paper position with ATR-based TP/SL (matching real config).
// On each candle: checks open positions for TP or SL hits, settles them, updates
// the simulated balance. Persists alongside real state.

import { randomUUID } from "node:crypto";
import type { Candle, SymbolCode } from "@shared/types";
import {
  computeStakeMultiplier,
  emptyAdaptiveShiftState,
  isMetalsSymbol,
  updateAfterTrade,
  type AdaptiveShiftState,
} from "../main/engine/adaptive-shift";

export type PaperPosition = {
  id: string;
  signalId: string;
  symbol: SymbolCode;
  side: "BUY" | "SELL";
  detector: string;
  stake: number;
  multiplier: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  openedAt: number;
  openedAtCandleEpoch: number;
  granularity: number;
  /** Stake multiplier applied at open (from adaptive shift), recorded for transparency. */
  appliedShiftMultiplier: number;
  appliedShiftReasons: string;
  /** Deriv-style commission charged at open, deducted from pnl at settle. */
  commission: number;
  /** Adverse entry slippage applied to entryPrice at open (price units). */
  entrySpread: number;
};

export type ClosedPaperPosition = PaperPosition & {
  closedAt: number;
  closedAtCandleEpoch: number;
  exitPrice: number;
  result: "won" | "lost";
  pnl: number;
  rMultiple: number;
};

export type PaperState = {
  startingBalance: number;
  balance: number;
  open: PaperPosition[];
  closed: ClosedPaperPosition[];
  daily: { date: string; profit: number; tradesOpened: number; capHit: boolean };
  /** Equity curve samples (timestamp, balance after each settle). */
  equity: { ts: number; balance: number }[];
  adaptiveShift: AdaptiveShiftState;
};

const DEFAULT_STARTING_BALANCE = 500;
const MAX_CLOSED_RETAINED = 1000;
const MAX_EQUITY_POINTS = 2000;

export function emptyPaperState(startingBalance = DEFAULT_STARTING_BALANCE): PaperState {
  return {
    startingBalance,
    balance: startingBalance,
    open: [],
    closed: [],
    daily: { date: "", profit: 0, tradesOpened: 0, capHit: false },
    equity: [{ ts: Date.now(), balance: startingBalance }],
    adaptiveShift: emptyAdaptiveShiftState(),
  };
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

export class PaperEngine {
  private state: PaperState;
  private listeners: Array<(state: PaperState) => void> = [];

  constructor(state: PaperState | null = null) {
    this.state = state ?? emptyPaperState();
    this.rollDayIfNeeded();
  }

  load(state: PaperState) {
    this.state = state;
    this.rollDayIfNeeded();
  }

  getState(): PaperState {
    return this.state;
  }

  onChange(cb: (s: PaperState) => void) {
    this.listeners.push(cb);
  }

  reset(startingBalance = DEFAULT_STARTING_BALANCE) {
    this.state = emptyPaperState(startingBalance);
    this.emit();
  }

  /**
   * Open a paper position based on a signal.
   * Returns the opened position, or null if balance/atr invalid.
   */
  openPosition(opts: {
    signalId: string;
    symbol: SymbolCode;
    side: "BUY" | "SELL";
    detector: string;
    entryPrice: number;
    atr: number;
    atrTpMult: number;
    atrSlMult: number;
    multiplier: number;
    granularity: number;
    candleEpoch: number;
    baseStake: number;
    minStake: number;
    nowMs: number;
    /** Structural SL emitted by the detector (e.g. OB wick + buffer). Used in
     *  preference to ATR-derived SL when present, matching the backtest path. */
    signalStopPrice?: number;
    /** Structural TP emitted by the detector. Used in preference to ATR TP. */
    signalTargetPrice?: number;
    /** When provided, bypasses the adaptive-shift multiplier and uses this
     *  exact stake. Used by the fast-trade sandbox where martingale (computed
     *  externally) supplies the stake. The PaperEngine still enforces minStake
     *  and balance checks. */
    stakeOverride?: number;
    /** Deriv-style commission as a fraction of stake (e.g. 0.005 = 0.5%).
     *  Charged once at trade open; subtracted from pnl at settle so the paper
     *  balance reflects what the real bot would actually keep. */
    commissionPct?: number;
    /** Adverse entry slippage as a fraction of entry price (e.g. 0.0001 = 1bp).
     *  Shifts entry against the side direction so a BUY enters slightly higher
     *  and a SELL slightly lower — matching Deriv's bid/ask spread on the
     *  multiplier order. SL/TP and pnl are computed from the slipped entry. */
    entrySpreadFrac?: number;
  }): PaperPosition | null {
    if (!isFinite(opts.atr) || opts.atr <= 0) return null;
    if (!isFinite(opts.entryPrice) || opts.entryPrice <= 0) return null;
    if (this.state.balance < opts.minStake) return null;

    // Stake selection: caller-provided override (martingale) wins over the
    // engine's adaptive-shift logic. Reasons string still records what was
    // applied for audit trail.
    let mult = 1;
    let reasons: string[] = [];
    let stake: number;
    if (opts.stakeOverride != null && isFinite(opts.stakeOverride) && opts.stakeOverride > 0) {
      stake = Math.max(opts.minStake, Math.round(opts.stakeOverride * 100) / 100);
      reasons = ["override"];
    } else {
      const shift = computeStakeMultiplier(this.state.adaptiveShift, opts.side, opts.symbol, opts.nowMs);
      mult = shift.mult;
      reasons = shift.reasons;
      stake = Math.max(opts.minStake, Math.round(opts.baseStake * mult * 100) / 100);
    }
    // Commission is recorded on the position and deducted from pnl at settle.
    // Stake-affordability check applies to stake + commission so a thin balance
    // can't open a trade whose fee alone exceeds available funds.
    const commissionPct = isFinite(opts.commissionPct ?? 0) && (opts.commissionPct ?? 0) >= 0 ? (opts.commissionPct ?? 0) : 0;
    const commission = round2(stake * commissionPct);
    if (stake + commission > this.state.balance) return null; // can't afford stake + fee

    // Apply entry slippage adversely (BUY pays higher, SELL receives lower).
    const spreadFrac = isFinite(opts.entrySpreadFrac ?? 0) && (opts.entrySpreadFrac ?? 0) >= 0 ? (opts.entrySpreadFrac ?? 0) : 0;
    const entrySpread = opts.entryPrice * spreadFrac;
    const effectiveEntry = opts.side === "BUY" ? opts.entryPrice + entrySpread : opts.entryPrice - entrySpread;

    const slDelta = opts.atr * opts.atrSlMult;
    const tpDelta = opts.atr * opts.atrTpMult;
    const atrStopPrice = opts.side === "BUY" ? effectiveEntry - slDelta : effectiveEntry + slDelta;
    const atrTpPrice   = opts.side === "BUY" ? effectiveEntry + tpDelta : effectiveEntry - tpDelta;
    // Prefer structural stops/targets emitted by the detector when present and
    // on the correct side of entry. Matches the backtest path so live and
    // validation use the same SL/TP.
    //
    // CRITICAL: when SL is structural but TP is missing, do NOT fall back to
    // ATR×atrTpMult for TP — that produces an SL/TP unit mismatch. A structural
    // SL on a wide-ATR FVG can be 10x bigger than ATR×atrTpMult, leaving
    // wins of ~0.1R while losses are 1R (catastrophic). Instead, derive TP
    // from the structural stop distance × the validated R:R ratio
    // (atrTpMult / atrSlMult). This preserves the validated R:R using the
    // structural stop as the unit, matching backtest behavior.
    const sigSL = opts.signalStopPrice;
    const sigTP = opts.signalTargetPrice;
    const slOnRightSide = sigSL != null && isFinite(sigSL) && (opts.side === "BUY" ? sigSL < effectiveEntry : sigSL > effectiveEntry);
    const tpOnRightSide = sigTP != null && isFinite(sigTP) && (opts.side === "BUY" ? sigTP > effectiveEntry : sigTP < effectiveEntry);
    let stopPrice: number;
    let tpPrice: number;
    if (slOnRightSide && tpOnRightSide) {
      stopPrice = sigSL!;
      tpPrice = sigTP!;
    } else if (slOnRightSide) {
      stopPrice = sigSL!;
      const stopDistance = Math.abs(effectiveEntry - sigSL!);
      const rr = opts.atrSlMult > 0 ? opts.atrTpMult / opts.atrSlMult : 1;
      const derivedTpDelta = stopDistance * rr;
      tpPrice = opts.side === "BUY" ? effectiveEntry + derivedTpDelta : effectiveEntry - derivedTpDelta;
    } else if (tpOnRightSide) {
      tpPrice = sigTP!;
      const tpDistance = Math.abs(sigTP! - effectiveEntry);
      const rr = opts.atrTpMult > 0 ? opts.atrSlMult / opts.atrTpMult : 1;
      const derivedSlDelta = tpDistance * rr;
      stopPrice = opts.side === "BUY" ? effectiveEntry - derivedSlDelta : effectiveEntry + derivedSlDelta;
    } else {
      stopPrice = atrStopPrice;
      tpPrice = atrTpPrice;
    }

    const pos: PaperPosition = {
      id: randomUUID(),
      signalId: opts.signalId,
      symbol: opts.symbol,
      side: opts.side,
      detector: opts.detector,
      stake,
      multiplier: opts.multiplier,
      entryPrice: effectiveEntry,
      stopPrice,
      takeProfitPrice: tpPrice,
      openedAt: opts.nowMs,
      openedAtCandleEpoch: opts.candleEpoch,
      granularity: opts.granularity,
      appliedShiftMultiplier: mult,
      appliedShiftReasons: reasons.join("+") || "100%",
      commission,
      entrySpread: round2(entrySpread),
    };
    this.state.open.push(pos);
    this.state.daily.tradesOpened++;
    this.emit();
    return pos;
  }

  /**
   * Check open positions for TP/SL hits in the given candle and settle any hit.
   * Returns the list of newly-settled positions.
   */
  onCandle(symbol: SymbolCode, granularity: number, candle: Candle): ClosedPaperPosition[] {
    this.rollDayIfNeeded();
    const settled: ClosedPaperPosition[] = [];
    const stillOpen: PaperPosition[] = [];
    for (const pos of this.state.open) {
      if (pos.symbol !== symbol) { stillOpen.push(pos); continue; }
      // CRITICAL: skip the bar the position opened on. The detector signaled
      // at bar-close, but the bar's high/low already include moves that
      // happened BEFORE the signal — using them to settle would let paper
      // "TP-instantly" on a level that was tagged earlier in the bar but
      // wasn't reachable post-entry. Live can't replicate that (the contract
      // opens AFTER the bar closes), so settling intra-bar artificially
      // inflates paper WR. Only check NEW bars.
      if (candle.epoch <= pos.openedAtCandleEpoch) { stillOpen.push(pos); continue; }
      // Check for TP / SL hit. Conservative: if both touched in same bar, assume SL first.
      const slHit = pos.side === "BUY" ? candle.low <= pos.stopPrice : candle.high >= pos.stopPrice;
      const tpHit = pos.side === "BUY" ? candle.high >= pos.takeProfitPrice : candle.low <= pos.takeProfitPrice;
      if (!slHit && !tpHit) {
        stillOpen.push(pos);
        continue;
      }
      // If both hit in the same bar, conservative: SL takes precedence
      const wasWin = tpHit && !slHit;
      const exitPrice = wasWin ? pos.takeProfitPrice : pos.stopPrice;
      const moveAmt = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const sideSign = pos.side === "BUY" ? 1 : -1;
      const pnlPct = Math.max(-1, moveAmt * pos.multiplier * sideSign); // cap at -100% stake
      const grossPnl = pos.stake * pnlPct;
      // Commission charged at open is deducted from final pnl. Net pnl is what
      // hits balance — matches the real Deriv multiplier-contract settlement
      // where the commission is removed from the contract value before payout.
      const netPnl = grossPnl - (pos.commission ?? 0);
      const rMultiple = pos.stake > 0 ? netPnl / pos.stake : 0;
      const closed: ClosedPaperPosition = {
        ...pos,
        closedAt: Date.now(),
        closedAtCandleEpoch: candle.epoch,
        exitPrice,
        result: netPnl > 0 ? "won" : "lost",
        pnl: round2(netPnl),
        rMultiple: round2(rMultiple),
      };
      settled.push(closed);
      this.state.balance = round2(this.state.balance + netPnl);
      this.state.daily.profit = round2(this.state.daily.profit + netPnl);
      this.state.closed.unshift(closed);
      if (this.state.closed.length > MAX_CLOSED_RETAINED) this.state.closed.length = MAX_CLOSED_RETAINED;
      this.state.equity.push({ ts: closed.closedAt, balance: this.state.balance });
      if (this.state.equity.length > MAX_EQUITY_POINTS) this.state.equity.splice(0, this.state.equity.length - MAX_EQUITY_POINTS);
      // Update adaptive shift
      this.state.adaptiveShift = updateAfterTrade(
        this.state.adaptiveShift,
        netPnl > 0 ? "W" : "L",
        pos.side,
        pos.symbol,
        closed.closedAt,
      );
    }
    this.state.open = stillOpen;
    if (settled.length > 0) this.emit();
    return settled;
  }

  describeAdaptive(): string {
    const a = this.state.adaptiveShift;
    const parts: string[] = [];
    if (a.consecLosses > 0) parts.push(`${a.consecLosses}L streak`);
    return parts.length > 0 ? parts.join(", ") : "normal";
  }

  /** Aggregate stats. */
  stats() {
    const closed = this.state.closed;
    const wins = closed.filter((c) => c.pnl > 0).length;
    const losses = closed.length - wins;
    const totalPnl = closed.reduce((a, c) => a + c.pnl, 0);
    const winRate = closed.length ? wins / closed.length : 0;
    const totalR = closed.reduce((a, c) => a + c.rMultiple, 0);
    const avgR = closed.length ? totalR / closed.length : 0;
    const peak = this.state.equity.reduce((m, e) => Math.max(m, e.balance), this.state.startingBalance);
    const ddPct = peak > 0 ? ((this.state.balance - peak) / peak) * 100 : 0;
    return {
      startingBalance: this.state.startingBalance,
      balance: round2(this.state.balance),
      totalPnl: round2(totalPnl),
      pnlPct: this.state.startingBalance > 0 ? ((this.state.balance - this.state.startingBalance) / this.state.startingBalance) * 100 : 0,
      trades: closed.length,
      wins,
      losses,
      winRate,
      avgR: round2(avgR),
      peak: round2(peak),
      ddPct: round2(ddPct),
      open: this.state.open.length,
    };
  }

  private rollDayIfNeeded() {
    const today = utcDay();
    if (this.state.daily.date !== today) {
      this.state.daily = { date: today, profit: 0, tradesOpened: 0, capHit: false };
    }
  }

  private emit() {
    for (const cb of this.listeners) cb(this.state);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

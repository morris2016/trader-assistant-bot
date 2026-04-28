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
  }): PaperPosition | null {
    if (!isFinite(opts.atr) || opts.atr <= 0) return null;
    if (!isFinite(opts.entryPrice) || opts.entryPrice <= 0) return null;
    if (this.state.balance < opts.minStake) return null;

    // Apply adaptive shift to stake
    const { mult, reasons } = computeStakeMultiplier(this.state.adaptiveShift, opts.side, opts.symbol, opts.nowMs);
    const stake = Math.max(opts.minStake, Math.round(opts.baseStake * mult * 100) / 100);
    if (stake > this.state.balance) return null; // can't afford

    const slDelta = opts.atr * opts.atrSlMult;
    const tpDelta = opts.atr * opts.atrTpMult;
    const stopPrice = opts.side === "BUY" ? opts.entryPrice - slDelta : opts.entryPrice + slDelta;
    const tpPrice   = opts.side === "BUY" ? opts.entryPrice + tpDelta : opts.entryPrice - tpDelta;

    const pos: PaperPosition = {
      id: randomUUID(),
      signalId: opts.signalId,
      symbol: opts.symbol,
      side: opts.side,
      detector: opts.detector,
      stake,
      multiplier: opts.multiplier,
      entryPrice: opts.entryPrice,
      stopPrice,
      takeProfitPrice: tpPrice,
      openedAt: opts.nowMs,
      openedAtCandleEpoch: opts.candleEpoch,
      granularity: opts.granularity,
      appliedShiftMultiplier: mult,
      appliedShiftReasons: reasons.join("+") || "100%",
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
      const pnl = pos.stake * pnlPct;
      const rMultiple = pos.stake > 0 ? pnl / pos.stake : 0;
      const closed: ClosedPaperPosition = {
        ...pos,
        closedAt: Date.now(),
        closedAtCandleEpoch: candle.epoch,
        exitPrice,
        result: pnl > 0 ? "won" : "lost",
        pnl: round2(pnl),
        rMultiple: round2(rMultiple),
      };
      settled.push(closed);
      this.state.balance = round2(this.state.balance + pnl);
      this.state.daily.profit = round2(this.state.daily.profit + pnl);
      this.state.closed.unshift(closed);
      if (this.state.closed.length > MAX_CLOSED_RETAINED) this.state.closed.length = MAX_CLOSED_RETAINED;
      this.state.equity.push({ ts: closed.closedAt, balance: this.state.balance });
      if (this.state.equity.length > MAX_EQUITY_POINTS) this.state.equity.splice(0, this.state.equity.length - MAX_EQUITY_POINTS);
      // Update adaptive shift
      this.state.adaptiveShift = updateAfterTrade(
        this.state.adaptiveShift,
        pnl > 0 ? "W" : "L",
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

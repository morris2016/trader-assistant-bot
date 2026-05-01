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
  /** Deriv-style commission charged at open, deducted from balance at open. */
  commission: number;
  /** Adverse entry slippage applied to entryPrice when finalized (price units). */
  entrySpread: number;
  /** Configured SL slippage fraction at open time (e.g. 0.0005 = 5bps). Used
   *  at settle to model adverse fills past the stop on synthetic spikes. */
  slSlippageFrac: number;
  /** When true, the entry price hasn't been finalized yet — paper is waiting
   *  for the first new bar to use that bar's open as the realistic entry
   *  (mirroring live: contract opens *after* signal-bar close). Once the
   *  next bar arrives, entryPrice is updated and this flag flips false. */
  entryFinalized: boolean;
  /** Signal-time price hint, kept for telemetry comparison. The actual
   *  entryPrice may differ once it gets finalized on the next bar's open. */
  signalEntryPrice: number;
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
    /** Adverse SL fill slippage as a fraction of price (e.g. 0.0005 = 5bps).
     *  When SL hits, exit_price is shifted past the stop by this fraction —
     *  models Deriv's next-tick SL fill behavior on synthetic-index spikes
     *  where SL doesn't fill at the trigger price. */
    slSlippageFrac?: number;
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
    // Commission is recorded AND deducted from balance at open — matches
    // Deriv's behavior where the commission is removed from contract value
    // immediately on buy. Stake-affordability check applies to stake +
    // commission so a thin balance can't open a trade whose fee alone
    // exceeds available funds.
    const commissionPct = isFinite(opts.commissionPct ?? 0) && (opts.commissionPct ?? 0) >= 0 ? (opts.commissionPct ?? 0) : 0;
    const commission = round2(stake * commissionPct);
    if (stake + commission > this.state.balance) return null; // can't afford stake + fee

    // Entry-time slippage: BUY adverse = higher fill, SELL adverse = lower
    // fill. Provisionally compute a "signal entry" using the trigger-bar
    // close — this is the level the strategy detector saw. The realistic
    // entry price will be FINALIZED on the first new bar's open (mirroring
    // live: the contract opens AFTER the signal-bar closes, on fresh ticks
    // of the next bar). entryFinalized=false until that happens.
    const spreadFrac = isFinite(opts.entrySpreadFrac ?? 0) && (opts.entrySpreadFrac ?? 0) >= 0 ? (opts.entrySpreadFrac ?? 0) : 0;
    const slipFrac = isFinite(opts.slSlippageFrac ?? 0) && (opts.slSlippageFrac ?? 0) >= 0 ? (opts.slSlippageFrac ?? 0) : 0;
    const entrySpreadDistance = opts.entryPrice * spreadFrac;
    // Provisional effective entry — used to compute SL/TP geometry from the
    // signal's structural levels. Will be replaced with bar.open on the
    // first new-bar candle event.
    const effectiveEntry = opts.side === "BUY" ? opts.entryPrice + entrySpreadDistance : opts.entryPrice - entrySpreadDistance;

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
      // Provisional entryPrice — finalized on first new-bar candle (see onCandle).
      entryPrice: effectiveEntry,
      stopPrice,
      takeProfitPrice: tpPrice,
      openedAt: opts.nowMs,
      openedAtCandleEpoch: opts.candleEpoch,
      granularity: opts.granularity,
      appliedShiftMultiplier: mult,
      appliedShiftReasons: reasons.join("+") || "100%",
      commission,
      entrySpread: round2(entrySpreadDistance),
      slSlippageFrac: slipFrac,
      entryFinalized: false,
      signalEntryPrice: opts.entryPrice,
    };
    // Charge commission at OPEN (matches Deriv's contract pricing). Balance
    // is reduced immediately so other systems (DD circuit, can-afford checks)
    // see the realistic mid-trade balance.
    this.state.balance = round2(this.state.balance - commission);
    this.state.equity.push({ ts: opts.nowMs, balance: this.state.balance });
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
      // Finalize entry on the first new-bar arrival. Live opens the contract
      // AFTER the trigger bar closes — the realistic entry price is that
      // first new bar's open (with adverse spread layered on top), not the
      // detector's signal-time close. Recompute structural SL/TP relative
      // to the new effective entry so geometry matches what live sees.
      if (!pos.entryFinalized) {
        const newEntry = pos.side === "BUY"
          ? candle.open + (pos.entrySpread)
          : candle.open - (pos.entrySpread);
        // Shift SL/TP by the same delta so the geometry preserved at signal
        // time (structural distance) carries over to the realistic entry.
        const delta = newEntry - pos.entryPrice;
        pos.entryPrice = newEntry;
        pos.stopPrice += delta;
        pos.takeProfitPrice += delta;
        pos.entryFinalized = true;
        // Same bar's high/low can still trigger TP/SL — this matches live,
        // where the contract is alive within seconds of the bar starting.
      }
      // Check for TP / SL hit. Conservative: if both touched in same bar, assume SL first.
      const slHit = pos.side === "BUY" ? candle.low <= pos.stopPrice : candle.high >= pos.stopPrice;
      const tpHit = pos.side === "BUY" ? candle.high >= pos.takeProfitPrice : candle.low <= pos.takeProfitPrice;
      if (!slHit && !tpHit) {
        stillOpen.push(pos);
        continue;
      }
      // If both hit in the same bar, conservative: SL takes precedence
      const wasWin = tpHit && !slHit;
      // SL slippage: when SL hits on synthetic spikes, Deriv fills past the
      // stop on the next tick (typical 5-15bps). TP fills cleanly during
      // normal price action so no slippage applied there.
      const slipDistance = (pos.slSlippageFrac ?? 0) * pos.entryPrice;
      const slFillPrice = pos.side === "BUY"
        ? pos.stopPrice - slipDistance     // BUY SL fill below stop (worse for trader)
        : pos.stopPrice + slipDistance;    // SELL SL fill above stop
      const exitPrice = wasWin ? pos.takeProfitPrice : slFillPrice;
      const moveAmt = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const sideSign = pos.side === "BUY" ? 1 : -1;
      const pnlPct = Math.max(-1, moveAmt * pos.multiplier * sideSign); // cap at -100% stake
      const grossPnl = pos.stake * pnlPct;
      // Commission was charged at OPEN (deducted from balance there). Settle
      // pnl is gross only — net to operator is gross now, plus the negative
      // commission already reflected in balance earlier.
      const netPnl = grossPnl;
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

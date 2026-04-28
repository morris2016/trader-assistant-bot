import { randomUUID } from "node:crypto";
import type {
  ClosedPaperPosition,
  PaperPosition,
  PaperState,
  PaperStats,
  Signal,
  SymbolCode,
  Tick,
} from "@shared/types";

/**
 * Paper-trading engine.
 *
 * Simple model for v0: a signal opens a position at the current tick price,
 * with a fixed TP / SL distance in percent. Subsequent ticks close the position
 * when TP or SL is hit, or when an opposite signal arrives.
 *
 * Stake is tracked but since Deriv Rise/Fall is binary, for paper we just
 * compute P&L as stake * (pnlPct). This is approximate — it maps to the
 * directional move rather than Deriv's actual payout curve — but good enough
 * to judge whether a detector is directionally correct. Real trading will use
 * Deriv's actual contract pricing.
 */

const TP_PCT = 0.003; // 0.3% take-profit
const SL_PCT = 0.002; // 0.2% stop-loss
const DEFAULT_STAKE = 10;
const MAX_OPEN_PER_SYMBOL = 1;
const HISTORY_LIMIT = 200;

export class PaperEngine {
  private open: PaperPosition[] = [];
  private closed: ClosedPaperPosition[] = [];

  load(state: { open: PaperPosition[]; closed: ClosedPaperPosition[] }) {
    this.open = state.open ?? [];
    this.closed = state.closed ?? [];
  }

  reset() {
    this.open = [];
    this.closed = [];
  }

  onSignal(signal: Signal, price: number): { opened?: PaperPosition; closed?: ClosedPaperPosition[] } {
    const closed: ClosedPaperPosition[] = [];

    // Close any opposite open position on this symbol.
    const opposite = this.open.filter(
      (p) => p.symbol === signal.symbol && p.side !== signal.action
    );
    for (const pos of opposite) {
      const c = this.closePosition(pos, price, signal.ts, "opposite_signal");
      closed.push(c);
    }

    // Don't stack same-side positions beyond the per-symbol cap.
    const sameSymbolOpen = this.open.filter((p) => p.symbol === signal.symbol);
    if (sameSymbolOpen.length >= MAX_OPEN_PER_SYMBOL) {
      return { closed: closed.length ? closed : undefined };
    }

    const pos: PaperPosition = {
      id: randomUUID(),
      symbol: signal.symbol,
      side: signal.action,
      entryPrice: price,
      openedAt: signal.ts,
      stake: DEFAULT_STAKE,
      detector: signal.detector,
    };
    this.open.push(pos);
    return { opened: pos, closed: closed.length ? closed : undefined };
  }

  onTick(tick: Tick): ClosedPaperPosition[] {
    const closed: ClosedPaperPosition[] = [];
    for (const pos of [...this.open]) {
      if (pos.symbol !== tick.symbol) continue;
      const move = (tick.quote - pos.entryPrice) / pos.entryPrice;
      const signed = pos.side === "BUY" ? move : -move;
      if (signed >= TP_PCT) closed.push(this.closePosition(pos, tick.quote, tick.epoch * 1000, "tp"));
      else if (signed <= -SL_PCT) closed.push(this.closePosition(pos, tick.quote, tick.epoch * 1000, "sl"));
    }
    return closed;
  }

  closeAllForSymbol(symbol: SymbolCode, price: number, ts: number): ClosedPaperPosition[] {
    const closed: ClosedPaperPosition[] = [];
    for (const pos of [...this.open]) {
      if (pos.symbol !== symbol) continue;
      closed.push(this.closePosition(pos, price, ts, "manual"));
    }
    return closed;
  }

  closeById(id: string, price: number, ts: number): ClosedPaperPosition | null {
    const pos = this.open.find((p) => p.id === id);
    if (!pos) return null;
    return this.closePosition(pos, price, ts, "manual");
  }

  private closePosition(pos: PaperPosition, exitPrice: number, closedAt: number, reason: ClosedPaperPosition["exitReason"]): ClosedPaperPosition {
    const move = (exitPrice - pos.entryPrice) / pos.entryPrice;
    const pnlPct = pos.side === "BUY" ? move : -move;
    const c: ClosedPaperPosition = {
      ...pos,
      closedAt,
      exitPrice,
      pnlPct,
      pnl: pos.stake * pnlPct,
      exitReason: reason,
    };
    this.open = this.open.filter((p) => p.id !== pos.id);
    this.closed.unshift(c);
    if (this.closed.length > HISTORY_LIMIT) this.closed.length = HISTORY_LIMIT;
    return c;
  }

  state(): PaperState {
    return {
      open: this.open,
      closed: this.closed,
      stats: this.stats(),
    };
  }

  private stats(): PaperStats {
    const totalClosed = this.closed.length;
    const wins = this.closed.filter((c) => c.pnlPct > 0).length;
    const losses = totalClosed - wins;
    const totalPnl = this.closed.reduce((s, c) => s + c.pnl, 0);
    const totalPnlPct = this.closed.reduce((s, c) => s + c.pnlPct, 0);
    return {
      totalClosed,
      wins,
      losses,
      winRate: totalClosed > 0 ? wins / totalClosed : 0,
      totalPnl,
      totalPnlPct,
      openCount: this.open.length,
    };
  }
}

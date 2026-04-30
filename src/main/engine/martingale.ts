// Martingale stake escalator for the fast-trade sandbox.
//
// Classic 2x-on-loss / reset-on-win with two safety mechanisms:
//   1. Hard ladder cap (maxLevels) — after N consecutive losses, force a
//      circuit-breaker reset so the next stake returns to base. Prevents
//      runaway stake growth on a bad streak.
//   2. Per-trade dollar cap (perTradeCap) — applied after the multiplier so
//      no single trade ever exceeds the cap regardless of where on the
//      ladder we are. Independent of strategy params.
//
// State is per-strategy (each fast strategy maintains its own ladder) so a
// loss streak on CRASH500N doesn't escalate stake on BOOM300N.

export type MartingaleState = {
  /** Consecutive-loss counter. 0 after a win or after circuit-breaker reset. */
  level: number;
  /** Cumulative dollar P&L since the last circuit-breaker reset. Negative
   *  during a loss streak; reset to 0 when level → 0. */
  cumulativeSinceReset: number;
  /** Timestamp (ms) of the last circuit-breaker fire, or 0 if none yet. */
  lastCircuitBreakerAt: number;
  /** Total wins / losses recorded — telemetry only, doesn't affect math. */
  wins: number;
  losses: number;
  /** Total circuit-breaker resets — telemetry only. */
  circuitBreakers: number;
};

export type MartingaleParams = {
  /** Stake at level 0. */
  baseStake: number;
  /** Per-loss multiplier applied to stake. 2.0 = classic, 2.2 covers spread. */
  multiplier: number;
  /** Maximum ladder depth. After this many consec losses, force a reset and
   *  start fresh at baseStake. */
  maxLevels: number;
  /** Hard cap on any single trade's stake (after multiplier applied). */
  perTradeCap: number;
};

export const DEFAULT_FAST_MARTINGALE: MartingaleParams = {
  baseStake: 0.5,
  multiplier: 2.2,
  maxLevels: 5,
  perTradeCap: 30,
};

export function emptyMartingaleState(): MartingaleState {
  return {
    level: 0,
    cumulativeSinceReset: 0,
    lastCircuitBreakerAt: 0,
    wins: 0,
    losses: 0,
    circuitBreakers: 0,
  };
}

/**
 * Compute the next trade's stake from the current ladder level. Does NOT
 * mutate state — caller is responsible for calling updateAfter* after the
 * trade settles to advance the ladder.
 */
export function nextStake(state: MartingaleState, params: MartingaleParams): number {
  const raw = params.baseStake * Math.pow(params.multiplier, state.level);
  const capped = Math.min(raw, params.perTradeCap);
  return Math.round(capped * 100) / 100;
}

/**
 * Advance state after a trade settles. Returns the new state plus a flag
 * indicating whether the circuit breaker fired.
 */
export function updateAfterTrade(
  state: MartingaleState,
  pnl: number,
  params: MartingaleParams,
  nowMs: number = Date.now(),
): { state: MartingaleState; circuitBreakerFired: boolean } {
  const next: MartingaleState = { ...state };
  const won = pnl > 0;
  next.cumulativeSinceReset += pnl;
  if (won) {
    next.wins++;
    next.level = 0;
    next.cumulativeSinceReset = 0;
    return { state: next, circuitBreakerFired: false };
  }
  next.losses++;
  next.level++;
  if (next.level >= params.maxLevels) {
    // Circuit breaker — reset ladder and record the event.
    next.level = 0;
    next.cumulativeSinceReset = 0;
    next.circuitBreakers++;
    next.lastCircuitBreakerAt = nowMs;
    return { state: next, circuitBreakerFired: true };
  }
  return { state: next, circuitBreakerFired: false };
}

/**
 * Human-readable summary for the heartbeat / UI.
 */
export function describeMartingale(state: MartingaleState, params: MartingaleParams): string {
  const stakeNow = nextStake(state, params);
  return `lvl=${state.level}/${params.maxLevels} stake=$${stakeNow.toFixed(2)} W=${state.wins} L=${state.losses} CB=${state.circuitBreakers}`;
}

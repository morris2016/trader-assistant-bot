import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import type { Candle, LiquidityPool, Signal } from "@shared/types";
import { detectSwings, latestAtr } from "../indicators";

/**
 * Liquidity Sweep / Stop Hunt detector (SMC).
 *
 * Pool definition:
 *   ≥ `minEqualCount` swing highs/lows within `equalToleranceAtrMul × ATR(14)`
 *   of each other, detected inside the last `lookbackBars`.
 *
 * Sweep event:
 *   Current bar's wick pokes beyond the pool (high > EQH or low < EQL)
 *   AND the bar's close comes back past the pool level.
 *
 * Entry signal (confirmation):
 *   Within the next `confirmationWindow` bars AFTER a sweep, a bar closes
 *   beyond the rejection bar's body in the direction of the reversal.
 *   For an EQH sweep, confirmation = close below the sweep bar's low.
 *   For an EQL sweep, confirmation = close above the sweep bar's high.
 *
 * Output events:
 *   • liquidityPools: new pools formed this bar
 *   • liquidityPoolsSwept: pools that got swept this bar (drawn with arrow)
 *   • liquidityPoolsRemoved: pools whose usefulness has expired (age out)
 *   • signals: BUY/SELL on confirmation
 */

type PendingSweep = {
  poolId: string;
  side: "EQH" | "EQL";
  sweepBarEpoch: number;
  sweepBarIdx: number;
  sweepBarHigh: number;
  sweepBarLow: number;
};

type LiqState = {
  pools: Map<string, LiquidityPool>;
  pendingSweeps: PendingSweep[];
  /** Hashes of swing-index clusters already materialised as pools so we don't duplicate. */
  seenClusters: Set<string>;
};

const STATE_KEY = "liquiditySweep";

function stateFor(ctx: DetectorContext): LiqState {
  let s = ctx.state[STATE_KEY] as LiqState | undefined;
  if (!s) {
    s = { pools: new Map(), pendingSweeps: [], seenClusters: new Set() };
    ctx.state[STATE_KEY] = s;
  }
  return s;
}

export const liquiditySweep: Detector = {
  id: "liquiditySweep",
  label: "Liquidity Sweep (SMC)",
  defaultParams: {
    atrPeriod: 14,
    equalToleranceAtrMul: 0.1,     // equal if |p1 − p2| ≤ 0.1 × ATR
    minEqualCount: 2,
    lookbackBars: 50,
    confirmationWindow: 3,         // bars after sweep to see confirmation
    poolRetentionBarsAfterSweep: 20, // how long to keep a swept pool drawn
    swingLeft: 2,
    swingRight: 2,
    targetRMult: 3.0,              // R-multiple of structural stop distance for TP
    entryOnSweep: 0,               // 0 = wait for confirmation (legacy), 1 = enter at sweep bar close (ICT-style)
    stopBufferAtrMul: 0.1,         // buffer past the sweep wick before the structural stop
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const candles = ctx.candles;
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const tolMul = ctx.params.equalToleranceAtrMul ?? 0.1;
    const minEqual = Math.max(2, Math.floor(ctx.params.minEqualCount ?? 2));
    const lookback = ctx.params.lookbackBars ?? 50;
    const confWindow = ctx.params.confirmationWindow ?? 3;
    const retentionBars = ctx.params.poolRetentionBarsAfterSweep ?? 20;
    const swLeft = ctx.params.swingLeft ?? 2;
    const swRight = ctx.params.swingRight ?? 2;

    if (candles.length < Math.max(atrPeriod, lookback) + swLeft + swRight + 2) {
      return { signals: [] };
    }

    const atr = latestAtr(candles, atrPeriod);
    if (atr <= 0) return { signals: [] };

    const tolerance = tolMul * atr;
    const s = stateFor(ctx);
    const currIdx = candles.length - 1;
    const curr = candles[currIdx];

    const out: DetectorOutput = {
      signals: [],
      liquidityPools: [],
      liquidityPoolsSwept: [],
      liquidityPoolsRemoved: [],
    };

    // --- 1. Detect new pools from recent swing clusters --------------------
    const windowStart = Math.max(0, currIdx - lookback);
    const swings = detectSwings(candles.slice(windowStart), swLeft, swRight)
      .map((sw) => ({ ...sw, globalIdx: sw.index + windowStart }));

    // Pools of equal highs
    for (const seed of swings) {
      if (seed.kind !== "high") continue;
      const cluster = swings.filter(
        (sw) => sw.kind === "high" && Math.abs(sw.price - seed.price) <= tolerance,
      );
      if (cluster.length < minEqual) continue;
      const clusterIds = cluster.map((c) => c.globalIdx).sort((a, b) => a - b);
      const hash = `H:${clusterIds.join(",")}`;
      if (s.seenClusters.has(hash)) continue;
      s.seenClusters.add(hash);

      const price = Math.max(...cluster.map((c) => c.price));
      const pool: LiquidityPool = {
        id: randomUUID(),
        symbol: ctx.symbol,
        side: "EQH",
        price,
        firstEpoch: cluster[0].epoch,
        lastEpoch: cluster[cluster.length - 1].epoch,
        taps: cluster.length,
        sweptEpoch: null,
      };
      s.pools.set(pool.id, pool);
      out.liquidityPools!.push(pool);
    }

    // Pools of equal lows
    for (const seed of swings) {
      if (seed.kind !== "low") continue;
      const cluster = swings.filter(
        (sw) => sw.kind === "low" && Math.abs(sw.price - seed.price) <= tolerance,
      );
      if (cluster.length < minEqual) continue;
      const clusterIds = cluster.map((c) => c.globalIdx).sort((a, b) => a - b);
      const hash = `L:${clusterIds.join(",")}`;
      if (s.seenClusters.has(hash)) continue;
      s.seenClusters.add(hash);

      const price = Math.min(...cluster.map((c) => c.price));
      const pool: LiquidityPool = {
        id: randomUUID(),
        symbol: ctx.symbol,
        side: "EQL",
        price,
        firstEpoch: cluster[0].epoch,
        lastEpoch: cluster[cluster.length - 1].epoch,
        taps: cluster.length,
        sweptEpoch: null,
      };
      s.pools.set(pool.id, pool);
      out.liquidityPools!.push(pool);
    }

    const entryOnSweep = (ctx.params.entryOnSweep ?? 0) >= 1;

    // --- 2. Detect sweeps on the current bar -------------------------------
    for (const pool of s.pools.values()) {
      if (pool.sweptEpoch != null) continue;

      let swept: "EQH" | "EQL" | null = null;
      if (pool.side === "EQH" && curr.high > pool.price && curr.close < pool.price) swept = "EQH";
      else if (pool.side === "EQL" && curr.low < pool.price && curr.close > pool.price) swept = "EQL";
      if (!swept) continue;

      pool.sweptEpoch = curr.epoch;
      out.liquidityPoolsSwept!.push({ id: pool.id, sweptEpoch: curr.epoch });
      const ps: PendingSweep = {
        poolId: pool.id,
        side: swept,
        sweepBarEpoch: curr.epoch,
        sweepBarIdx: currIdx,
        sweepBarHigh: curr.high,
        sweepBarLow: curr.low,
      };

      if (entryOnSweep) {
        // ICT-style: the sweep bar itself is the rejection — fire immediately.
        // The sweep bar already closed back through the pool, which is the
        // textbook signal. Stop sits at the sweep wick + buffer.
        out.signals.push(makeSignal(ctx, curr, ps, atr));
      } else {
        s.pendingSweeps.push(ps);
      }
    }

    // --- 3. Check pending sweeps for confirmation --------------------------
    const stillPending: PendingSweep[] = [];
    for (const ps of s.pendingSweeps) {
      const barsSince = currIdx - ps.sweepBarIdx;

      if (barsSince === 0) {
        // Don't confirm on the sweep bar itself — wait for the next.
        stillPending.push(ps);
        continue;
      }

      let confirmed = false;
      if (ps.side === "EQH" && curr.close < ps.sweepBarLow) confirmed = true;
      if (ps.side === "EQL" && curr.close > ps.sweepBarHigh) confirmed = true;

      if (confirmed) {
        out.signals.push(makeSignal(ctx, curr, ps, atr));
        continue; // drop from pending
      }

      if (barsSince < confWindow) {
        stillPending.push(ps);
      }
      // else: confirmation window lapsed — drop without signal
    }
    s.pendingSweeps = stillPending;

    // --- 4. Expire stale pools (age-out after sweep) -----------------------
    for (const pool of [...s.pools.values()]) {
      if (pool.sweptEpoch != null) {
        const ageBars = secondsDiffBars(candles, pool.sweptEpoch, curr.epoch);
        if (ageBars >= retentionBars) {
          s.pools.delete(pool.id);
          out.liquidityPoolsRemoved!.push(pool.id);
        }
      }
    }

    return out;
  },
};

function makeSignal(ctx: DetectorContext, curr: Candle, ps: PendingSweep, atr: number): Signal {
  const action = ps.side === "EQH" ? "SELL" : "BUY";
  // Structural stop: just past the sweep bar's wick — where the rejection
  // would be invalidated. This is the SMC-canonical stop placement and
  // matches what we did for OB.
  const buffer = atr * (ctx.params.stopBufferAtrMul ?? 0.1);
  const targetRMult = ctx.params.targetRMult ?? 3.0;
  const entry = curr.close;
  const stopPrice = ps.side === "EQH"
    ? ps.sweepBarHigh + buffer
    : ps.sweepBarLow - buffer;
  const stopDist = Math.abs(entry - stopPrice);
  const targetPrice = action === "BUY"
    ? entry + targetRMult * stopDist
    : entry - targetRMult * stopDist;

  return {
    id: randomUUID(),
    ts: curr.epoch * 1000,
    symbol: ctx.symbol,
    detector: "liquiditySweep",
    action,
    confidence: 0.7,
    reason:
      ps.side === "EQH"
        ? "EQH swept — bearish rejection confirmed"
        : "EQL swept — bullish rejection confirmed",
    price: entry,
    stopPrice,
    targetPrice,
  };
}

function secondsDiffBars(candles: Candle[], fromEpoch: number, toEpoch: number): number {
  // Approximate bar delta using candle granularity from the last two closes.
  if (candles.length < 2) return 0;
  const granularity = candles[candles.length - 1].epoch - candles[candles.length - 2].epoch;
  if (granularity <= 0) return 0;
  return Math.floor((toEpoch - fromEpoch) / granularity);
}

import { randomUUID } from "node:crypto";
import type { Detector, DetectorContext, DetectorOutput } from "./types";
import { latestAtr } from "../indicators";

/**
 * Spike-Fade detector — high-frequency edge on Deriv Boom/Crash synthetics.
 *
 * Pattern:
 *   • Bar i (the "spike bar") has range = high − low ≥ spikeNAtr × ATR(i−1).
 *   • Bar i+1 (the "confirmation bar") closes within the spike's [low, high]
 *     range — i.e. the spike didn't continue.
 *   • On bar i+1 close, fade the spike: SELL if spike was up, BUY if down.
 *
 * Levels:
 *   • Stop at spike.high + bufferAtrMul × ATR (for SELL), or
 *     spike.low − bufferAtrMul × ATR (for BUY).
 *   • Target at entry ± tpFracOfSpike × spike_range. tpFracOfSpike < 1 means
 *     we exit before the full spike has been faded.
 *
 * Validated 2026-04-30 via 17-day historical backtest on Deriv synthetics:
 *   • BOOM300N 1m (n=3.0, buf=0.2, tpFrac=0.5, conf=1): 1670 trades / 17.4d,
 *     WR 56%, expR +0.36, +$749 at $50/30× — STABLE across both halves.
 *   • CRASH300N 1m (same params): 1687 trades / 17.4d, WR 56%, expR +0.39,
 *     +$849 at $50/30× — STABLE.
 *
 * Note: this detector emits explicit signal.stopPrice and signal.targetPrice
 * derived from the spike's geometry, NOT from ATR multiples. The caller MUST
 * use these structural levels (paper-engine + real both honour them since the
 * 2026-04-30 fix).
 */
export const spikeFade: Detector = {
  id: "spikeFade",
  label: "Spike Fade",
  defaultParams: {
    atrPeriod: 14,
    spikeNAtr: 3.0,           // bar range ≥ this × ATR(i-1) qualifies as spike
    bufferAtrMul: 0.2,        // SL = spike.high/low ± buffer × ATR
    tpFracOfSpike: 0.5,       // TP at entry ± tpFrac × spike_range
    requireConfirmation: 1,   // 0 = fade on the spike bar itself; 1 = wait one bar (validated)
  },

  onClose(ctx: DetectorContext): DetectorOutput {
    const atrPeriod = ctx.params.atrPeriod ?? 14;
    const spikeNAtr = ctx.params.spikeNAtr ?? 3.0;
    const bufferAtrMul = ctx.params.bufferAtrMul ?? 0.2;
    const tpFracOfSpike = ctx.params.tpFracOfSpike ?? 0.5;
    const requireConfirmation = (ctx.params.requireConfirmation ?? 1) >= 1;
    const candles = ctx.candles;
    if (candles.length < atrPeriod + 3) return { signals: [] };

    // The current bar is candles[len-1]. With confirmation, it's the
    // confirmation bar and the spike was at len-2. Without confirmation,
    // the current bar is the spike itself.
    const lastIdx = candles.length - 1;
    const spikeIdx = requireConfirmation ? lastIdx - 1 : lastIdx;
    if (spikeIdx < 1) return { signals: [] };
    const spike = candles[spikeIdx];
    const range = spike.high - spike.low;

    // ATR sampled at the bar BEFORE the spike — so the threshold isn't
    // contaminated by the spike's own range.
    const priorAtr = latestAtr(candles.slice(0, spikeIdx), atrPeriod);
    if (priorAtr <= 0) return { signals: [] };
    if (range < spikeNAtr * priorAtr) return { signals: [] };

    const conf = candles[lastIdx];
    if (requireConfirmation) {
      const closedInside = conf.close <= spike.high && conf.close >= spike.low;
      if (!closedInside) return { signals: [] };
    }

    const dirUp = spike.close >= spike.open;
    const fadeSide: "BUY" | "SELL" = dirUp ? "SELL" : "BUY";

    const buffer = bufferAtrMul * priorAtr;
    const entry = conf.close;
    let stopPrice: number;
    let targetPrice: number;
    if (fadeSide === "SELL") {
      stopPrice = spike.high + buffer;
      targetPrice = entry - tpFracOfSpike * range;
      if (stopPrice <= entry || targetPrice >= entry) return { signals: [] };
    } else {
      stopPrice = spike.low - buffer;
      targetPrice = entry + tpFracOfSpike * range;
      if (stopPrice >= entry || targetPrice <= entry) return { signals: [] };
    }

    return {
      signals: [
        {
          id: randomUUID(),
          ts: conf.epoch * 1000,
          symbol: ctx.symbol,
          detector: "spikeFade",
          action: fadeSide,
          confidence: 0.6,
          reason: `Spike ${dirUp ? "up" : "down"} faded — range ${range.toFixed(2)} ≥ ${spikeNAtr}×ATR ${priorAtr.toFixed(2)}`,
          price: entry,
          stopPrice,
          targetPrice,
        },
      ],
    };
  },
};

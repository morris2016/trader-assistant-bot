import { defaultDetectorConfigs } from "../runner";
import type { StrategyDescriptor } from "./types";

/**
 * Silver Fair Value Gap — institutional-grade imbalance retest.
 *
 * Only takes FVGs whose gap height is ≥ 0.7×ATR — i.e. genuinely large
 * 3-bar imbalances that signal institutional-scale displacement, not the
 * micro-gaps that dominate normal price action. Entry on first re-touch of
 * the gap edge; structural stop just past the far edge of the gap (full gap
 * fill = thesis invalidated). 3:1 R:R via R-multiple TP.
 *
 * Highest-edge Silver strategy validated to date: 51 trades, 55% WR,
 * +0.73R per trade, +$1349.47 USD over ~125 days at $50 × 30× MULT.
 *
 * Like Silver-Sweep, FVG works only at 1h TF — 5m and 15m bleed money on
 * every variant. Unlike OB or Sweep, FVG appears regime-agnostic: ADX gates
 * (maxAdx, minAdx, with-trend) all degrade or barely improve outcomes vs the
 * unfiltered variant. The quality filter (minGap=0.7) IS the primary gate.
 *
 * Validated 2026-04-26.
 */
export const silverFvg: StrategyDescriptor = {
  id: "silver_fvg",
  name: "Silver FVG — institutional imbalance retest",
  description:
    "Only the largest 3-bar FVGs (gap ≥ 0.7×ATR) get traded on Silver / USD at 1h. " +
    "Entry on first retest of gap edge; structural stop past the far gap edge; 3:1 R:R. " +
    "Quality filter is the discriminator — no ADX gate needed.",

  symbols: ["frxXAGUSD"],
  granularity: 3600, // 1h

  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "fvg",
    params: d.id === "fvg"
      ? {
          atrPeriod: 14,
          minGapAtrMul: 0.7,        // institutional-grade gap filter
          maxActive: 12,
          targetRMult: 3.0,
          entryDepth: 0,            // edge entry (first touch)
          stopBufferAtrMul: 0.1,
          requireRejection: 0,
        }
      : d.params,
  })),

  atrSlMult: 1.0, // fallback only — FVG emits structural stop
  atrTpMult: 3.0,
  costBps: 5.0,

  validation: {
    validatedAt: "2026-04-26",
    sampleDays: 125,
    trades: 51,
    winRate: 0.55,
    expectancyR: 0.73,
    pnlUsd: 1349.47,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ CROSS-VALIDATED 2026-04-27 — STRONG. 3-window methodology: W0 +$324/32t/56% WR, TRAIN +$1,238/38t/58%, TEST +$46/11t/45%. All windows positive. Highest TRAIN $ in registry.",
      "Original FVG detector with no structural stops bled −$436 over 462 trades on Silver. Adding wick-based structural stops + R:R config + entry-depth control + auto-mitigation-on-fire flipped it to consistently positive across all 1h variants.",
      "5m and 15m TFs: every variant lost money. Same pattern as Sweep — these structural detectors need 1h bars.",
      "minGap sweep is monotonic: 0.35→+0.16R, 0.4→+0.22R, 0.5→+0.32R, 0.6→+0.33R, 0.7→+0.73R (winner), 1.0→+1.06R but only 27 trades. Quality filter, not curve-fit.",
      "ADX gates barely move the needle on FVG (regime-agnostic): maxAdx=22 → −0.29R / 18 trades. minAdx=22 → +0.40R / 62 trades (slight degradation from baseline +0.73R). Don't add an ADX gate; the gap-size filter does the quality work.",
      "Entry-depth: edge (first touch) wins by $. CE entry tightens stop but cuts $ in half due to smaller per-trade exposure on Silver. far-edge entry is too rare. Default edge.",
      "R:R sweep at minGap=0.5: 2:1→+0.22R, 3:1→+0.32R, 4:1→+0.36R, 5:1→+0.38R, 6:1→+0.49R. Higher R:R works but with marginal gains. 3:1 is the sweet spot for stable expectancy.",
      "requireRejection filter: cuts trades to 20 (below threshold) but pushes expectancy to +0.46R. Skip — sample too small to trust.",
      "Detector bug fix during this iteration: marking blocks as mitigated immediately when signal fires (was previously firing duplicate signals on consecutive retest bars).",
      "5.5-MONTH LONG-RUN CONFIRMATION (2026-04-26): 81 trades, 56% WR, +$1,528.75 USD over 144 trading days (1h history depth, Nov 2025 → Apr 2026). Largest individual contributor to the Silver portfolio.",
    ],
  },
};

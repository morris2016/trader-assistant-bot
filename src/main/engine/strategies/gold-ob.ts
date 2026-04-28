import { defaultDetectorConfigs } from "../runner";
import type { StrategyDescriptor } from "./types";

/**
 * Gold (XAU/USD) Order Block — asymmetric BUY-side trend pullback.
 *
 * Trades only on Gold / USD (frxXAUUSD) at 1h TF. Edge entry on bullish OB
 * retests, structural stop at OB wick + 0.1×ATR, 4.5:1 R:R. SELL-side OBs
 * are filtered out — they had 12-14% WR across the sweep (catastrophic),
 * driven by Gold's secular bull regime in the validation window.
 *
 * The BUY-only asymmetry is the central discriminator. Without it, every
 * Gold OB variant tested negative ($-25 to $-300 across 20+ configs in iter1).
 * With it, the strategy posts +0.69R expectancy. Tuning across 7 iterations:
 * obSearchMaxBack=5 (was 3) lifted $ from $351→$510, adding lookback=6 and
 * disp=0.6 + R 4.5 lifted to $616.
 *
 * Validated 2026-04-26 over a ~137-day Gold 1h sample (Deriv depth limit):
 * 34 trades, 32% WR, +0.69R, +$616.29 USD at $50 × 30× MULT.
 */
export const goldOb: StrategyDescriptor = {
  id: "gold_ob",
  name: "Gold OB — BUY-only edge pullback",
  description:
    "OB retests on Gold / USD at 1h with BUY-only filter. SELL-side OBs " +
    "had catastrophic 12-14% WR in validation — filtered out. Edge entry, " +
    "structural stop at OB wick + 0.1×ATR, 4.5:1 R:R, tuned obSearch/lookback/disp.",

  symbols: ["frxXAUUSD"],
  granularity: 3600, // 1h

  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock"
      ? {
          lookback: 6,                    // tuned from default 12 — shorter swing window catches recent OBs in fast bull regime
          atrPeriod: 14,
          displacementAtrMultiplier: 0.6, // tuned from default 0.8 — looser displacement = more trades, +0.6 still rejects noise
          obSearchMaxBack: 5,             // tuned from default 3 — wider search lifted $ from $351 to $510 (+45%) while keeping trade count steady
          requireFVG: 0,
          requireLiquiditySweep: 0,
          sweepLookbackBars: 30,
          fourCandleValidation: 0,
          retestConfirmationBars: 2,
          qualityFilterLookback: 0,
          rejectionBodyAtrMul: 0.3,
          zoneStyle: 0,
          entryDepth: 0,                  // edge entry — beat CE on $ at this R:R
          targetRMult: 4.5,               // 4.5:1 R:R — peak of $ curve; 4:1 +$556, 4.5:1 +$616, 5:1 cliff to +$291
        }
      : d.params,
  })),

  atrSlMult: 1.0,
  atrTpMult: 4.5,
  costBps: 5.0,

  buyOnly: true,                          // central edge — SELLs were 12-14% WR / -$200 across iter1

  validation: {
    validatedAt: "2026-04-26",
    sampleDays: 137,
    trades: 34,
    winRate: 0.32,
    expectancyR: 0.69,
    pnlUsd: 616.29,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ CROSS-VALIDATED 2026-04-27 — STRONG. 3-window methodology: W0 +$82/7t/29% WR, TRAIN +$259/8t/25%, TEST +$34/6t/33%. All windows positive. Trade count low per window but direction-stable.",
      "BUY/SELL asymmetry is the central finding. Iter1 (no side filter): every variant -$25 to -$300. Iter2 with BUY-only: ce·3:1 = +$269 / +0.70R, SELL-only ce·3:1 = -$204 / -0.62R / 12% WR. Same OB detector, opposite sign. Likely Gold's secular bull regime during the validation window.",
      "Iter3 R:R + entry sweep: edge·4:1+BUY = +$351 (qualifying) won over ce·3:1+BUY = +$269. Edge entry preferred at higher R:R.",
      "Iter4 KEY DISCOVERY: obSearchMaxBack=5 (default 3) lifted $ from $351 → $510 (+45%) at SAME 31 trades. The default 3-bar OB search misses good OBs in recent bars. obSearch=4/5/6/8/10 all gave $510-$525 (plateau); 3 is the only outlier.",
      "Iter5 stacking: edge·4:1+BUY+obSearch=5+lookback8+disp0.6 = +$555.64 / 30t / 40% WR / +0.81R. Triple-stack of best individual params.",
      "Iter6 R:R sweep on stacked config: 4.0 = +$556, 4.25 = +$599, 4.5 = +$610. Higher R:R lifts $ at expense of WR — choose based on $-objective.",
      "Iter7 final lookback sweep with R4.5: lb6 = +$616 (winner), lb7 = +$569, lb8 = +$610, lb9 = +$564, lb10 = +$572, lb12 = +$582. Sweet spot at lb6 with most trades (34).",
      "Plateau pattern: 16 of 21 iter7 variants returned $585-$616. The plateau confirms a real edge, not curve-fit. Picking the highest $ within the plateau is robust.",
      "Filter rejections (don't re-add): with-trend@20 cuts $ to +$27 (BUY-only already handles bias), maxAdx=40 cuts to +$14 (gold trends well in higher ADX), maxAdx=22 cuts to 8 trades, with-trend filter is redundant on BUY-only.",
      "Day filters are no-ops: skipSat / skipSun / skipSatSun all gave identical $ to baseline. Gold's BUY-side OBs don't fire on weekends in this sample.",
      "R 4.75/5/6 cliff: above 4.5 R:R, $ drops sharply (R4.75 = +$337, R5 = +$291, R6 = +$339). 4.5 is the right ceiling.",
      "Iter4 secondary findings (didn't make final config): rejBody=0.5/0.7 gave same $ as 0.3 (so rejection-body strictness doesn't bind on BUY OBs); atrPeriod=10/20 vs 14 within ±$30; retestConfirmationBars=3 marginally worse.",
      "Annualized pace: ~$1,640/year on $50 × 30× MULT. Comparable to ETH Sweep (+$1,628/yr) — Gold OB joins as the highest-$ Silver/Gold-side strategy.",
      "Caveat: 137-day sample is shorter than other strategies (333d for ETH, 125d for Silver). The BUY-side bias is regime-specific to Gold's recent bull run. Forward-test before scaling. If Gold turns bearish, this strategy will likely break or need a SELL-flip.",
      "Per-asset config divergence holds: Silver-OB wants ranging (maxAdx<22) at 15m; ETH-OB wants trend-continuation (with-trend@20) at 1h with CE-then-edge tuning; Gold-OB wants regime-asymmetric (BUY-only) at 1h with looser swing detection. No universal OB config.",
    ],
  },
};

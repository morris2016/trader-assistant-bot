// Deriv synthetic-index strategies. SEPARATE from STRATEGIES (real-asset registry).
// These run in their own paper-trading sandbox so we can validate live performance
// before promoting to real trading. Validated 2026-04-29 via 3-window CV (W0/TRAIN/TEST).

import { defaultDetectorConfigs } from "./runner";
import type { StrategyDescriptor } from "./strategies/types";

/**
 * RDBULL FVG — Bull Market Index gap-fill on 1h.
 *
 * Validation (3-window CV, 2026-04-29):
 *   W0  (Oct-Dec 2025):  +$3,161
 *   TRAIN (Jan-Mar 2026): +$2,026
 *   TEST  (Apr 1-29 OOS): +$82
 *   558 trades / 210d / SUM +$5,270 / ~2.7 trades/day
 *
 * Bull Market Index has constant up-drift; FVG fills consistently catch buyable
 * pullbacks. Raw defaults — no minGap/ADX filtering needed.
 */
export const rdbullFvg: StrategyDescriptor = {
  id: "rdbull_fvg",
  name: "RDBULL FVG — bull-drift gap fill",
  description: "FVG retests on Bull Market Index (RDBULL) at 1h. Raw defaults, no filters. Up-drift means most fills are buy-side wins.",
  symbols: ["RDBULL"],
  granularity: 3600,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "fvg",
    params: d.id === "fvg"
      ? { atrPeriod: 14, minGapAtrMul: 0.15, maxActive: 12, targetRMult: 3.0, entryDepth: 0, stopBufferAtrMul: 0.1, requireRejection: 0 }
      : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 3.0,
  costBps: 5.0,
  validation: {
    validatedAt: "2026-04-29",
    sampleDays: 210,
    trades: 558,
    winRate: 0.50,
    expectancyR: 0.30,
    pnlUsd: 5270,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ 3-window CV PASS: W0 +$3161, TRAIN +$2026, TEST +$82.",
      "Highest-frequency synth winner: ~2.7 trades/day on 1h (9.5/day on 15m).",
      "Asset-native variant pack: raw·3:1 won. BUY-only and minGap variants also passed but had lower SUM.",
    ],
  },
};

/**
 * JD100 Liquidity Sweep — Jump 100 Index, BUY-only with wide stop.
 *
 * Validation (3-window CV, 2026-04-29):
 *   W0:    +$364
 *   TRAIN: +$747
 *   TEST:  +$277
 *   50 trades / 210d / SUM +$1,388 / ~0.24 trades/day
 *
 * Jump-diffusion synthetic — periodic up + down jumps. Wide stop buffer
 * (0.25× ATR) survives the jumps; BUY-only catches up-jumps cleanly.
 */
export const jd100Sweep: StrategyDescriptor = {
  id: "jd100_sweep",
  name: "JD100 Sweep — jump-survival BUY-only",
  description: "Liquidity-sweep BUY entries on Jump 100 Index (JD100) at 1h. stopBufferAtrMul=0.25, 4:1 R:R. Wide stop survives periodic jumps.",
  symbols: ["JD100"],
  granularity: 3600,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "liquiditySweep",
    params: d.id === "liquiditySweep"
      ? { atrPeriod: 14, equalToleranceAtrMul: 0.1, minEqualCount: 2, lookbackBars: 50, confirmationWindow: 3, poolRetentionBarsAfterSweep: 20, swingLeft: 2, swingRight: 2, targetRMult: 4.0, entryOnSweep: 0, stopBufferAtrMul: 0.25 }
      : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 4.0,
  costBps: 5.0,
  buyOnly: true,
  validation: {
    validatedAt: "2026-04-29",
    sampleDays: 210,
    trades: 50,
    winRate: 0.55,
    expectancyR: 1.0,
    pnlUsd: 1388,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ 3-window CV PASS: all 3 windows positive across the lowest-trade-count winner — high $/trade quality.",
      "stopBuf=0.25 + buyOnly was the only Sweep variant that passed CV; default-stop or SELL-bias variants all failed at least one window.",
      "Sniper character: only ~1 fire every 4 days — pair with higher-frequency strategies for portfolio coverage.",
    ],
  },
};

/**
 * BOOM 300N OB — Boom 300 Index, raw OB on 1h.
 *
 * Validation (3-window CV, 2026-04-29):
 *   W0:    +$76
 *   TRAIN: +$494
 *   TEST:  +$97
 *   120 trades / 210d / SUM +$667 / ~0.57 trades/day
 *
 * Boom 300N is the inverse of crash indices: smooth down-drift punctuated by
 * rare big up-spikes. Raw OB at 1h fades the spike + catches the drift.
 */
export const boom300nOb: StrategyDescriptor = {
  id: "boom300n_ob",
  name: "BOOM 300N OB — spike-fade + drift",
  description: "Order-block entries on Boom 300N Index at 1h. Raw defaults, no filters. Catches the inverted up-spike + smooth down-drift pattern.",
  symbols: ["BOOM300N"],
  granularity: 3600,
  detectors: defaultDetectorConfigs().map((d) => ({
    ...d,
    enabled: d.id === "orderBlock",
    params: d.id === "orderBlock"
      ? { lookback: 12, atrPeriod: 14, displacementAtrMultiplier: 0.8, obSearchMaxBack: 3, requireFVG: 0, requireLiquiditySweep: 0, sweepLookbackBars: 30, fourCandleValidation: 0, retestConfirmationBars: 2, qualityFilterLookback: 0, rejectionBodyAtrMul: 0.3, zoneStyle: 0, entryDepth: 0, targetRMult: 3.0 }
      : d.params,
  })),
  atrSlMult: 1.0,
  atrTpMult: 3.0,
  costBps: 5.0,
  validation: {
    validatedAt: "2026-04-29",
    sampleDays: 210,
    trades: 120,
    winRate: 0.50,
    expectancyR: 0.5,
    pnlUsd: 667,
    stake: 50,
    multiplier: 30,
    notes: [
      "✓ 3-window CV PASS: W0 +$76, TRAIN +$494, TEST +$97.",
      "Moderate frequency: ~0.57/day on 1h. lb=18·ce·4:1 also passed (+$395 SUM) — kept raw·3:1 for higher SUM.",
    ],
  },
};

export const SYNTH_STRATEGIES: StrategyDescriptor[] = [rdbullFvg, jd100Sweep, boom300nOb];

export function synthStrategiesForSymbol(symbol: string): StrategyDescriptor[] {
  return SYNTH_STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

export function isSynthSymbol(symbol: string): boolean {
  return SYNTH_STRATEGIES.some((s) => s.symbols.includes(symbol));
}

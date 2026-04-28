import type { Candle, Signal, StrategyConfig } from "@shared/types";
import { latestRegime, type RegimeSample } from "./indicators";

export type StrategyInput = {
  config: StrategyConfig;
  // Newest bar first is NOT assumed — candles[0] is oldest.
  candles: Candle[];
  // Signals fired on the current (most recent) bar from all detectors.
  currentBarSignals: Signal[];
  // Per-detector signals from the last `confluenceWindowBars` bars,
  // keyed by detector id, containing the most recent signal from that detector.
  recentByDetector: Map<string, { signal: Signal; barIndex: number }>;
  // Index of the current bar.
  currentBarIndex: number;
};

export type StrategyDecision = {
  allowedSignals: Signal[];
  regime: RegimeSample;
  rejectionReason?: string;
};

export function applyStrategy(input: StrategyInput): StrategyDecision {
  const { config, candles, currentBarSignals, recentByDetector, currentBarIndex } = input;
  const regime = latestRegime(candles, config.adxThreshold);

  if (config.mode === "raw") {
    return { allowedSignals: currentBarSignals, regime };
  }

  // In confluence modes, only emit signals that are direction-aligned with
  // at least one OTHER detector within the confluence window.
  const windowBars = Math.max(1, config.confluenceWindowBars);
  const allowed: Signal[] = [];
  for (const sig of currentBarSignals) {
    let supportedBy = 0;
    for (const [detId, entry] of recentByDetector.entries()) {
      if (detId === sig.detector) continue;
      if (currentBarIndex - entry.barIndex > windowBars) continue;
      if (entry.signal.action === sig.action) supportedBy++;
    }
    if (supportedBy >= 1) allowed.push(sig);
  }

  if (config.mode === "confluence") {
    return { allowedSignals: allowed, regime };
  }

  // trend-confluence: additionally require the regime to be trending in the
  // direction of the signal.
  if (!regime.trending) {
    return { allowedSignals: [], regime, rejectionReason: `ADX ${regime.adx.toFixed(1)} < ${config.adxThreshold}` };
  }
  const dirAligned = allowed.filter(
    (s) => (s.action === "BUY" && regime.direction === "up") || (s.action === "SELL" && regime.direction === "down"),
  );
  return {
    allowedSignals: dirAligned,
    regime,
    rejectionReason: dirAligned.length < allowed.length ? "trend direction mismatch" : undefined,
  };
}

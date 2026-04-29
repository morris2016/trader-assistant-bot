// Control-experiment assets. These are SUBSCRIBED + run through engine + emit
// signals into recentSignals (visible in UI), but executeSignal blocks them
// from opening positions in either paper or real accounts. Purpose:
//   - Verify the full signal pipeline (subscribe → detector → emit → UI) works
//     end-to-end on a non-strategy asset
//   - Provide a "no-trade" baseline so we can compare expected fire rate vs actual
//   - Detect if a strategy/symbol mismatch is the cause of 0 signals
//
// Pick high-frequency synthetics so we get visible signal flow within minutes.

import { defaultDetectorConfigs } from "./runner";
import type { DetectorConfig } from "../../shared/types";

export type ControlAsset = {
  symbol: string;
  granularity: number;
  detectors: DetectorConfig[];
  /** Human-friendly label for UI / logs. */
  label: string;
};

// Loose detector configs — purpose is to fire SIGNALS, not edge. Looser FVG
// minGap (smaller gaps qualify), looser OB displacement, looser sweep
// equal-tolerance, plus 2:1 R:R (faster setups).
function looseDetectorConfigs(): DetectorConfig[] {
  return defaultDetectorConfigs().map((d) => {
    if (d.id === "fvg") {
      return {
        ...d,
        params: {
          ...d.params,
          minGapAtrMul: 0.03,             // tiny gaps qualify (default 0.15)
          targetRMult: 2.0,
          maxActive: 30,                  // keep more FVGs active for retests
          stopBufferAtrMul: 0.05,
          requireCameFromOutside: 0,      // fire on any touch — bypass strict ICT gate
        },
      };
    }
    if (d.id === "orderBlock") {
      return {
        ...d,
        params: {
          ...d.params,
          lookback: 6,                       // shorter lookback (default 12)
          displacementAtrMultiplier: 0.3,    // weaker displacement qualifies (default 0.8)
          obSearchMaxBack: 6,
          rejectionBodyAtrMul: 0.1,
          targetRMult: 2.0,
          retestConfirmationBars: 1,         // emit on 1st confirming bar instead of 2 (default 2)
        },
      };
    }
    if (d.id === "liquiditySweep") {
      return {
        ...d,
        params: {
          ...d.params,
          equalToleranceAtrMul: 0.30,     // looser eq-tolerance (default 0.1)
          minEqualCount: 2,
          confirmationWindow: 5,           // longer window (default 3)
          targetRMult: 2.0,
          stopBufferAtrMul: 0.05,
        },
      };
    }
    return d;
  });
}

export const CONTROL_ASSETS: ControlAsset[] = [
  {
    symbol: "1HZ100V",
    granularity: 60, // 1m — fires ~60 bars/hour, very high signal frequency
    detectors: looseDetectorConfigs(),
    label: "Volatility 100 (1s) Index — 1m control (loose)",
  },
  {
    symbol: "1HZ100V",
    granularity: 900, // 15m — slower control for confirmation
    detectors: looseDetectorConfigs(),
    label: "Volatility 100 (1s) Index — 15m control (loose)",
  },
];

export function isControlSymbol(symbol: string): boolean {
  return CONTROL_ASSETS.some((c) => c.symbol === symbol);
}

export function controlAssetForKey(symbol: string, granularity: number): ControlAsset | undefined {
  return CONTROL_ASSETS.find((c) => c.symbol === symbol && c.granularity === granularity);
}

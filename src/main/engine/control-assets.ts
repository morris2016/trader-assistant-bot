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

export const CONTROL_ASSETS: ControlAsset[] = [
  {
    symbol: "1HZ100V",
    granularity: 900, // 15m — should fire several times per hour on a high-vol 1s index
    detectors: defaultDetectorConfigs(), // all 3 detectors enabled with raw defaults
    label: "Volatility 100 (1s) Index — 15m control",
  },
];

export function isControlSymbol(symbol: string): boolean {
  return CONTROL_ASSETS.some((c) => c.symbol === symbol);
}

export function controlAssetForKey(symbol: string, granularity: number): ControlAsset | undefined {
  return CONTROL_ASSETS.find((c) => c.symbol === symbol && c.granularity === granularity);
}

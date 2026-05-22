// Binance engine runtime config — editable via UI, persisted to disk.
//
// Disk file: <stateDir>/binance-config.json
// Loaded on bot start; saved atomically via tmp + rename.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BINANCE_ASSETS } from "@shared/binance-assets";

export type BinanceConfig = {
  /** Base $ stake per trade. */
  stake: number;
  /** Position leverage (MULT). Binance metals/crypto allow up to 125× for some pairs. */
  leverage: number;
  /** Daily realized-loss cap in $ — engine pauses when hit. */
  dailyMaxLoss: number;
  /** Hard ceiling on any single trade's stake regardless of base + multipliers. */
  perTradeMaxStake: number;
  /** Per-asset enable map — keyed by Binance symbol (e.g. "BTCUSDT").
   *  When false, the engine skips signals on that symbol. */
  perAssetEnabled: Record<string, boolean>;
  /** Per-pattern enable map — keyed by pattern id (OB_BULL/OB_BEAR/BOS_UP). */
  perPatternEnabled: { OB_BULL: boolean; OB_BEAR: boolean; BOS_UP: boolean };
  /** Operator intent: when true, engine resumes automatically on bot boot
   *  (e.g. after Railway redeploy). Toggled by Start/Stop in the UI. */
  autoStart: boolean;
};

export const DEFAULT_BINANCE_CONFIG: BinanceConfig = {
  stake: 15,
  leverage: 30,
  dailyMaxLoss: 100,
  perTradeMaxStake: 30,
  perAssetEnabled: Object.fromEntries(BINANCE_ASSETS.map((a) => [a, true])),
  perPatternEnabled: { OB_BULL: true, OB_BEAR: true, BOS_UP: true },
  autoStart: false,
};

export function loadBinanceConfig(stateDir: string): BinanceConfig {
  const file = path.join(stateDir, "binance-config.json");
  if (!existsSync(file)) return { ...DEFAULT_BINANCE_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BinanceConfig>;
    // Merge with defaults so newly-added knobs get a value automatically
    return {
      ...DEFAULT_BINANCE_CONFIG,
      ...parsed,
      perAssetEnabled: { ...DEFAULT_BINANCE_CONFIG.perAssetEnabled, ...(parsed.perAssetEnabled ?? {}) },
      perPatternEnabled: { ...DEFAULT_BINANCE_CONFIG.perPatternEnabled, ...(parsed.perPatternEnabled ?? {}) },
    };
  } catch {
    return { ...DEFAULT_BINANCE_CONFIG };
  }
}

export async function saveBinanceConfig(stateDir: string, cfg: BinanceConfig): Promise<void> {
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, "binance-config.json");
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
  await fs.rename(tmp, file);
}

// Binance engine runtime config — editable via UI, persisted to disk.
//
// Disk file: <stateDir>/binance-config.json
// Loaded on bot start; saved atomically via tmp + rename.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BINANCE_ASSETS } from "@shared/binance-assets";
import { DEFAULT_RISK_RULES, type RiskRulesConfig } from "../main/engine/risk-rules";

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
  /** Anti-martingale (Paroli) sizing for the 1h SMC stack. Compounds stake
   *  after consecutive wins on the same key (asset × pattern × side). Resets
   *  on any loss. Sim-validated 2026-05-23 on 17-month dataset: anti ×2 cap3
   *  turned +$388 baseline into +$6,313 on $100 account, zero busts. */
  martingale: {
    /** "off" disables sizing; baseline $stake per trade.
     *  "anti" compounds after wins; resets on loss. */
    mode: "off" | "anti";
    /** Stake multiplier per consecutive win. 2.0 = each win doubles. */
    multiplier: number;
    /** Hard cap on ladder depth. After N consecutive wins, reset to base.
     *  cap=3 means max stake = base × multiplier^3. */
    maxLevels: number;
  };
  /** Risk guardrails distilled from Elder/Williams/Vantage/Kaufman. Default
   *  off so existing live behavior is unchanged; enable per-gate after paper
   *  validation. See src/main/engine/risk-rules.ts for each rule's source. */
  riskRules: RiskRulesConfig;
  /** HF (15m) strategy stack — BB_UP_SHORT + BB_LOW_LONG. Runs alongside
   *  the 1h SMC patterns but on its own timeframe with its own sizing. */
  hf: {
    /** Master enable for the HF 15m loop. */
    enabled: boolean;
    /** $ stake per HF trade — typically much smaller than 1h stake. */
    stake: number;
    /** Leverage for HF trades (separate from main `leverage`). */
    leverage: number;
    /** Allow multiple concurrent trades on the same (asset × pattern × side)?
     *  False = the engine skips a new signal if one is already open. */
    allowMultiplePerKey: boolean;
    /** Per-pattern enable map. */
    perPatternEnabled: { BB_UP_SHORT: boolean; BB_LOW_LONG: boolean };
    /** Per-asset enable map (defaults to all 15 USDT-perps on). */
    perAssetEnabled: Record<string, boolean>;
  };
};

export const DEFAULT_BINANCE_CONFIG: BinanceConfig = {
  stake: 15,
  leverage: 30,
  dailyMaxLoss: 100,
  perTradeMaxStake: 30,
  perAssetEnabled: Object.fromEntries(BINANCE_ASSETS.map((a) => [a, true])),
  perPatternEnabled: { OB_BULL: true, OB_BEAR: true, BOS_UP: true },
  autoStart: false,
  martingale: { mode: "off", multiplier: 2.0, maxLevels: 3 },
  riskRules: { ...DEFAULT_RISK_RULES },
  hf: {
    enabled: false,
    stake: 1,
    leverage: 30,
    allowMultiplePerKey: false,
    perPatternEnabled: { BB_UP_SHORT: true, BB_LOW_LONG: true },
    perAssetEnabled: Object.fromEntries(BINANCE_ASSETS.map((a) => [a, true])),
  },
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
      martingale: { ...DEFAULT_BINANCE_CONFIG.martingale, ...(parsed.martingale ?? {}) },
      riskRules: { ...DEFAULT_BINANCE_CONFIG.riskRules, ...(parsed.riskRules ?? {}) },
      hf: {
        ...DEFAULT_BINANCE_CONFIG.hf,
        ...(parsed.hf ?? {}),
        perAssetEnabled: { ...DEFAULT_BINANCE_CONFIG.hf.perAssetEnabled, ...(parsed.hf?.perAssetEnabled ?? {}) },
        perPatternEnabled: { ...DEFAULT_BINANCE_CONFIG.hf.perPatternEnabled, ...(parsed.hf?.perPatternEnabled ?? {}) },
      },
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

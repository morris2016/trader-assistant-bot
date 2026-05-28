// Binance engine runtime config — editable via UI, persisted to disk.
//
// Disk file: <stateDir>/binance-config.json
// Loaded on bot start; saved atomically via tmp + rename.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { BINANCE_ASSETS } from "@shared/binance-assets";
import { DEFAULT_RISK_RULES, DEFAULT_HF_QUALITY_FILTER, RECOMMENDED_HF_QUALITY_FILTER, PER_ASSET_MAX_LEV, type RiskRulesConfig, type HfQualityFilterConfig } from "../main/engine/risk-rules";

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
  /** Hard stop-loss as % of STAKE for 1h SMC trades. Example: slPctSmc=50
   *  on a $50 stake = max $25 loss at SL (price moves slPctSmc / leverage
   *  before triggering — e.g. 50/30 = 1.67% price move on a 30× trade).
   *  0 = disabled (trail-arm exit only). When > 0, runs alongside the
   *  trail exit — whichever triggers first wins. Default 0. */
  slPctSmc?: number;
  /** Risk guardrails distilled from Elder/Williams/Vantage/Kaufman. Default
   *  off so existing live behavior is unchanged; enable per-gate after paper
   *  validation. See src/main/engine/risk-rules.ts for each rule's source. */
  riskRules: RiskRulesConfig;
  /** HF (15m) strategy stack — M1..M5 (mined 2026-05-26). Runs alongside
   *  the 1h SMC patterns but on its own timeframe with its own sizing.
   *  Each rule combines a 15m z-score with a 1h trend filter; stake is
   *  modulated by a per-rule strength quintile (HF_STAKE_MULTS in engine). */
  hf: {
    /** Master enable for the HF 15m loop. */
    enabled: boolean;
    /** Base $ stake per HF trade (before strength multiplier from engine).
     *  Used when stakeMode = "fixed". When stakeMode = "percent", the
     *  effective stake is computed dynamically from the current wallet. */
    stake: number;
    /** Sizing mode — "fixed" uses the `stake` field as-is; "percent" uses
     *  `stakePct × current_wallet_equity` so position size scales with PnL.
     *  Validated 2026-05-27: percent-sizing on $100 acct over 37 months
     *  produced 84× return at 2% stakePct vs flat $2 → bust at first losing
     *  streak. Default "fixed" for back-compat; recommend "percent". */
    stakeMode?: "fixed" | "percent";
    /** Stake as fraction of wallet equity (only used when stakeMode="percent").
     *  Typical: 0.01-0.03 (1-3%). At 2% with $100 wallet → $2/trade base. */
    stakePct?: number;
    /** Default leverage for HF trades (per-asset override via perAssetLeverage). */
    leverage: number;
    /** Allow multiple concurrent trades on the same (asset × pattern × side)?
     *  False = the engine skips a new signal if one is already open. */
    allowMultiplePerKey: boolean;
    /** Per-pattern enable map (M5 default OFF — weakest CV survivor). */
    perPatternEnabled: { M1: boolean; M2: boolean; M3: boolean; M4: boolean; M5: boolean };
    /** Per-asset enable map (defaults to all 15 USDT-perps on). */
    perAssetEnabled: Record<string, boolean>;
    /** Independent anti-martingale ladder for the HF stack (separate from
     *  the SMC `martingale` field above). HF win-streaks tracked under
     *  HF pattern keys won't bleed into SMC sizing and vice versa. */
    martingale?: { mode: "off" | "anti"; multiplier: number; maxLevels: number };
    /** Hard stop-loss as % of STAKE for 15m HF trades. Same math as slPctSmc
     *  but applied independently to HF entries. Price move = slPct / hf.leverage.
     *  0 = disabled. */
    slPct?: number;
    /** Skip M1..M5 strength filter — when false, every signal fires at base
     *  stake regardless of strength quintile (37mo sim: unfiltered + fixed
     *  2:1 was the long-run winner). When true (default), only signals with
     *  defined SCHEDULE quintile fire, sized by 0.75-1.5× multiplier. */
    useStrengthFilter?: boolean;
    /** Exit mode for HF trades:
     *    "trail" = current behavior (trail-arm at +1×ATR + 0.3×ATR retrace + hard SL)
     *    "fixedRR" = fixed TP at +tpAtr×ATR + SL at −slAtr×ATR (no trail)
     *  37mo real-Binance sim: fixedRR with 2:1 RR netted 84× vs trail-arm's 45×. */
    exitMode?: "trail" | "fixedRR";
    /** Take-profit distance in ATRs (used when exitMode="fixedRR"). */
    tpAtr?: number;
    /** Stop-loss distance in ATRs (used by both exitMode variants). */
    slAtr?: number;
    /** Per-asset HF leverage override (each symbol's exchange-max). Falls
     *  back to `leverage` field when an asset isn't in the map. Validated
     *  2026-05-25: per-asset max beats uniform 75× by ~29% per-trade edge. */
    perAssetLeverage?: Record<string, number>;
    /** HF quality filter — hour-band + bbWidth-percentile + volume-percentile.
     *  Validated 2026-05-25 on 199K trades: filtered subset shows
     *  27/27 months profitable vs 27/29 unfiltered at per-asset max lev. */
    qualityFilter?: HfQualityFilterConfig;
  };
};

/** Recommended HF knob defaults — used by the UI's "Reset to defaults"
 *  button. Sourced from 37-month real-Binance sim 2026-05-27.
 *  - Filter ON: current shipped behavior (only quintile-bucketed signals)
 *  - Exit "trail": current shipped behavior; switch to "fixedRR" for the
 *    37mo 84× variant
 *  - tpAtr 2.0 / slAtr 1.0 = 2:1 risk-reward */
export const HF_KNOB_DEFAULTS = {
  useStrengthFilter: true,
  exitMode: "trail" as const,
  tpAtr: 2.0,
  slAtr: 1.0,
  stakeMode: "fixed" as const,
  stakePct: 0.02,
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
    enabled: true,
    stake: 1,
    stakeMode: "fixed",
    stakePct: 0.02,           // 2% — recommended baseline when switched to "percent"
    leverage: 30,
    allowMultiplePerKey: false,
    perPatternEnabled: { M1: true, M2: true, M3: true, M4: true, M5: true },
    // Default HF asset list — all assets ON. Operator can disable individuals
    // in the HF config UI per regime.
    perAssetEnabled: Object.fromEntries(BINANCE_ASSETS.map((a) => [a, true])),
    martingale: { mode: "off", multiplier: 2.0, maxLevels: 3 },
    slPct: 0,
    useStrengthFilter: true,    // default ON (current shipped behavior)
    exitMode: "trail",          // default trail (current shipped behavior; switch to "fixedRR" for 2:1 RR)
    tpAtr: 2.0,                 // 2×ATR TP (used only when exitMode="fixedRR")
    slAtr: 1.0,                 // 1×ATR SL (used in fixedRR; trail mode uses its own SL logic)
    perAssetLeverage: { ...PER_ASSET_MAX_LEV },
    qualityFilter: { ...DEFAULT_HF_QUALITY_FILTER },
  },
  slPctSmc: 0,
};

export function loadBinanceConfig(stateDir: string): BinanceConfig {
  const file = path.join(stateDir, "binance-config.json");
  if (!existsSync(file)) return { ...DEFAULT_BINANCE_CONFIG };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<BinanceConfig>;
    // Migration: legacy configs have hf.perPatternEnabled = { BB_UP_SHORT, BB_LOW_LONG }.
    // Those keys are no longer valid (engine fires M1..M5 instead). Drop legacy keys
    // entirely and fall through to DEFAULT_BINANCE_CONFIG.hf.perPatternEnabled.
    const legacyHfPP = parsed.hf?.perPatternEnabled as any;
    const hasLegacyBB = legacyHfPP && ("BB_UP_SHORT" in legacyHfPP || "BB_LOW_LONG" in legacyHfPP);
    const migratedHfPP = hasLegacyBB
      ? { ...DEFAULT_BINANCE_CONFIG.hf.perPatternEnabled }
      : { ...DEFAULT_BINANCE_CONFIG.hf.perPatternEnabled, ...(parsed.hf?.perPatternEnabled ?? {}) };
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
        perPatternEnabled: migratedHfPP,
        perAssetLeverage: { ...DEFAULT_BINANCE_CONFIG.hf.perAssetLeverage, ...(parsed.hf?.perAssetLeverage ?? {}) },
        qualityFilter: { ...DEFAULT_BINANCE_CONFIG.hf.qualityFilter, ...(parsed.hf?.qualityFilter ?? {}) },
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

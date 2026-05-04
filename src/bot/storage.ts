// File-based persistence for the headless bot.
// Replaces electron-store with a simple JSON file in `stateDir` (mounted volume on Railway).
// Atomic write: write to temp + rename, so a crash mid-write can't corrupt state.

import { promises as fs } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { RealTrade } from "@shared/types";
import {
  emptyAdaptiveShiftState,
  type AdaptiveShiftState,
} from "../main/engine/adaptive-shift";
import { emptyMartingaleState, type MartingaleState } from "../main/engine/martingale";
import { emptyPaperState, type PaperState } from "./paper-engine";

/** Shared shape for both Fast and Fast2 sandbox configs. Both expose the same
 *  knobs — leverage, martingale, base stake, ladder depth, per-trade cap — plus
 *  a Deriv-fee model (commission % of stake + entry-spread bps) so paper P&L
 *  reflects what a real Deriv multiplier contract would settle at. */
export type FastSandboxConfig = {
  /** Position leverage applied to every paper trade. UI typically exposes
   *  30/50/100/200/300/400/500. */
  tradeMultiplier: number;
  /** Per-loss stake multiplier on the martingale ladder. */
  martingaleMultiplier: number;
  /** Stake at level 0 of the ladder. */
  baseStake: number;
  /** Maximum consecutive losses before circuit-breaker reset. */
  maxLevels: number;
  /** Hard cap on a single trade's stake regardless of ladder level. */
  perTradeCap: number;
  /** Deriv multiplier-contract commission as a fraction of stake (0.005 = 0.5%).
   *  Charged once at trade open, deducted from pnl at settle. */
  commissionPct: number;
  /** Adverse entry slippage in basis points (1.0 = 1bp = 0.01% of price).
   *  BUYs enter slightly higher, SELLs slightly lower — emulates Deriv's
   *  bid/ask spread on the multiplier order. */
  entrySpreadBps: number;
  /** Adverse stop-loss slippage in basis points. On synthetic-index spikes,
   *  Deriv's SL doesn't fill at the exact trigger price — the next-tick fill
   *  is typically 5-15 bps past the stop. Paper models this so SL-hits cost
   *  more than the geometry suggests. Defaults to 5 bps. TP fills are NOT
   *  slipped (they trigger cleanly during normal price fluctuation, not on
   *  volatile spikes). */
  slSlippageBps: number;
  /** UI override: when true, the bot escalates the martingale ladder for
   *  EVERY strategy in the sandbox, regardless of the per-strategy
   *  `useMartingale` flag in the registry. Lets the operator force
   *  martingale-on for strategies (e.g. spike-fade) that the registry
   *  validated as flat-stake. When false, the per-strategy flag wins. */
  forceMartingale: boolean;
  /** Trade-side filter applied at signal-routing time. "both" = trade both
   *  directions (default), "BUY" = drop SELL signals, "SELL" = drop BUY
   *  signals. Useful when one side has demonstrably worse edge in current
   *  regime and the operator wants to disable it without redeploying. */
  sideFilter: "both" | "BUY" | "SELL";
  /** Ladder advance direction. "classic" = escalate stake on loss, reset
   *  on win (textbook martingale). "anti" = escalate stake on win, reset
   *  on loss (Paroli system — ride winning streaks, cut on first loss).
   *  Telemetry counters (wins/losses) always reflect the actual trade
   *  outcome regardless of mode. */
  martingaleMode: "classic" | "anti";
  /** Live-trading toggle for THIS sandbox specifically. When true, signals
   *  bypass the paper engine and route to real.placeTrade — actual money
   *  on the Deriv account. The paper sandbox stops opening new positions;
   *  trade history continues to populate but tagged with sandbox="fast2"
   *  on the real-engine side. All circuits (price-tolerance, latency,
   *  session-DD) remain enforced. */
  liveTradingEnabled: boolean;
  /** Strategy-level kill switch. When `false` (only meaningful in a
   *  perStrategy override), the strategy is silenced — its signals are
   *  dropped before any paper/live open path. Defaults to `true`/undefined
   *  meaning the strategy is active. Lets the operator turn off a single
   *  strategy without removing it from the registry. */
  enabled?: boolean;
  /** Per-strategy overrides: any subset of the above fields, keyed by
   *  strategyId. When a strategy is dispatched, the effective config is
   *  computed by spreading the general config and then overlaying the
   *  strategy-specific override. Unset fields fall back to the general
   *  config. Example:
   *    perStrategy: { fast2_rdbear_meanrev: { sideFilter: "SELL", baseStake: 30 } }
   *  Lets the operator tune a single asset (martingale, side, stake) without
   *  affecting the rest of the stack. */
  perStrategy?: Record<string, Partial<Omit<FastSandboxConfig, "perStrategy" | "liveTradingEnabled">>>;
};

/** Resolve the effective per-strategy config: spread `general`, overlay any
 *  matching `perStrategy[strategyId]` overrides. liveTradingEnabled is always
 *  taken from the general config (per-strategy overrides cannot toggle live
 *  mode — that's a sandbox-wide safety knob). */
export function resolveFastConfig(general: FastSandboxConfig, strategyId: string): FastSandboxConfig {
  const override = general.perStrategy?.[strategyId];
  if (!override) return general;
  return { ...general, ...override, liveTradingEnabled: general.liveTradingEnabled };
}

/** Fast (sandbox 1) — defaults targeted at the existing 30× / 2.2× / 5L config
 *  that has been making real money on paper. Fees baked in for realistic P&L. */
export type Fast1Config = FastSandboxConfig;
export const DEFAULT_FAST1_CONFIG: Fast1Config = {
  // Fast1 paper shadow of the R-stack — same params as Fast2 to enable a clean
  // paper-vs-live comparison. liveTradingEnabled stays false here so all
  // Fast1 trades land in the paper account.
  tradeMultiplier: 100,
  martingaleMultiplier: 1.0,
  baseStake: 3,
  maxLevels: 1,
  perTradeCap: 100,
  commissionPct: 0.005,
  entrySpreadBps: 1.0,
  slSlippageBps: 5.0,
  forceMartingale: false,
  sideFilter: "both",
  martingaleMode: "classic",
  liveTradingEnabled: false,    // PAPER ONLY — Fast1 is the paper shadow sandbox
};

/** Fast2 — same shape as Fast1. Defaults aligned to Deriv's actual contract
 *  constraints for synthetic-index multiplier contracts:
 *    multiplier ∈ {20, 40, 60, 80, 100}
 *    minStake = $1, maxStake = $2000 (per Deriv contracts_for)
 *    commission = 0.5% baked into proposal pricing
 *  Picking 100× (max Deriv allows) keeps the validated paper edge while
 *  staying within the live-tradable range. */
export type Fast2Config = FastSandboxConfig;
// FAST2 REPURPOSED 2026-05-04 → DIGITOVER 0 tick-level book with 2.2× Paroli.
// Three R_* DIGITOVER 0 strategies (R_25, R_50, R_75), ~99.9%+ structural WR.
// 2.2× anti-martingale (Paroli) escalates stake on each win; resets on loss.
// Depth 5 lets a 5-win streak ride from $1 → $1×2.2⁵ = $51 before reset.
export const DEFAULT_FAST2_CONFIG: Fast2Config = {
  tradeMultiplier: 100,           // unused for DIGITs (binary contracts) — kept for UI parity
  martingaleMultiplier: 2.2,      // Paroli escalation ratio
  baseStake: 1,
  maxLevels: 5,                   // 5-win Paroli streak cap; resets on first loss
  perTradeCap: 50,                // Deriv DIGIT contract max stake
  commissionPct: 0,
  entrySpreadBps: 0,
  slSlippageBps: 0,
  forceMartingale: false,
  sideFilter: "both",
  martingaleMode: "anti",         // ★ Paroli — escalate on win, reset on loss
  liveTradingEnabled: false,      // PAPER first — flip to live after paper-test
};

/** Fast3 — DIGITODD tick-level binary contracts on synthetic indices.
 *  Each tick = one DIGITODD bet. Win pays 1.93×; loss = -stake. The
 *  measured base-rate WR across synthetic symbols is 55-57% (RNG only
 *  produces digits 1-9, so P(odd) = 5/9 = 55.5%).
 *
 *  Default config (validated 2026-05-03 last-hour real-acc sim):
 *    $41 acct  / $1 stake / 1.5× mart depth=∞ (capped by affordability) /
 *    7 symbols (R_50, RDBEAR, RDBULL, R_75, JD75, 1HZ50V, 1HZ100V)
 *    → $41 → $986 with frictions in 1h, ZERO bust events.
 *
 *  tradeMultiplier is unused for DIGITODD (binary payout) — kept in the
 *  config schema so the UI is uniform with Fast2. */
export type Fast3Config = FastSandboxConfig;
export const DEFAULT_FAST3_CONFIG: Fast3Config = {
  tradeMultiplier: 100,            // unused for DIGIT contracts; UI parity only
  martingaleMultiplier: 1.5,
  baseStake: 1,
  maxLevels: 6,                    // L6 cum-loss $32 fits $41 acct; L7 BUSTS
  perTradeCap: 50,                 // Deriv DIGIT contract typical max stake
  commissionPct: 0,                // DIGITs don't carry commission like multipliers
  entrySpreadBps: 0,
  slSlippageBps: 0,
  forceMartingale: false,
  sideFilter: "both",
  martingaleMode: "classic",
  liveTradingEnabled: false,       // PAPER ONLY by default — flip after live wiring
};

/** Deriv-valid multiplier values for synthetic-index MULTIPLIER contracts.
 *  Source: Deriv contracts_for response (multiplier_range field). Anything
 *  outside this set is rejected by the buy endpoint with
 *  ContractBuyValidationError. */
export const DERIV_MULTIPLIER_OPTIONS = [20, 40, 60, 80, 100] as const;
/** Snap an arbitrary multiplier to the closest Deriv-accepted value. */
export function clampDerivMultiplier(m: number): number {
  if (!isFinite(m) || m <= 0) return 100;
  let best = DERIV_MULTIPLIER_OPTIONS[0];
  let bestDist = Math.abs(m - best);
  for (const v of DERIV_MULTIPLIER_OPTIONS) {
    const d = Math.abs(m - v);
    if (d < bestDist) { best = v; bestDist = d; }
  }
  return best;
}
/** Deriv min/max stake on synthetic-index multipliers (USD). The actual
 *  ceiling depends on multiplier choice (smaller MULT permits larger stake)
 *  but $2000 is a safe universal upper bound. */
export const DERIV_MIN_STAKE_USD = 1;
export const DERIV_MAX_STAKE_USD = 2000;
/** Deriv minimum take_profit / stop_loss amount on multiplier contracts.
 *  ContractBuyValidationError fires below this. Universal minimum across
 *  synthetics. */
export const DERIV_MIN_TPSL_USD = 0.10;

export type BotState = {
  /** Currently open contracts (still being tracked for settlement). */
  open: RealTrade[];
  /** Closed trades — kept last N for stats. */
  closed: RealTrade[];
  /** UTC date string of last day, daily P&L tracking. */
  daily: { date: string; profit: number; tradesOpened: number; capHit: boolean };
  /** Adaptive shift state — survives bot restarts. */
  adaptiveShift: AdaptiveShiftState;
  /** Paper trading sim — separate balance, trades, adaptive shift, equity curve. */
  paper: PaperState;
  /** Fast-trade sandbox — own paper account for high-frequency
   *  drift-fade scalps with martingale stake escalation. */
  fastPaper: PaperState;
  /** Per-strategy martingale ladder state for the fast-trade sandbox, keyed
   *  by strategy id. */
  fastMartingale: Record<string, MartingaleState>;
  /** Fast (sandbox 1) runtime config — leverage, martingale, fees. Editable
   *  from the UI; the bot applies it at every Fast trade open and ladder
   *  advance so a live operator can tune behavior without redeploy. */
  fast1Config: Fast1Config;
  /** Fast2 sandbox — parallel to fastPaper, independent balance / ladders /
   *  config. Hosts the validated 3-strategy stack with user-selectable
   *  martingale and trade leverage. */
  fast2Paper: PaperState;
  /** Paper-mode martingale ladders. Advanced ONLY when fast2Paper settles a
   *  position. Cannot influence live stake calculations. */
  fast2MartingalePaper: Record<string, MartingaleState>;
  /** Live-mode martingale ladders. Advanced ONLY when a real Deriv contract
   *  tagged sandbox="fast2" settles. Cannot influence paper stake. */
  fast2MartingaleLive: Record<string, MartingaleState>;
  fast2Config: Fast2Config;
  /** Fast3 sandbox — DIGITODD tick-level book on synthetic indices.
   *  Parallel to Fast2 but trades binary 1-tick contracts, not multipliers. */
  fast3Paper: PaperState;
  fast3MartingalePaper: Record<string, MartingaleState>;
  fast3MartingaleLive: Record<string, MartingaleState>;
  fast3Config: Fast3Config;
};

const MAX_CLOSED_RETAINED = 500;

export function emptyBotState(): BotState {
  return {
    open: [],
    closed: [],
    daily: { date: "", profit: 0, tradesOpened: 0, capHit: false },
    adaptiveShift: emptyAdaptiveShiftState(),
    paper: emptyPaperState(),
    fastPaper: emptyPaperState(200), // smaller starting balance — martingale needs less headroom than the 500 sandbox
    fastMartingale: {},
    fast1Config: { ...DEFAULT_FAST1_CONFIG },
    fast2Paper: emptyPaperState(250), // Fast2 sandbox sized to validated $250 d=3 mart book (2026-05-03)
    fast2MartingalePaper: {},
    fast2MartingaleLive: {},
    fast2Config: { ...DEFAULT_FAST2_CONFIG },
    fast3Paper: emptyPaperState(41), // Fast3 sandbox sized to validated $41 / $1 / 1.5× DIGITODD book
    fast3MartingalePaper: {},
    fast3MartingaleLive: {},
    fast3Config: { ...DEFAULT_FAST3_CONFIG },
  };
}

/** Apply FAST2_* environment variable overrides to a Fast2Config. Read at
 *  every load() so a Railway redeploy that wipes the state file still ends
 *  up with the user's preferred config — env vars are part of the service
 *  definition and survive redeploys, container restarts, etc. */
function applyFast2EnvOverrides(cfg: Fast2Config): Fast2Config {
  const next = { ...cfg };
  const num = (k: string): number | null => {
    const v = process.env[k];
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const bool = (k: string): boolean | null => {
    const v = process.env[k];
    if (v == null || v === "") return null;
    return v === "1" || v.toLowerCase() === "true";
  };
  const str = (k: string): string | null => {
    const v = process.env[k];
    return v == null || v === "" ? null : v;
  };
  const tm = num("FAST2_TRADE_MULT");           if (tm != null) next.tradeMultiplier = tm;
  const mm = num("FAST2_MART_MULT");            if (mm != null) next.martingaleMultiplier = mm;
  const bs = num("FAST2_BASE_STAKE");           if (bs != null) next.baseStake = bs;
  const ml = num("FAST2_MAX_LEVELS");           if (ml != null) next.maxLevels = ml;
  const cap = num("FAST2_PER_TRADE_CAP");       if (cap != null) next.perTradeCap = cap;
  const cm = num("FAST2_COMMISSION_PCT");       if (cm != null) next.commissionPct = cm;
  const sp = num("FAST2_ENTRY_SPREAD_BPS");     if (sp != null) next.entrySpreadBps = sp;
  const slip = num("FAST2_SL_SLIPPAGE_BPS");    if (slip != null) next.slSlippageBps = slip;
  const fm = bool("FAST2_FORCE_MARTINGALE");    if (fm != null) next.forceMartingale = fm;
  const lt = bool("FAST2_LIVE_TRADING");        if (lt != null) next.liveTradingEnabled = lt;
  const sf = str("FAST2_SIDE_FILTER");
  if (sf === "both" || sf === "BUY" || sf === "SELL") next.sideFilter = sf;
  const mode = str("FAST2_MARTINGALE_MODE");
  if (mode === "classic" || mode === "anti") next.martingaleMode = mode;
  return next;
}

export class BotStorage {
  private readonly file: string;
  private readonly prefsFile: string;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "bot-state.json");
    // Configs are also written to a separate "prefs" file. If the runtime
    // state file is cleared (e.g. for a fresh paper sandbox) but the user
    // wants to keep their stake/martingale tuning, the prefs file survives
    // independently. Prefs takes precedence over state-embedded configs.
    this.prefsFile = path.join(stateDir, "bot-prefs.json");
  }

  async load(): Promise<BotState> {
    // Load prefs first (config-only). Env-var overrides apply on top.
    const prefs = await this.loadPrefs();
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<BotState>;
      return {
        open: parsed.open ?? [],
        closed: (parsed.closed ?? []).slice(0, MAX_CLOSED_RETAINED),
        daily: parsed.daily ?? { date: "", profit: 0, tradesOpened: 0, capHit: false },
        adaptiveShift: parsed.adaptiveShift ?? emptyAdaptiveShiftState(),
        paper: parsed.paper ?? emptyPaperState(),
        fastPaper: parsed.fastPaper ?? emptyPaperState(200),
        fastMartingale: parsed.fastMartingale ?? {},
        fast1Config: { ...DEFAULT_FAST1_CONFIG, ...(parsed.fast1Config ?? {}), ...(prefs.fast1Config ?? {}) },
        fast2Paper: parsed.fast2Paper ?? emptyPaperState(50),
        // Migrate from legacy single fast2Martingale → split paper/live.
        // The legacy state is treated as the paper ladder (it was driven by
        // the paper engine in the buggy "shared" implementation).
        fast2MartingalePaper: parsed.fast2MartingalePaper
          ?? (parsed as { fast2Martingale?: Record<string, MartingaleState> }).fast2Martingale
          ?? {},
        fast2MartingaleLive: parsed.fast2MartingaleLive ?? {},
        fast2Config: applyFast2EnvOverrides({
          ...DEFAULT_FAST2_CONFIG,
          ...(parsed.fast2Config ?? {}),
          ...(prefs.fast2Config ?? {}),
        }),
        fast3Paper: parsed.fast3Paper ?? emptyPaperState(41),
        fast3MartingalePaper: parsed.fast3MartingalePaper ?? {},
        fast3MartingaleLive: parsed.fast3MartingaleLive ?? {},
        fast3Config: {
          ...DEFAULT_FAST3_CONFIG,
          ...(parsed.fast3Config ?? {}),
          ...(prefs.fast3Config ?? {}),
        },
      };
    } catch (e: any) {
      if (e?.code === "ENOENT") {
        // No state file → start from defaults, but still apply prefs + env so
        // a redeploy that wipes /state still honors the user's tuning.
        const empty = emptyBotState();
        return {
          ...empty,
          fast1Config: { ...empty.fast1Config, ...(prefs.fast1Config ?? {}) },
          fast2Config: applyFast2EnvOverrides({ ...empty.fast2Config, ...(prefs.fast2Config ?? {}) }),
          fast3Config: { ...empty.fast3Config, ...(prefs.fast3Config ?? {}) },
        };
      }
      throw e;
    }
  }

  private async loadPrefs(): Promise<{ fast1Config?: Partial<Fast1Config>; fast2Config?: Partial<Fast2Config>; fast3Config?: Partial<Fast3Config> }> {
    try {
      const raw = await fs.readFile(this.prefsFile, "utf8");
      return JSON.parse(raw);
    } catch (e: any) {
      if (e?.code === "ENOENT") return {};
      throw e;
    }
  }

  /**
   * Atomic save: write to .tmp, fsync, rename. Coalesces concurrent saves
   * so the latest state always wins and we never have overlapping writes.
   * Also mirrors the user-tunable configs to a separate prefs sidecar so
   * they survive resetFastPaper / resetFast2Paper without the state-side
   * wipe touching tuning state. The prefs file is also the thing a Railway
   * volume mount should preserve across redeploys.
   */
  save(state: BotState): Promise<void> {
    const next = async () => {
      // 1. Full state file (runtime + config).
      const tmp = this.file + ".tmp";
      const json = JSON.stringify(state, null, 2);
      const fh = await fs.open(tmp, "w");
      try {
        await fh.writeFile(json, "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.file);

      // 2. Prefs sidecar (config-only). Smaller, safer to keep.
      const prefs = {
        fast1Config: state.fast1Config,
        fast2Config: state.fast2Config,
        fast3Config: state.fast3Config,
      };
      const prefsTmp = this.prefsFile + ".tmp";
      const prefsJson = JSON.stringify(prefs, null, 2);
      const pfh = await fs.open(prefsTmp, "w");
      try {
        await pfh.writeFile(prefsJson, "utf8");
        await pfh.sync();
      } finally {
        await pfh.close();
      }
      await fs.rename(prefsTmp, this.prefsFile);
    };
    this.writePromise = this.writePromise.then(next, next);
    return this.writePromise;
  }
}

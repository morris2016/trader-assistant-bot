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
};

/** Fast (sandbox 1) — defaults targeted at the existing 30× / 2.2× / 5L config
 *  that has been making real money on paper. Fees baked in for realistic P&L. */
export type Fast1Config = FastSandboxConfig;
export const DEFAULT_FAST1_CONFIG: Fast1Config = {
  tradeMultiplier: 30,
  martingaleMultiplier: 2.2,
  baseStake: 0.5,
  maxLevels: 5,
  perTradeCap: 30,
  commissionPct: 0.005,
  entrySpreadBps: 1.0,
};

/** Fast2 — same shape as Fast1, defaults targeted at the validated 3-strategy
 *  stack candidates (300×, 1.7× mart). */
export type Fast2Config = FastSandboxConfig;
export const DEFAULT_FAST2_CONFIG: Fast2Config = {
  tradeMultiplier: 300,
  martingaleMultiplier: 1.7,
  baseStake: 1.5,
  maxLevels: 5,
  perTradeCap: 30,
  commissionPct: 0.005,
  entrySpreadBps: 1.0,
};

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
  /** Synth-strategies paper sandbox — completely isolated from real-asset paper. */
  synthPaper: PaperState;
  /** Fast-trade synth sandbox — own paper account for high-frequency
   *  drift-fade scalps with martingale stake escalation. */
  fastPaper: PaperState;
  /** Per-strategy martingale ladder state for the fast-trade sandbox. Keyed
   *  by strategy id (e.g. "crash500n_drift" / "boom300n_drift"). */
  fastMartingale: Record<string, MartingaleState>;
  /** Fast (sandbox 1) runtime config — leverage, martingale, fees. Editable
   *  from the UI; the bot applies it at every Fast trade open and ladder
   *  advance so a live operator can tune behavior without redeploy. */
  fast1Config: Fast1Config;
  /** Fast2 sandbox — parallel to fastPaper, independent balance / ladders /
   *  config. Hosts the validated 3-strategy stack with user-selectable
   *  martingale and trade leverage. */
  fast2Paper: PaperState;
  fast2Martingale: Record<string, MartingaleState>;
  fast2Config: Fast2Config;
};

const MAX_CLOSED_RETAINED = 500;

export function emptyBotState(): BotState {
  return {
    open: [],
    closed: [],
    daily: { date: "", profit: 0, tradesOpened: 0, capHit: false },
    adaptiveShift: emptyAdaptiveShiftState(),
    paper: emptyPaperState(),
    synthPaper: emptyPaperState(),
    fastPaper: emptyPaperState(200), // smaller starting balance — martingale needs less headroom than the 500 sandbox
    fastMartingale: {},
    fast1Config: { ...DEFAULT_FAST1_CONFIG },
    fast2Paper: emptyPaperState(50), // Fast2 sandbox sized to the validated $50 starting balance
    fast2Martingale: {},
    fast2Config: { ...DEFAULT_FAST2_CONFIG },
  };
}

export class BotStorage {
  private readonly file: string;
  private writePromise: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
    this.file = path.join(stateDir, "bot-state.json");
  }

  async load(): Promise<BotState> {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as Partial<BotState>;
      return {
        open: parsed.open ?? [],
        closed: (parsed.closed ?? []).slice(0, MAX_CLOSED_RETAINED),
        daily: parsed.daily ?? { date: "", profit: 0, tradesOpened: 0, capHit: false },
        adaptiveShift: parsed.adaptiveShift ?? emptyAdaptiveShiftState(),
        paper: parsed.paper ?? emptyPaperState(),
        synthPaper: parsed.synthPaper ?? emptyPaperState(),
        fastPaper: parsed.fastPaper ?? emptyPaperState(200),
        fastMartingale: parsed.fastMartingale ?? {},
        fast1Config: { ...DEFAULT_FAST1_CONFIG, ...(parsed.fast1Config ?? {}) },
        fast2Paper: parsed.fast2Paper ?? emptyPaperState(50),
        fast2Martingale: parsed.fast2Martingale ?? {},
        fast2Config: { ...DEFAULT_FAST2_CONFIG, ...(parsed.fast2Config ?? {}) },
      };
    } catch (e: any) {
      if (e?.code === "ENOENT") return emptyBotState();
      throw e;
    }
  }

  /**
   * Atomic save: write to .tmp, fsync, rename. Coalesces concurrent saves
   * so the latest state always wins and we never have overlapping writes.
   */
  save(state: BotState): Promise<void> {
    const next = async () => {
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
    };
    this.writePromise = this.writePromise.then(next, next);
    return this.writePromise;
  }
}

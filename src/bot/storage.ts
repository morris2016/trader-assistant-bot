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

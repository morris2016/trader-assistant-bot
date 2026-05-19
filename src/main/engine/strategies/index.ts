import type { SymbolCode } from "@shared/types";
import type { StrategyDescriptor } from "./types";
import { silverOb } from "./silver-ob";
import { silverFvg } from "./silver-fvg";
import { goldFvg } from "./gold-fvg";
import { platFvg } from "./plat-fvg";

export type { StrategyDescriptor } from "./types";

/**
 * Active real-asset strategies (post 2026-05-03 prune):
 *   silver_ob, silver_fvg, gold_fvg, plat_fvg
 *
 * DROPPED 2026-05-03:
 *   gold_ob   — Mar+Apr 2026 net −$56 / 39t / 19% WR; 8 ICT filters reject ~all
 *               candidates in current regime. Validated config doesn't transfer.
 *   pall_sweep — Mar+Apr 2026 net −$332 / 31t / 16% WR. Sweep detector shows
 *                duplicate-emit pattern on same epoch + regime hostile to sweeps.
 *
 * Earlier drops 2026-04-28: silver_sweep, eth_ob, eth_sweep, eth_fvg, gold_sweep.
 */
// SILENCED 2026-05-19: all "real" asset strategies disabled while Fade-only
// focus is active. Bot runs the boom300n_fade_fast strategy in the Fast
// sandbox only. Re-enable by uncommenting any entry below; the imports
// above are kept so re-enabling is a one-line edit.
export const STRATEGIES: StrategyDescriptor[] = [
  // silverOb,
  // silverFvg,
  // goldFvg,
  // platFvg,
];

export function strategyById(id: string): StrategyDescriptor | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

export function strategiesForSymbol(symbol: SymbolCode): StrategyDescriptor[] {
  return STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

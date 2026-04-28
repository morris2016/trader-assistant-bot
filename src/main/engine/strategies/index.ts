import type { SymbolCode } from "@shared/types";
import type { StrategyDescriptor } from "./types";
import { silverOb } from "./silver-ob";
import { silverFvg } from "./silver-fvg";
import { goldOb } from "./gold-ob";
import { goldFvg } from "./gold-fvg";
import { platFvg } from "./plat-fvg";
import { pallSweep } from "./pall-sweep";

export type { StrategyDescriptor } from "./types";

/**
 * All validated strategies. After 2026-04-28:
 * STRONG (5): silver_ob, silver_fvg, gold_ob, gold_fvg, plat_fvg
 * NEAR-STRONG (1): pall_sweep ($488 combined, TEST 4t excused)
 * DROPPED:    silver_sweep, eth_ob, eth_sweep, eth_fvg, gold_sweep
 *             (gold_sweep deep-retune found best combined $94 — under $500 threshold)
 */
export const STRATEGIES: StrategyDescriptor[] = [
  silverOb,
  silverFvg,
  goldOb,
  goldFvg,
  platFvg,
  pallSweep,
];

export function strategyById(id: string): StrategyDescriptor | undefined {
  return STRATEGIES.find((s) => s.id === id);
}

export function strategiesForSymbol(symbol: SymbolCode): StrategyDescriptor[] {
  return STRATEGIES.filter((s) => s.symbols.includes(symbol));
}

import type { SymbolCode } from "./types";

export type SymbolDef = {
  code: SymbolCode;
  label: string;
  group: "Synthetic" | "FX Majors" | "FX Minors" | "Metals" | "Crypto" | "Commodities";
  /** Pretty-printing precision hint for price display. */
  digits?: number;
  /** Which Deriv contract types this symbol supports. */
  contracts: Array<"CALL_PUT" | "MULTIPLIER">;
};

export const SYMBOLS: SymbolDef[] = [
  // --- Synthetic indices (24/7, GBM) ---------------------------------------
  { code: "R_10",     label: "Volatility 10 Index",    group: "Synthetic", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "R_25",     label: "Volatility 25 Index",    group: "Synthetic", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "R_50",     label: "Volatility 50 Index",    group: "Synthetic", digits: 4, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "R_75",     label: "Volatility 75 Index",    group: "Synthetic", digits: 4, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "R_100",    label: "Volatility 100 Index",   group: "Synthetic", digits: 2, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "1HZ10V",   label: "Volatility 10 (1s)",     group: "Synthetic", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "1HZ25V",   label: "Volatility 25 (1s)",     group: "Synthetic", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "1HZ50V",   label: "Volatility 50 (1s)",     group: "Synthetic", digits: 4, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "1HZ75V",   label: "Volatility 75 (1s)",     group: "Synthetic", digits: 4, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "1HZ100V",  label: "Volatility 100 (1s)",    group: "Synthetic", digits: 2, contracts: ["CALL_PUT", "MULTIPLIER"] },

  // --- FX Majors -----------------------------------------------------------
  { code: "frxEURUSD", label: "EUR / USD", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxGBPUSD", label: "GBP / USD", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxUSDJPY", label: "USD / JPY", group: "FX Majors", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxAUDUSD", label: "AUD / USD", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxUSDCAD", label: "USD / CAD", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxUSDCHF", label: "USD / CHF", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxNZDUSD", label: "NZD / USD", group: "FX Majors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },

  // --- FX Minors / Crosses -------------------------------------------------
  { code: "frxEURGBP", label: "EUR / GBP", group: "FX Minors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxEURJPY", label: "EUR / JPY", group: "FX Minors", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxGBPJPY", label: "GBP / JPY", group: "FX Minors", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxAUDJPY", label: "AUD / JPY", group: "FX Minors", digits: 3, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxEURAUD", label: "EUR / AUD", group: "FX Minors", digits: 5, contracts: ["CALL_PUT", "MULTIPLIER"] },

  // --- Metals --------------------------------------------------------------
  { code: "frxXAUUSD", label: "Gold / USD",   group: "Metals", digits: 2, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "frxXAGUSD", label: "Silver / USD", group: "Metals", digits: 3, contracts: ["CALL_PUT"] },

  // --- Crypto (24/7) -------------------------------------------------------
  { code: "cryBTCUSD", label: "Bitcoin / USD",  group: "Crypto", digits: 2, contracts: ["CALL_PUT", "MULTIPLIER"] },
  { code: "cryETHUSD", label: "Ethereum / USD", group: "Crypto", digits: 2, contracts: ["CALL_PUT", "MULTIPLIER"] },
];

export const DEFAULT_SYMBOL: SymbolCode = "frxEURUSD";

export const SYMBOL_GROUPS = [
  "Synthetic",
  "FX Majors",
  "FX Minors",
  "Metals",
  "Crypto",
  "Commodities",
] as const;

export function symbolDef(code: SymbolCode): SymbolDef | undefined {
  return SYMBOLS.find((s) => s.code === code);
}

export function symbolDigits(code: SymbolCode): number {
  return symbolDef(code)?.digits ?? 3;
}

export function symbolSupports(code: SymbolCode, contract: "CALL_PUT" | "MULTIPLIER"): boolean {
  const def = symbolDef(code);
  return def?.contracts.includes(contract) ?? false;
}

export const GRANULARITY_OPTIONS: { label: string; value: import("./types").Granularity }[] = [
  { label: "1m",  value: 60 },
  { label: "2m",  value: 120 },
  { label: "3m",  value: 180 },
  { label: "5m",  value: 300 },
  { label: "10m", value: 600 },
  { label: "15m", value: 900 },
  { label: "30m", value: 1800 },
  { label: "1h",  value: 3600 },
  { label: "2h",  value: 7200 },
  { label: "4h",  value: 14400 },
  { label: "8h",  value: 28800 },
  { label: "1d",  value: 86400 },
];

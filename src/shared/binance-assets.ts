// 15 crypto assets validated for the SMC trained strategy. Source:
// 5-month hybrid live replay (Nov-Dec 2025 + Feb-Apr 2026 + May 1-20 2026),
// 14 of 15 profitable per asset, 85% WR, 12% max DD, no busts.
//
// Each entry: Binance Futures USDT-margined perpetual symbol.

export const BINANCE_ASSETS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "UNIUSDT", "AAVEUSDT", "LINKUSDT", "DOGEUSDT", "AVAXUSDT",
  "LDOUSDT", "ADAUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT",
] as const;

export type BinanceAsset = typeof BINANCE_ASSETS[number];

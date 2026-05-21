// Channel names — kept in one place so main + preload + renderer stay in sync.
export const CH = {
  getStatus: "app:getStatus",
  getSettings: "app:getSettings",
  setSettings: "app:setSettings",
  setSymbol: "app:setSymbol",
  startWatcher: "app:startWatcher",
  stopWatcher: "app:stopWatcher",
  getHistory: "app:getHistory",
  getCandles: "app:getCandles",
  getPaper: "paper:get",
  resetPaper: "paper:reset",
  closePaperPosition: "paper:close",
  setToken: "auth:setToken",
  clearToken: "auth:clearToken",
  hasToken: "auth:hasToken",

  setDeepseekKey: "auth:setDeepseekKey",
  clearDeepseekKey: "auth:clearDeepseekKey",
  hasDeepseekKey: "auth:hasDeepseekKey",

  setBinanceCreds: "auth:setBinanceCreds",
  clearBinanceCreds: "auth:clearBinanceCreds",
  hasBinanceCreds: "auth:hasBinanceCreds",
  getBinanceTestnet: "auth:getBinanceTestnet",
  setBinanceTestnet: "auth:setBinanceTestnet",
  testBinanceConnection: "binance:testConnection",
  startBinance: "binance:start",
  stopBinance: "binance:stop",
  getBinanceState: "binance:state",

  runBacktest: "backtest:run",

  getSymbolMeta: "app:getSymbolMeta",
  getAllSymbols: "app:getAllSymbols",

  getReal: "real:get",
  getRealGate: "real:gate",
  enableRealMode: "real:enable",
  disableRealMode: "real:disable",
  placeManualTrade: "real:manualTrade",
  closeRealPosition: "real:closePosition",
  resetDailyPnl: "real:resetDaily",

  event: "main:event",
} as const;

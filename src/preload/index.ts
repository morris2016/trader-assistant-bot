import { contextBridge, ipcRenderer } from "electron";
import { CH } from "../main/ipc/channels";
import type {
  BacktestRequest,
  BacktestResult,
  Candle,
  ClosedPaperPosition,
  Granularity,
  MainEvent,
  PaperState,
  RealModeGate,
  RealState,
  RealTrade,
  RealTradeSide,
  Settings,
  SymbolCode,
  SymbolMeta,
  WatcherStatus,
} from "../shared/types";

const api = {
  getStatus: (): Promise<WatcherStatus> => ipcRenderer.invoke(CH.getStatus),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(CH.getSettings),
  setSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(CH.setSettings, patch),
  setSymbol: (symbol: SymbolCode): Promise<WatcherStatus> => ipcRenderer.invoke(CH.setSymbol, symbol),
  startWatcher: (symbol?: SymbolCode): Promise<WatcherStatus> => ipcRenderer.invoke(CH.startWatcher, symbol),
  stopWatcher: (): Promise<WatcherStatus> => ipcRenderer.invoke(CH.stopWatcher),

  getCandles: (symbol: SymbolCode, granularity: Granularity, count: number): Promise<Candle[]> =>
    ipcRenderer.invoke(CH.getCandles, symbol, granularity, count),
  getHistory: (symbol: SymbolCode, granularity: Granularity, count: number, end: number | "latest"): Promise<Candle[]> =>
    ipcRenderer.invoke(CH.getHistory, symbol, granularity, count, end),

  getPaper: (): Promise<PaperState> => ipcRenderer.invoke(CH.getPaper),
  resetPaper: (): Promise<PaperState> => ipcRenderer.invoke(CH.resetPaper),
  closePaperPosition: (id: string, price: number): Promise<PaperState> =>
    ipcRenderer.invoke(CH.closePaperPosition, id, price),

  runBacktest: (req: BacktestRequest): Promise<BacktestResult> => ipcRenderer.invoke(CH.runBacktest, req),

  getSymbolMeta: (symbol: SymbolCode): Promise<SymbolMeta | null> => ipcRenderer.invoke(CH.getSymbolMeta, symbol),
  getAllSymbols: (): Promise<SymbolMeta[]> => ipcRenderer.invoke(CH.getAllSymbols),

  getReal: (): Promise<RealState> => ipcRenderer.invoke(CH.getReal),
  getRealGate: (): Promise<RealModeGate> => ipcRenderer.invoke(CH.getRealGate),
  enableRealMode: (): Promise<{ ok: boolean; reasons?: string[]; error?: string }> =>
    ipcRenderer.invoke(CH.enableRealMode),
  disableRealMode: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.disableRealMode),
  placeManualTrade: (symbol: SymbolCode, side: RealTradeSide): Promise<RealTrade> =>
    ipcRenderer.invoke(CH.placeManualTrade, symbol, side),
  closeRealPosition: (id: string): Promise<RealState> => ipcRenderer.invoke(CH.closeRealPosition, id),
  resetDailyPnl: (): Promise<RealState> => ipcRenderer.invoke(CH.resetDailyPnl),

  hasToken: (): Promise<boolean> => ipcRenderer.invoke(CH.hasToken),
  setToken: (token: string): Promise<boolean> => ipcRenderer.invoke(CH.setToken, token),
  clearToken: (): Promise<boolean> => ipcRenderer.invoke(CH.clearToken),

  hasDeepseekKey: (): Promise<boolean> => ipcRenderer.invoke(CH.hasDeepseekKey),
  setDeepseekKey: (key: string): Promise<boolean> => ipcRenderer.invoke(CH.setDeepseekKey, key),
  clearDeepseekKey: (): Promise<boolean> => ipcRenderer.invoke(CH.clearDeepseekKey),

  hasBinanceCreds: (): Promise<boolean> => ipcRenderer.invoke(CH.hasBinanceCreds),
  setBinanceCreds: (apiKey: string, apiSecret: string): Promise<boolean> =>
    ipcRenderer.invoke(CH.setBinanceCreds, apiKey, apiSecret),
  clearBinanceCreds: (): Promise<boolean> => ipcRenderer.invoke(CH.clearBinanceCreds),
  getBinanceTestnet: (): Promise<boolean> => ipcRenderer.invoke(CH.getBinanceTestnet),
  setBinanceTestnet: (testnet: boolean): Promise<boolean> => ipcRenderer.invoke(CH.setBinanceTestnet, testnet),
  testBinanceConnection: (): Promise<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string }> =>
    ipcRenderer.invoke(CH.testBinanceConnection),
  startBinance: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke(CH.startBinance),
  stopBinance: (): Promise<{ ok: boolean }> => ipcRenderer.invoke(CH.stopBinance),
  getBinanceState: (): Promise<{ state: any; enabled: boolean; hasCreds: boolean; testnet: boolean }> =>
    ipcRenderer.invoke(CH.getBinanceState),

  onEvent: (handler: (ev: MainEvent) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: MainEvent) => handler(ev);
    ipcRenderer.on(CH.event, listener);
    return () => ipcRenderer.removeListener(CH.event, listener);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld("api", api);

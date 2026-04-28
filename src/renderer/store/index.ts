import { create } from "zustand";
import type {
  Candle,
  DetectorDiagnostics,
  Granularity,
  LiquidityPool,
  OrderBlock,
  PaperState,
  RealModeGate,
  RealState,
  RealTradeSide,
  RegimeSnapshot,
  Settings,
  Signal,
  StructureMark,
  SymbolCode,
  SymbolMeta,
  Tick,
  WatcherStatus,
} from "@shared/types";

const SIGNAL_LIMIT = 200;

type State = {
  status: WatcherStatus;
  settings: Settings | null;
  candles: Candle[];
  lastTick: Tick | null;
  orderBlocks: Map<string, OrderBlock>;
  signals: Signal[];
  paper: PaperState | null;
  real: RealState | null;
  realGate: RealModeGate | null;
  realErrors: { id: number; message: string; ts: number }[];
  regime: RegimeSnapshot | null;
  structureMarks: StructureMark[];
  liquidityPools: Map<string, LiquidityPool>;
  symbolMeta: SymbolMeta | null;
  detectorDiagnostics: Map<string, DetectorDiagnostics>;

  // actions
  init: () => Promise<void>;
  wireEvents: () => () => void;
  setSymbol: (s: SymbolCode) => Promise<void>;
  setGranularity: (g: Granularity) => Promise<void>;
  startWatcher: () => Promise<void>;
  stopWatcher: () => Promise<void>;
  resetPaper: () => Promise<void>;
  reloadCandles: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  refreshRealGate: () => Promise<void>;
  enableReal: () => Promise<{ ok: boolean; reasons?: string[]; error?: string }>;
  disableReal: () => Promise<void>;
  placeManualTrade: (side: RealTradeSide) => Promise<void>;
  closeRealPosition: (id: string) => Promise<void>;
  resetDailyReal: () => Promise<void>;
  dismissRealError: (id: number) => void;
};

const emptyStatus: WatcherStatus = {
  wsConnected: false,
  activeSymbol: null,
  watching: false,
  tokenConfigured: false,
  realModeEnabled: false,
  account: null,
};

let errId = 0;

export const useStore = create<State>((set, get) => ({
  status: emptyStatus,
  settings: null,
  candles: [],
  lastTick: null,
  orderBlocks: new Map(),
  signals: [],
  paper: null,
  real: null,
  realGate: null,
  realErrors: [],
  regime: null,
  structureMarks: [],
  liquidityPools: new Map(),
  symbolMeta: null,
  detectorDiagnostics: new Map(),

  init: async () => {
    const [status, settings, paper, real, realGate] = await Promise.all([
      window.api.getStatus(),
      window.api.getSettings(),
      window.api.getPaper(),
      window.api.getReal(),
      window.api.getRealGate(),
    ]);
    set({ status, settings, paper, real, realGate });
    if (settings) {
      const candles = await window.api.getCandles(settings.activeSymbol, settings.granularity, 500);
      set({ candles });
      const symbolMeta = await window.api.getSymbolMeta(settings.activeSymbol);
      set({ symbolMeta });
    }
  },

  wireEvents: () => {
    const off = window.api.onEvent((ev) => {
      switch (ev.type) {
        case "candle": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.symbol !== active) return;
          const prev = get().candles;
          if (prev.length === 0) {
            set({ candles: [ev.candle] });
            return;
          }
          const last = prev[prev.length - 1];
          if (last.epoch === ev.candle.epoch) {
            const next = prev.slice(0, -1);
            next.push(ev.candle);
            set({ candles: next });
          } else if (ev.candle.epoch > last.epoch) {
            set({ candles: [...prev, ev.candle] });
          }
          break;
        }
        case "tick": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.tick.symbol !== active) return;
          set({ lastTick: ev.tick });
          break;
        }
        case "orderBlock": {
          const m = new Map(get().orderBlocks);
          m.set(ev.block.id, ev.block);
          set({ orderBlocks: m });
          break;
        }
        case "orderBlockMitigated": {
          const m = new Map(get().orderBlocks);
          m.delete(ev.id);
          set({ orderBlocks: m });
          break;
        }
        case "signal": {
          const sigs = [ev.signal, ...get().signals].slice(0, SIGNAL_LIMIT);
          set({ signals: sigs });
          break;
        }
        case "status": {
          set({ status: ev.status });
          break;
        }
        case "paper": {
          set({ paper: ev.state });
          break;
        }
        case "real": {
          set({ real: ev.state });
          break;
        }
        case "regime": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.regime.symbol === active) set({ regime: ev.regime });
          break;
        }
        case "structureMark": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.mark.symbol !== active) break;
          const next = [...get().structureMarks, ev.mark];
          // Keep the last 80 marks on the chart — older ones age out.
          set({ structureMarks: next.length > 80 ? next.slice(-80) : next });
          break;
        }
        case "liquidityPool": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.pool.symbol !== active) break;
          const m = new Map(get().liquidityPools);
          m.set(ev.pool.id, ev.pool);
          set({ liquidityPools: m });
          break;
        }
        case "liquidityPoolSwept": {
          const m = new Map(get().liquidityPools);
          const p = m.get(ev.id);
          if (p) {
            m.set(ev.id, { ...p, sweptEpoch: ev.sweptEpoch });
            set({ liquidityPools: m });
          }
          break;
        }
        case "liquidityPoolRemoved": {
          const m = new Map(get().liquidityPools);
          m.delete(ev.id);
          set({ liquidityPools: m });
          break;
        }
        case "detectorDiagnostics": {
          const active = get().status.activeSymbol ?? get().settings?.activeSymbol;
          if (ev.diagnostics.symbol !== active) break;
          const m = new Map(get().detectorDiagnostics);
          m.set(ev.diagnostics.detector, ev.diagnostics);
          set({ detectorDiagnostics: m });
          break;
        }
        case "realTradeOpened":
        case "realTradeSettled": {
          // Trade-level events — main also emits "real" with the full state.
          break;
        }
        case "realCapHit": {
          set({
            realErrors: [
              ...get().realErrors,
              { id: ++errId, message: `Daily loss cap hit (${ev.dailyLoss.toFixed(2)} / ${ev.cap.toFixed(2)}). Real mode paused.`, ts: Date.now() },
            ],
          });
          break;
        }
        case "realError": {
          const existing = get().realErrors;
          // Dedupe: if the most recent error has the same message, just refresh its ts.
          const last = existing[existing.length - 1];
          if (last && last.message === ev.message) {
            set({ realErrors: [...existing.slice(0, -1), { ...last, ts: Date.now() }] });
          } else {
            set({
              realErrors: [...existing, { id: ++errId, message: ev.message, ts: Date.now() }].slice(-10),
            });
          }
          break;
        }
      }
    });
    return off;
  },

  setSymbol: async (sym) => {
    const status = await window.api.setSymbol(sym);
    set({ status, candles: [], orderBlocks: new Map(), signals: [], regime: null, structureMarks: [], liquidityPools: new Map(), symbolMeta: null, detectorDiagnostics: new Map() });
    const g = get().settings?.granularity ?? 60;
    const [candles, symbolMeta, settings] = await Promise.all([
      window.api.getCandles(sym, g, 1000),
      window.api.getSymbolMeta(sym),
      window.api.getSettings(),
    ]);
    set({ candles, symbolMeta, settings });
  },

  setGranularity: async (g) => {
    // Clear all per-bar overlays — they're granularity-specific.
    set({ candles: [], orderBlocks: new Map(), signals: [], structureMarks: [], liquidityPools: new Map(), regime: null, detectorDiagnostics: new Map() });
    const settings = await window.api.setSettings({ granularity: g });
    set({ settings });
    const sym = get().status.activeSymbol ?? settings.activeSymbol;
    // Pull initial history at the new granularity; live stream then takes over.
    const candles = await window.api.getCandles(sym, g, 1000);
    set({ candles });
  },

  startWatcher: async () => {
    const status = await window.api.startWatcher();
    set({ status });
  },

  stopWatcher: async () => {
    const status = await window.api.stopWatcher();
    set({ status });
  },

  resetPaper: async () => {
    const paper = await window.api.resetPaper();
    set({ paper });
  },

  reloadCandles: async () => {
    const s = get().settings;
    if (!s) return;
    const candles = await window.api.getCandles(s.activeSymbol, s.granularity, 500);
    set({ candles });
  },

  updateSettings: async (patch) => {
    const settings = await window.api.setSettings(patch);
    set({ settings });
    // Risk-cap or token-state changes can flip the gate.
    const realGate = await window.api.getRealGate();
    set({ realGate });
  },

  refreshRealGate: async () => {
    const realGate = await window.api.getRealGate();
    set({ realGate });
  },

  enableReal: async () => {
    const res = await window.api.enableRealMode();
    const [status, realGate, real] = await Promise.all([
      window.api.getStatus(),
      window.api.getRealGate(),
      window.api.getReal(),
    ]);
    set({ status, realGate, real });
    return res;
  },

  disableReal: async () => {
    await window.api.disableRealMode();
    const status = await window.api.getStatus();
    set({ status });
  },

  placeManualTrade: async (side) => {
    const sym = get().status.activeSymbol ?? get().settings?.activeSymbol;
    if (!sym) throw new Error("No active symbol");
    try {
      await window.api.placeManualTrade(sym, side);
    } catch (e) {
      set({
        realErrors: [
          ...get().realErrors,
          { id: ++errId, message: (e as Error).message, ts: Date.now() },
        ].slice(-10),
      });
    }
  },

  closeRealPosition: async (id) => {
    try {
      const real = await window.api.closeRealPosition(id);
      set({ real });
    } catch (e) {
      set({
        realErrors: [
          ...get().realErrors,
          { id: ++errId, message: (e as Error).message, ts: Date.now() },
        ].slice(-10),
      });
    }
  },

  resetDailyReal: async () => {
    const real = await window.api.resetDailyPnl();
    set({ real });
  },

  dismissRealError: (id) => {
    set({ realErrors: get().realErrors.filter((e) => e.id !== id) });
  },
}));

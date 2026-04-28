import Store from "electron-store";
import { safeStorage } from "electron";
import type {
  ClosedPaperPosition,
  PaperPosition,
  RealState,
  RealTrade,
  Settings,
  SymbolCode,
} from "@shared/types";
import { ALL_DETECTORS, defaultDetectorConfigs } from "../engine/runner";
import { DEFAULT_SYMBOL } from "@shared/symbols";
import {
  emptyAdaptiveShiftState,
  type AdaptiveShiftState,
} from "../engine/adaptive-shift";

type Schema = {
  settings: Settings;
  paper: { open: PaperPosition[]; closed: ClosedPaperPosition[] };
  real: { open: RealTrade[]; closed: RealTrade[]; daily: RealState["daily"] };
  /** Adaptive shift state — persists across bot restarts so loss-streak/throttle survives reboots. */
  adaptiveShift: AdaptiveShiftState;
  // API token stored as a base64-encoded encrypted blob (via safeStorage),
  // or empty string when unset.
  encryptedToken: string;
  /** DeepSeek API key, encrypted at rest the same way as the Deriv token. */
  encryptedDeepseekKey: string;
};

const defaults: Schema = {
  settings: {
    activeSymbol: DEFAULT_SYMBOL,
    granularity: 60,
    detectors: defaultDetectorConfigs(),
    strategy: {
      // TEMP relaxed: was "trend-confluence" (ADX>22 + 2 detectors agreeing within 3 bars).
      // Switch to "raw" so every detector signal passes through. Re-tighten after edge is verified.
      mode: "raw",
      adxThreshold: 22,
      confluenceWindowBars: 3,
    },
    signalSource: "deepseek",
    deepseekMinConfidence: 0.55,
    risk: {
      perTradeMaxStake: 10,
      dailyMaxLoss: 50,
      realModeConfirmed: false,
    },
    realTrading: {
      contractFamily: "MULTIPLIER",
      durationTicks: 10,
      multiplier: 30,
      tpSlMode: "atr",
      takeProfitPct: 20,
      stopLossPct: 10,
      atrTpMult: 2,
      atrSlMult: 1,
      autoTradeOnSignal: false,
    },
  },
  paper: { open: [], closed: [] },
  real: { open: [], closed: [], daily: { date: "", profit: 0, tradesOpened: 0, capHit: false } },
  adaptiveShift: emptyAdaptiveShiftState(),
  encryptedToken: "",
  encryptedDeepseekKey: "",
};

const store = new Store<Schema>({
  name: "trader-assistant",
  defaults,
});

export function getSettings(): Settings {
  // Merge defaults for detectors so newly-added detectors show up. Also
  // reconcile PARAM KEYS within each persisted detector against the current
  // detector's `defaultParams` — add new keys, drop removed keys, preserve
  // user-edited values for keys that still exist.
  const s = store.get("settings");
  const detectorById = new Map(ALL_DETECTORS.map((d) => [d.id, d] as const));
  const reconciled = s.detectors
    .filter((d) => detectorById.has(d.id))
    .map((d) => {
      const det = detectorById.get(d.id)!;
      const mergedParams: Record<string, number> = {};
      for (const [k, defaultVal] of Object.entries(det.defaultParams)) {
        mergedParams[k] = d.params[k] !== undefined ? d.params[k] : defaultVal;
      }
      return { ...d, label: det.label, params: mergedParams };
    });
  const knownIds = new Set(reconciled.map((d) => d.id));
  for (const d of defaultDetectorConfigs()) {
    if (!knownIds.has(d.id)) reconciled.push(d);
  }
  const defRT = defaults.settings.realTrading;
  const defStrategy = defaults.settings.strategy;
  return {
    ...s,
    detectors: reconciled,
    strategy: { ...defStrategy, ...(s.strategy ?? {}) },
    realTrading: { ...defRT, ...(s.realTrading ?? {}) },
    signalSource: s.signalSource ?? defaults.settings.signalSource,
    deepseekMinConfidence: s.deepseekMinConfidence ?? defaults.settings.deepseekMinConfidence,
  };
}

export function setSettings(patch: Partial<Settings>) {
  const current = getSettings();
  store.set("settings", { ...current, ...patch });
}

export function setActiveSymbol(symbol: SymbolCode) {
  setSettings({ activeSymbol: symbol });
}

export function getPaperState() {
  return store.get("paper");
}

export function setPaperState(open: PaperPosition[], closed: ClosedPaperPosition[]) {
  store.set("paper", { open, closed });
}

export function getRealState() {
  return store.get("real");
}

export function setRealState(state: Schema["real"]) {
  store.set("real", state);
}

export function getAdaptiveShiftState(): AdaptiveShiftState {
  // Defensive: if the field is missing in a pre-existing store, return defaults.
  const v = store.get("adaptiveShift") as AdaptiveShiftState | undefined;
  return v && typeof v === "object" ? { ...emptyAdaptiveShiftState(), ...v } : emptyAdaptiveShiftState();
}

export function setAdaptiveShiftState(state: AdaptiveShiftState) {
  store.set("adaptiveShift", state);
}

export function getDerivToken(): string | null {
  const blob = store.get("encryptedToken");
  if (!blob) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = Buffer.from(blob, "base64");
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function setDerivToken(token: string | null) {
  if (!token) {
    store.set("encryptedToken", "");
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain unavailable; cannot encrypt token");
  }
  const buf = safeStorage.encryptString(token);
  store.set("encryptedToken", buf.toString("base64"));
}

export function hasToken(): boolean {
  return !!store.get("encryptedToken");
}

export function getDeepseekKey(): string | null {
  const blob = store.get("encryptedDeepseekKey");
  if (!blob) return null;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    const buf = Buffer.from(blob, "base64");
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

export function setDeepseekKey(key: string | null) {
  if (!key) {
    store.set("encryptedDeepseekKey", "");
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("OS keychain unavailable; cannot encrypt DeepSeek key");
  }
  const buf = safeStorage.encryptString(key);
  store.set("encryptedDeepseekKey", buf.toString("base64"));
}

export function hasDeepseekKey(): boolean {
  return !!store.get("encryptedDeepseekKey");
}

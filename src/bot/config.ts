// Bot configuration loaded from environment variables.
// Validated on boot — process exits early if required vars are missing.

export type BotConfig = {
  derivToken: string;
  derivAppId: string;
  stake: number;
  dailyMaxLoss: number;
  contractFamily: "MULTIPLIER" | "CALL_PUT";
  multiplier: number;
  durationTicks: number;
  tpSlMode: "atr" | "percent";
  atrTpMult: number;
  atrSlMult: number;
  takeProfitPct: number;
  stopLossPct: number;
  /** Directory for state persistence (mounted volume on Railway). */
  stateDir: string;
  /** HTTP port for /health, /state, /trades. Railway injects PORT env. */
  httpPort: number;
  logLevel: "trace" | "debug" | "info" | "warn" | "error";
  /** Set to "true" to actually place orders. "false" = signal-only dry-run. */
  liveTradingEnabled: boolean;
};

function getEnv(key: string, required = true): string {
  const v = process.env[key];
  if (required && (v === undefined || v === "")) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v ?? "";
}

function getNum(key: string, def?: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") {
    if (def === undefined) throw new Error(`Missing required env var: ${key}`);
    return def;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${key} must be a number, got "${v}"`);
  return n;
}

function getBool(key: string, def = false): boolean {
  const v = process.env[key];
  if (v === undefined) return def;
  return v.toLowerCase() === "true" || v === "1";
}

export function loadConfig(): BotConfig {
  const family = (process.env.CONTRACT_FAMILY ?? "MULTIPLIER").toUpperCase() as "MULTIPLIER" | "CALL_PUT";
  if (family !== "MULTIPLIER" && family !== "CALL_PUT") {
    throw new Error(`CONTRACT_FAMILY must be MULTIPLIER or CALL_PUT, got "${family}"`);
  }
  const tpSl = (process.env.TP_SL_MODE ?? "atr").toLowerCase() as "atr" | "percent";
  if (tpSl !== "atr" && tpSl !== "percent") {
    throw new Error(`TP_SL_MODE must be atr or percent, got "${tpSl}"`);
  }
  const log = (process.env.LOG_LEVEL ?? "info").toLowerCase() as BotConfig["logLevel"];

  return {
    derivToken: getEnv("DERIV_TOKEN"),
    derivAppId: process.env.DERIV_APP_ID ?? "1089",
    stake: getNum("STAKE", 40),
    dailyMaxLoss: getNum("DAILY_MAX_LOSS", 50),
    contractFamily: family,
    multiplier: getNum("MULTIPLIER", 30),
    durationTicks: getNum("DURATION_TICKS", 10),
    tpSlMode: tpSl,
    atrTpMult: getNum("ATR_TP_MULT", 2),
    atrSlMult: getNum("ATR_SL_MULT", 1),
    takeProfitPct: getNum("TP_PCT", 20),
    stopLossPct: getNum("SL_PCT", 10),
    stateDir: process.env.STATE_DIR ?? "./state",
    httpPort: getNum("PORT", 3000),
    logLevel: log,
    liveTradingEnabled: getBool("LIVE_TRADING", false),
  };
}

export function describeConfig(c: BotConfig): string {
  return [
    `tradingMode=${c.liveTradingEnabled ? "LIVE" : "DRY-RUN"}`,
    `stake=$${c.stake}`,
    `dailyCap=$${c.dailyMaxLoss}`,
    `family=${c.contractFamily}`,
    `tpSl=${c.tpSlMode}(tp×${c.atrTpMult}, sl×${c.atrSlMult})`,
    `mult=${c.multiplier}`,
    `stateDir=${c.stateDir}`,
    `httpPort=${c.httpPort}`,
  ].join(" · ");
}

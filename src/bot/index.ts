// Headless bot entrypoint — designed for Railway 24/7 hosting.
//
// Wires together:
//   - Deriv WS client + auto-reconnect
//   - Engine (multi-symbol detector state)
//   - RealEngine (placeTrade with adaptive shift)
//   - Multi-symbol subscriptions for all registered strategies
//   - File-based persistence (BotStorage)
//   - Structured JSON logger
//   - HTTP health/state endpoint
//   - Graceful SIGTERM shutdown

import { DerivClient } from "../main/deriv/client";
import { Engine, defaultDetectorConfigs } from "../main/engine/runner";
import { RealEngine } from "../main/engine/real";
import { STRATEGIES } from "../main/engine/strategies";
import { strategiesForSymbol } from "../main/engine/strategies";
import type { Candle, Signal, SymbolCode } from "@shared/types";
import { loadConfig, describeConfig } from "./config";
import { Logger } from "./logger";
import { BotStorage } from "./storage";
import { startHealthServer } from "./health";

async function main() {
  // Start a minimal logger BEFORE config so any config error gets logged.
  const bootLog = new Logger((process.env.LOG_LEVEL as any) ?? "info");
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    // Config invalid — keep container alive so Railway healthcheck passes,
    // surface the error via /state. Operator fixes env vars and Railway redeploys.
    bootLog.error("config load failed — bot will idle, fix env vars and redeploy", { err: (e as Error).message });
    const port = Number(process.env.PORT ?? 3000);
    const idleHealth = startHealthServer({
      port,
      logger: bootLog,
      getHealth: () => ({ wsConnected: false, authorized: false, uptimeSec: 0 }),
      getState: () => ({ open: [], closed: [], daily: { date: "", profit: 0, tradesOpened: 0, capHit: false }, adaptiveShift: { consecLosses: 0, buyHistory: [], sellHistory: [], metalsLossEpochs: [], metalsThrottleUntil: 0 } }),
      getAdaptiveShiftDescription: () => `config error: ${(e as Error).message}`,
    });
    process.on("SIGTERM", () => { idleHealth.close().finally(() => process.exit(0)); });
    process.on("SIGINT", () => { idleHealth.close().finally(() => process.exit(0)); });
    return; // idle forever; do not throw (would trigger restart loop)
  }
  const log = new Logger(cfg.logLevel);
  log.info("bot starting", { config: describeConfig(cfg), strategies: STRATEGIES.map((s) => s.id) });

  const storage = new BotStorage(cfg.stateDir);
  const persisted = await storage.load();
  log.info("state loaded", { closed: persisted.closed.length, open: persisted.open.length });

  const deriv = new DerivClient({ appId: cfg.derivAppId });
  const engine = new Engine(defaultDetectorConfigs(), { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
  const real = new RealEngine(deriv);
  real.load(persisted);
  real.loadAdaptiveShift(persisted.adaptiveShift);
  real.setCaps(cfg.stake, cfg.dailyMaxLoss);

  let wsConnected = false;
  let authorized = false;
  const startTs = Date.now();
  let shuttingDown = false;
  const subscribedKeys = new Set<string>();

  const persist = () => {
    const s = real.state();
    storage.save({
      open: s.open,
      closed: s.closed,
      daily: s.daily,
      adaptiveShift: real.getAdaptiveShift(),
    }).catch((e) => log.error("persist failed", { err: (e as Error).message }));
  };

  // Persist on every state change (settle, open, capHit, adaptive update)
  real.on("opened", (t) => { log.info("trade opened", { symbol: t.symbol, side: t.side, stake: t.stake, detector: t.detector, contractId: t.contractId }); persist(); });
  real.on("settled", (t) => { log.info("trade settled", { symbol: t.symbol, side: t.side, profit: t.profit, status: t.status }); persist(); });
  real.on("capHit", (loss, cap) => { log.warn("daily loss cap hit", { loss, cap }); persist(); });
  real.on("adaptiveShiftChanged", () => { log.info("adaptive shift updated", { state: real.describeAdaptiveShift() }); persist(); });
  real.on("error", (err) => log.error("real engine error", { err: err.message }));

  // Health HTTP server
  const health = startHealthServer({
    port: cfg.httpPort,
    logger: log,
    getHealth: () => ({ wsConnected, authorized, uptimeSec: Math.floor((Date.now() - startTs) / 1000) }),
    getState: () => {
      const s = real.state();
      return { open: s.open, closed: s.closed, daily: s.daily, adaptiveShift: real.getAdaptiveShift() };
    },
    getAdaptiveShiftDescription: () => real.describeAdaptiveShift(),
  });

  // Subscribe to all (symbol, granularity) pairs from STRATEGIES
  async function subscribeAll() {
    const pairs = new Set<string>();
    for (const s of STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    for (const key of pairs) {
      if (subscribedKeys.has(key)) continue;
      const [sym, grStr] = key.split("|");
      const gr = Number(grStr);
      try {
        const history = await deriv.subscribeCandles(sym as SymbolCode, gr, 1000);
        engine.seed(sym as SymbolCode, history);
        await deriv.subscribeTicks(sym as SymbolCode);
        subscribedKeys.add(key);
        log.info("subscribed", { symbol: sym, granularity: gr, seeded: history.length });
      } catch (e) {
        log.error("subscribe failed", { symbol: sym, granularity: gr, err: (e as Error).message });
      }
    }
  }

  // Candle handler — runs detectors and routes signals to placeTrade
  deriv.on("candle", (symbol, candle, isNew) => {
    const r = engine.onCandle(symbol, candle, isNew);
    for (const sig of r.signals) {
      log.info("signal", { symbol: sig.symbol, side: sig.action, detector: sig.detector, confidence: sig.confidence });
      executeSignal(sig, candle).catch((e) => log.error("execute failed", { err: (e as Error).message }));
    }
  });

  async function executeSignal(sig: Signal, candle: Candle): Promise<void> {
    if (!cfg.liveTradingEnabled) {
      log.info("dry-run skip", { symbol: sig.symbol, side: sig.action });
      return;
    }
    // Match signal to a registered strategy on this symbol — only those gate live trades.
    const matches = strategiesForSymbol(sig.symbol).filter((s) =>
      s.detectors.some((d) => d.id === sig.detector && d.enabled),
    );
    if (matches.length === 0) {
      log.debug("signal not matched to any registered strategy — ignored", { symbol: sig.symbol, detector: sig.detector });
      return;
    }
    const gate = real.canOpen();
    if (!gate.ok) {
      log.info("trade gated", { reason: gate.reason });
      return;
    }
    try {
      const trade = await real.placeTrade({
        symbol: sig.symbol,
        side: sig.action,
        family: cfg.contractFamily,
        durationTicks: cfg.durationTicks,
        multiplier: cfg.multiplier,
        tpSlMode: cfg.tpSlMode,
        takeProfitPct: cfg.takeProfitPct,
        stopLossPct: cfg.stopLossPct,
        atrTpMult: cfg.atrTpMult,
        atrSlMult: cfg.atrSlMult,
        atr: engine.atrFor(sig.symbol),
        entryPriceHint: engine.lastCloseFor(sig.symbol) ?? candle.close,
        detector: sig.detector,
      });
      log.info("placeTrade ok", { id: trade.id, contractId: trade.contractId, stake: trade.stake });
    } catch (e) {
      log.error("placeTrade failed", { err: (e as Error).message, symbol: sig.symbol, side: sig.action });
    }
  }

  // WS lifecycle. DerivClient has its own auto-reconnect — we just react to events.
  deriv.on("open", async () => {
    wsConnected = true;
    log.info("ws connected");
    try {
      const info = await deriv.authorize(cfg.derivToken);
      real.setAccount({
        loginid: info.loginid ?? "",
        currency: info.currency ?? "USD",
        balance: info.balance ?? 0,
        isVirtual: info.is_virtual === 1,
        fullname: info.fullname,
        email: info.email,
      });
      authorized = true;
      log.info("authorized", { loginid: info.loginid, currency: info.currency, virtual: info.is_virtual === 1, balance: info.balance });
      await deriv.subscribeBalance().catch((e) => log.warn("subscribeBalance failed", { err: (e as Error).message }));
      subscribedKeys.clear();
      await subscribeAll();
      log.info("bot ready", { liveTrading: cfg.liveTradingEnabled, strategies: STRATEGIES.length, subs: subscribedKeys.size });
    } catch (e) {
      log.error("authorize/subscribe failed", { err: (e as Error).message });
      authorized = false;
    }
  });

  deriv.on("close", () => {
    wsConnected = false;
    authorized = false;
    subscribedKeys.clear();
    log.warn("ws closed (client will auto-reconnect)");
  });
  deriv.on("error", (err) => log.error("deriv error", { err: err.message ?? String(err) }));
  deriv.on("balance", (b) => log.debug("balance", { balance: b.balance, currency: b.currency }));

  // Graceful shutdown
  const shutdown = async (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn("shutdown initiated", { signal: sig });
    persist();
    try {
      await deriv.forgetAll("candles").catch(() => undefined);
      await deriv.forgetAll("ticks").catch(() => undefined);
    } catch {}
    try { deriv.close(); } catch {}
    await health.close().catch(() => undefined);
    log.info("shutdown complete");
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { err: err.message, stack: err.stack });
    shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", { reason: String(reason) });
  });

  // Kick off the connection — the rest cascades from the "open" event.
  deriv.connect();
}

main().catch((e) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", msg: "fatal", err: (e as Error).message, stack: (e as Error).stack }));
  process.exit(1);
});

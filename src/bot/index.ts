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
import { emptyAdaptiveShiftState } from "../main/engine/adaptive-shift";
import type { AccountInfo, Candle, Signal, SymbolCode } from "@shared/types";
import { loadConfig, describeConfig } from "./config";
import { Logger } from "./logger";
import { BotStorage } from "./storage";
import { startHttpServer } from "./http-server";
import { PaperEngine, emptyPaperState } from "./paper-engine";
import path from "node:path";

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
    const idleHttp = startHttpServer({
      port,
      logger: bootLog,
      webDir: path.resolve(process.env.WEB_DIR ?? "/app/web"),
      getHealth: () => ({ wsConnected: false, authorized: false, uptimeSec: 0 }),
      getState: () => ({ open: [], closed: [], daily: { date: "", profit: 0, tradesOpened: 0, capHit: false }, adaptiveShift: emptyAdaptiveShiftState() }),
      getAccount: () => null,
      getRecentSignals: () => [],
      getAdaptiveShiftDescription: () => `config error: ${(e as Error).message}`,
      manualControls: { isPaused: () => true, setPaused: () => {}, resetAdaptiveShift: () => {}, resetDaily: () => {}, resetPaper: () => {} },
      getCandles: () => [],
      getStrategyStats: () => [],
      getConfig: () => ({ error: (e as Error).message }),
      getSubscriptions: () => [],
      getPaperState: () => emptyPaperState(),
      getPaperStats: () => ({}),
    });
    process.on("SIGTERM", () => { idleHttp.close().finally(() => process.exit(0)); });
    process.on("SIGINT", () => { idleHttp.close().finally(() => process.exit(0)); });
    return; // idle forever; do not throw (would trigger restart loop)
  }
  const log = new Logger(cfg.logLevel);
  log.info("bot starting", { config: describeConfig(cfg), strategies: STRATEGIES.map((s) => s.id) });

  const storage = new BotStorage(cfg.stateDir);
  const persisted = await storage.load();
  log.info("state loaded", { closed: persisted.closed.length, open: persisted.open.length, paperTrades: persisted.paper.closed.length, paperBalance: persisted.paper.balance });

  // If paper state hasn't been initialized (or was reset), seed with config balance
  if (persisted.paper.startingBalance !== cfg.paperStartingBalance && persisted.paper.closed.length === 0 && persisted.paper.open.length === 0) {
    log.info("paper: seeding fresh state", { startingBalance: cfg.paperStartingBalance });
    persisted.paper = emptyPaperState(cfg.paperStartingBalance);
  }
  const paper = new PaperEngine(persisted.paper);

  const deriv = new DerivClient({ appId: cfg.derivAppId });
  // One Engine instance per (symbol, granularity). Engine state (detector pools,
  // ATR/ADX windows, recent signals) is symbol-keyed internally — running two
  // granularities of the same symbol on the SAME engine collides them. Separate
  // engines preserve correct per-strategy detector state.
  const engines = new Map<string, Engine>();
  const chartBuffers = new Map<string, Candle[]>();
  const engKey = (sym: string, gr: number) => `${sym}|${gr}`;
  const real = new RealEngine(deriv);
  real.load(persisted);
  real.loadAdaptiveShift(persisted.adaptiveShift);
  real.setCaps(cfg.stake, cfg.dailyMaxLoss);

  let wsConnected = false;
  let authorized = false;
  let isFirstConnection = true;
  let account: AccountInfo | null = null;
  let manualPaused = false;
  const startTs = Date.now();
  let shuttingDown = false;
  const subscribedKeys = new Set<string>();
  const recentSignals: Signal[] = [];
  const SIGNAL_HISTORY = 200;

  const persist = () => {
    const s = real.state();
    storage.save({
      open: s.open,
      closed: s.closed,
      daily: s.daily,
      adaptiveShift: real.getAdaptiveShift(),
      paper: paper.getState(),
    }).catch((e) => log.error("persist failed", { err: (e as Error).message }));
  };
  paper.onChange(() => persist());

  // Persist on every state change (settle, open, capHit, adaptive update)
  real.on("opened", (t) => { log.info("trade opened", { symbol: t.symbol, side: t.side, stake: t.stake, detector: t.detector, contractId: t.contractId }); persist(); });
  real.on("settled", (t) => { log.info("trade settled", { symbol: t.symbol, side: t.side, profit: t.profit, status: t.status }); persist(); });
  real.on("capHit", (loss, cap) => { log.warn("daily loss cap hit", { loss, cap }); persist(); });
  real.on("adaptiveShiftChanged", () => { log.info("adaptive shift updated", { state: real.describeAdaptiveShift() }); persist(); });
  real.on("error", (err) => log.error("real engine error", { err: err.message }));

  // HTTP server (API + static UI)
  const httpServer = startHttpServer({
    port: cfg.httpPort,
    logger: log,
    webDir: path.resolve(process.env.WEB_DIR ?? "/app/web"),
    getHealth: () => ({ wsConnected, authorized, uptimeSec: Math.floor((Date.now() - startTs) / 1000) }),
    getState: () => {
      const s = real.state();
      return { open: s.open, closed: s.closed, daily: s.daily, adaptiveShift: real.getAdaptiveShift() };
    },
    getAccount: () => account,
    getRecentSignals: () => recentSignals,
    getAdaptiveShiftDescription: () => real.describeAdaptiveShift(),
    manualControls: {
      isPaused: () => manualPaused,
      setPaused: (p: boolean) => { manualPaused = p; log.warn(`manual ${p ? "PAUSE" : "RESUME"} via API`); },
      resetAdaptiveShift: () => { real.loadAdaptiveShift(emptyAdaptiveShiftState()); persist(); log.warn("adaptive shift state reset via API"); },
      resetDaily: () => { real.resetDaily(); persist(); log.warn("daily P&L reset via API"); },
      resetPaper: (balance?: number) => { paper.reset(balance ?? cfg.paperStartingBalance); log.warn(`paper reset via API to $${(balance ?? cfg.paperStartingBalance).toFixed(2)}`); },
    },
    getCandles: (sym, gr, limit) => (chartBuffers.get(engKey(sym, gr)) ?? []).slice(-limit),
    getStrategyStats: () => {
      const closed = real.state().closed;
      const sigs = recentSignals;
      return STRATEGIES.map((s) => {
        const detIds = s.detectors.filter((d) => d.enabled).map((d) => d.id);
        const sSyms = new Set(s.symbols);
        const sigsForStrat = sigs.filter((sg) => sSyms.has(sg.symbol) && detIds.includes(sg.detector));
        const tradesForStrat = closed.filter((t) => sSyms.has(t.symbol) && detIds.includes(t.detector));
        const wins = tradesForStrat.filter((t) => (t.profit ?? 0) > 0).length;
        const pnl = tradesForStrat.reduce((acc, t) => acc + (t.profit ?? 0), 0);
        return {
          id: s.id,
          name: s.name,
          description: s.description,
          symbols: s.symbols,
          granularity: s.granularity,
          validation: {
            expectancyR: s.validation?.expectancyR,
            winRate: s.validation?.winRate,
            pnlUsd: s.validation?.pnlUsd,
            trades: s.validation?.trades,
          },
          live: {
            signals: sigsForStrat.length,
            trades: tradesForStrat.length,
            wins,
            losses: tradesForStrat.length - wins,
            pnlUsd: pnl,
            winRate: tradesForStrat.length ? wins / tradesForStrat.length : 0,
            expectancyR: 0, // computed only when we have stop/entry per trade — defer
            lastSignalAt: sigsForStrat.length ? Math.max(...sigsForStrat.map((sg) => sg.emittedAt)) : null,
            lastTradeAt: tradesForStrat.length ? Math.max(...tradesForStrat.map((t) => t.closedAt ?? 0)) : null,
          },
        };
      });
    },
    getConfig: () => ({
      stake: cfg.stake,
      dailyMaxLoss: cfg.dailyMaxLoss,
      contractFamily: cfg.contractFamily,
      multiplier: cfg.multiplier,
      durationTicks: cfg.durationTicks,
      tpSlMode: cfg.tpSlMode,
      atrTpMult: cfg.atrTpMult,
      atrSlMult: cfg.atrSlMult,
      takeProfitPct: cfg.takeProfitPct,
      stopLossPct: cfg.stopLossPct,
      liveTradingEnabled: cfg.liveTradingEnabled,
      derivAppId: cfg.derivAppId,
      logLevel: cfg.logLevel,
      stateDir: cfg.stateDir,
    }),
    getSubscriptions: () => Array.from(subscribedKeys).map((k) => {
      const [sym, grStr] = k.split("|");
      const gr = Number(grStr);
      return { symbol: sym, granularity: gr, bars: (chartBuffers.get(k) ?? []).length };
    }),
    getPaperState: () => paper.getState(),
    getPaperStats: () => paper.stats() as unknown as Record<string, number>,
  });

  // Subscribe to all (symbol, granularity) pairs from STRATEGIES.
  // Tick subscriptions are deduped by symbol — Deriv allows multiple candle
  // granularities per symbol but only ONE tick stream per symbol.
  async function subscribeAll() {
    const pairs = new Set<string>();
    for (const s of STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    const tickedSymbols = new Set<string>();
    for (const key of pairs) {
      if (subscribedKeys.has(key)) continue;
      const [sym, grStr] = key.split("|");
      const gr = Number(grStr);
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const history = await deriv.subscribeCandles(sym as SymbolCode, gr, 1000);
          // Per-(symbol, granularity) Engine — fresh detector state, no collision
          // with another granularity of the same symbol.
          const eng = new Engine(defaultDetectorConfigs(), { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
          eng.seed(sym as SymbolCode, history);
          engines.set(key, eng);
          chartBuffers.set(key, [...history]);
          if (!tickedSymbols.has(sym)) {
            await deriv.subscribeTicks(sym as SymbolCode);
            tickedSymbols.add(sym);
          }
          subscribedKeys.add(key);
          log.info(`subscribed ${sym}@${gr}s (seeded=${history.length}, attempt=${attempt + 1})`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e as Error;
          log.warn(`subscribe attempt ${attempt + 1}/3 failed ${sym}@${gr}s: ${lastErr.message}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      if (lastErr) {
        log.error(`subscribe failed after 3 retries ${sym}@${gr}s: ${lastErr.message}`);
      }
    }
  }

  // Candle handler — routes the candle to the (symbol, granularity)-specific
  // Engine and chart buffer. The granularity arg is the 4th positional emit
  // parameter from the deriv client (added so multi-granularity can route).
  deriv.on("candle", (symbol, candle, isNew, granularity?: number) => {
    if (granularity == null) return; // pre-emit-update legacy event — ignore
    const key = engKey(symbol, granularity);
    // Update chart buffer using epoch-aware merge. Deriv's WS may emit ohlc
    // updates that alternate between the just-closed bar and the in-progress
    // bar within the same tick — trusting `isNew` causes duplicate pushes
    // that evict seeded history. Compare epochs against the buffer tail:
    //   - greater than last → append
    //   - equal to last     → update in place
    //   - equal to N-th-last → update that slot (handles bar revisions)
    //   - older / unknown   → ignore (out-of-order or stale)
    const buf = chartBuffers.get(key);
    if (buf && buf.length > 0) {
      const lastIdx = buf.length - 1;
      const lastEpoch = buf[lastIdx].epoch;
      if (candle.epoch > lastEpoch) {
        buf.push(candle);
        if (buf.length > 1500) buf.splice(0, buf.length - 1500);
      } else if (candle.epoch === lastEpoch) {
        buf[lastIdx] = candle;
      } else {
        // Search backward up to 5 bars for a matching epoch (revision of a recent bar)
        for (let i = lastIdx - 1; i >= Math.max(0, lastIdx - 5); i--) {
          if (buf[i].epoch === candle.epoch) { buf[i] = candle; break; }
        }
      }
    } else if (buf) {
      buf.push(candle);
    }
    // Settle any paper positions whose TP/SL was touched this candle
    const settled = paper.onCandle(symbol, granularity, candle);
    for (const c of settled) {
      log.info(`paper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${paper.getState().balance.toFixed(2)}`);
    }

    // Run the matching engine (only one per key — silver_15m engine doesn't see 1h candles)
    const eng = engines.get(key);
    if (!eng) return;
    const r = eng.onCandle(symbol, candle, isNew);
    for (const sig of r.signals) {
      log.info("signal", { symbol: sig.symbol, side: sig.action, detector: sig.detector, confidence: sig.confidence, granularity });
      recentSignals.push(sig);
      if (recentSignals.length > SIGNAL_HISTORY) recentSignals.splice(0, recentSignals.length - SIGNAL_HISTORY);
      executeSignal(sig, candle, key, granularity).catch((e) => log.error("execute failed", { err: (e as Error).message }));
    }
  });

  async function executeSignal(sig: Signal, candle: Candle, key: string, granularity: number): Promise<void> {
    if (manualPaused) {
      log.info("manual pause skip", { symbol: sig.symbol, side: sig.action });
      return;
    }
    // Match signal to a registered strategy on this symbol — only those gate trades.
    const matches = strategiesForSymbol(sig.symbol).filter((s) =>
      s.detectors.some((d) => d.id === sig.detector && d.enabled),
    );
    if (matches.length === 0) {
      log.debug("signal not matched to any registered strategy — ignored", { symbol: sig.symbol, detector: sig.detector });
      return;
    }
    const eng = engines.get(key);
    const atr = eng?.atrFor(sig.symbol) ?? 0;
    const entryPriceHint = eng?.lastCloseFor(sig.symbol) ?? candle.close;

    if (!cfg.liveTradingEnabled) {
      // Paper trade: open a simulated position, settle later via candle stream.
      const pos = paper.openPosition({
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.action,
        detector: sig.detector,
        entryPrice: entryPriceHint,
        atr,
        atrTpMult: cfg.atrTpMult,
        atrSlMult: cfg.atrSlMult,
        multiplier: cfg.multiplier,
        granularity,
        candleEpoch: candle.epoch,
        baseStake: cfg.stake,
        minStake: 1,
        nowMs: Date.now(),
      });
      if (pos) {
        log.info(`paper opened ${pos.symbol} ${pos.side} stake=$${pos.stake.toFixed(2)} entry=${pos.entryPrice.toFixed(5)} sl=${pos.stopPrice.toFixed(5)} tp=${pos.takeProfitPrice.toFixed(5)} shift=${pos.appliedShiftReasons}`);
      } else {
        log.warn(`paper open rejected ${sig.symbol} ${sig.action} (atr=${atr}, balance=$${paper.getState().balance.toFixed(2)})`);
      }
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
        atr,
        entryPriceHint,
        detector: sig.detector,
      });
      log.info("placeTrade ok", { id: trade.id, contractId: trade.contractId, stake: trade.stake });
    } catch (e) {
      log.error("placeTrade failed", { err: (e as Error).message, symbol: sig.symbol, side: sig.action });
    }
  }

  // WS lifecycle. DerivClient has its own auto-reconnect AND auto-resubscribe.
  // We do FULL subscribe flow only on first connection. On reconnects, the
  // client itself replays subscriptions — we just re-authorize.
  deriv.on("open", async () => {
    wsConnected = true;
    const reconnect = !isFirstConnection;
    log.info("ws connected", { reconnect });
    try {
      const info = await deriv.authorize(cfg.derivToken);
      account = {
        loginid: info.loginid ?? "",
        currency: info.currency ?? "USD",
        balance: info.balance ?? 0,
        isVirtual: info.is_virtual === 1,
        fullname: info.fullname,
        email: info.email,
      };
      real.setAccount(account);
      authorized = true;
      log.info("authorized", { loginid: info.loginid, currency: info.currency, virtual: info.is_virtual === 1, balance: info.balance });
      await deriv.subscribeBalance().catch((e) => log.warn("subscribeBalance failed", { err: (e as Error).message }));

      if (reconnect) {
        // DerivClient's resubscribeAll() already handled it. Don't double-subscribe.
        log.info("reconnect — relying on client auto-resubscribe", { previouslySubscribed: subscribedKeys.size });
      } else {
        await subscribeAll();
        isFirstConnection = false;
        log.info("bot ready", { liveTrading: cfg.liveTradingEnabled, strategies: STRATEGIES.length, subs: subscribedKeys.size });
      }
    } catch (e) {
      log.error("authorize/subscribe failed", { err: (e as Error).message });
      authorized = false;
    }
  });

  deriv.on("close", () => {
    wsConnected = false;
    authorized = false;
    log.warn("ws closed (client will auto-reconnect)");
    // Note: keep subscribedKeys populated. The deriv client maintains its
    // own subscription registry and resubscribes on reconnect. Clearing
    // ours would mistakenly re-trigger subscribeAll on the next "open".
  });
  deriv.on("error", (err) => log.error("deriv error", { err: err.message ?? String(err) }));
  deriv.on("balance", (b) => {
    if (account) {
      account = { ...account, balance: b.balance ?? account.balance, currency: b.currency ?? account.currency };
    }
    log.debug("balance", { balance: b.balance, currency: b.currency });
  });

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
    await httpServer.close().catch(() => undefined);
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

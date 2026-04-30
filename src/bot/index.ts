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
import { SYNTH_STRATEGIES, isSynthSymbol, synthStrategiesForSymbol } from "../main/engine/synth-strategies";
import { emptyAdaptiveShiftState } from "../main/engine/adaptive-shift";
import type { AccountInfo, Candle, Granularity, Signal, SymbolCode } from "@shared/types";
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
      manualControls: { isPaused: () => true, setPaused: () => {}, resetAdaptiveShift: () => {}, resetDaily: () => {}, resetPaper: () => {}, resetSynthPaper: () => {}, forceResubscribe: async () => {} },
      getCandles: () => [],
      getStrategyStats: () => [],
      getConfig: () => ({ error: (e as Error).message }),
      getSubscriptions: () => [],
      getPaperState: () => emptyPaperState(),
      getPaperStats: () => ({}),
      getSynthPaperState: () => emptyPaperState(),
      getSynthPaperStats: () => ({}),
      getSynthStrategyStats: () => [],
      getDiagnostics: () => [],
      getRecentLogs: (limit: number) => bootLog.tail(limit),
    });
    process.on("SIGTERM", () => { idleHttp.close().finally(() => process.exit(0)); });
    process.on("SIGINT", () => { idleHttp.close().finally(() => process.exit(0)); });
    return; // idle forever; do not throw (would trigger restart loop)
  }
  const log = new Logger(cfg.logLevel);
  log.info("bot starting", {
    config: describeConfig(cfg),
    strategies: STRATEGIES.map((s) => s.id),
    synthStrategies: SYNTH_STRATEGIES.map((s) => s.id),
  });

  const storage = new BotStorage(cfg.stateDir);
  const persisted = await storage.load();
  log.info("state loaded", { closed: persisted.closed.length, open: persisted.open.length, paperTrades: persisted.paper.closed.length, paperBalance: persisted.paper.balance });

  // If paper state hasn't been initialized (or was reset), seed with config balance
  if (persisted.paper.startingBalance !== cfg.paperStartingBalance && persisted.paper.closed.length === 0 && persisted.paper.open.length === 0) {
    log.info("paper: seeding fresh state", { startingBalance: cfg.paperStartingBalance });
    persisted.paper = emptyPaperState(cfg.paperStartingBalance);
  }
  const paper = new PaperEngine(persisted.paper);

  // Synth-strategies sandbox — completely isolated from real-asset paper. Same
  // PaperEngine class, distinct PaperState. Lets us live-paper RDBULL/JD100/BOOM300N
  // before deciding whether to wire them into RealEngine.
  if (persisted.synthPaper.startingBalance !== cfg.paperStartingBalance && persisted.synthPaper.closed.length === 0 && persisted.synthPaper.open.length === 0) {
    log.info("synthPaper: seeding fresh state", { startingBalance: cfg.paperStartingBalance });
    persisted.synthPaper = emptyPaperState(cfg.paperStartingBalance);
  }
  const synthPaper = new PaperEngine(persisted.synthPaper);

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
  // Heartbeat state — used for hang detection in /health
  let lastHeartbeatMs = Date.now();
  const lastCandleAtByKey = new Map<string, number>(); // sym|gr -> Date.now() ms
  // Per-key counters reset every heartbeat. Tells the operator which streams
  // actually delivered candles + which closed a bar in the last minute.
  const candlesSinceHeartbeat = new Map<string, number>();
  const newBarsSinceHeartbeat = new Map<string, number>();
  // Cumulative since startup — surfaced in /api/diag and Strategies panel.
  const totalCandlesByKey = new Map<string, number>();
  const totalNewBarsByKey = new Map<string, number>();
  // Per-strategy "I saw a bar from one of my symbols at this time" — fills the
  // Strategies UI's `lastBarSeenAt` so an operator can spot a strategy whose
  // stream silently went dead.
  const strategyLastBarSeenAt = new Map<string, number>();

  // Wrap an interval body so it never escapes — a thrown error in setInterval
  // would otherwise kill the timer silently. We log + continue.
  const safeInterval = (label: string, body: () => void | Promise<void>, ms: number) => {
    return setInterval(() => {
      try {
        const r = body();
        if (r && typeof (r as any).catch === "function") {
          (r as Promise<void>).catch((e) => log.error(`${label} async error`, { err: (e as Error).message }));
        }
      } catch (e) {
        log.error(`${label} sync error`, { err: (e as Error).message });
      }
    }, ms);
  };

  const persist = () => {
    const s = real.state();
    storage.save({
      open: s.open,
      closed: s.closed,
      daily: s.daily,
      adaptiveShift: real.getAdaptiveShift(),
      paper: paper.getState(),
      synthPaper: synthPaper.getState(),
    }).catch((e) => log.error("persist failed", { err: (e as Error).message }));
  };
  paper.onChange(() => persist());
  synthPaper.onChange(() => persist());

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
    getHealth: () => {
      const upSec = Math.floor((Date.now() - startTs) / 1000);
      const hbAgeSec = Math.floor((Date.now() - lastHeartbeatMs) / 1000);
      const hung = upSec > 120 && hbAgeSec > 180;
      return { wsConnected, authorized, uptimeSec: upSec, heartbeatAgeSec: hbAgeSec, hung };
    },
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
      resetSynthPaper: (balance?: number) => { synthPaper.reset(balance ?? cfg.paperStartingBalance); log.warn(`synthPaper reset via API to $${(balance ?? cfg.paperStartingBalance).toFixed(2)}`); },
      forceResubscribe: async () => {
        log.warn("force-resubscribe initiated via API");
        await deriv.forgetAll("candles").catch(() => undefined);
        await deriv.forgetAll("ticks").catch(() => undefined);
        engines.clear();
        chartBuffers.clear();
        subscribedKeys.clear();
        await subscribeAll();
        log.info(`force-resubscribe complete: ${subscribedKeys.size} pairs subscribed`);
      },
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
        // Bars-seen accounting — sum the per-key new-bar counters for every
        // (sym, gr) this strategy runs on. Tells the operator "this strategy's
        // detector has been called N times since startup" — distinguishes
        // "no signals because no bar ever closed" from "no signals because
        // the detector ran but didn't qualify a setup".
        let barsSeen = 0;
        for (const sym of s.symbols) {
          barsSeen += totalNewBarsByKey.get(`${sym}|${s.granularity}`) ?? 0;
        }
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
            lastSignalAt: sigsForStrat.length ? Math.max(...sigsForStrat.map((sg) => sg.ts)) : null,
            lastTradeAt: tradesForStrat.length ? Math.max(...tradesForStrat.map((t) => t.closedAt ?? 0)) : null,
            barsSeen,
            lastBarSeenAt: strategyLastBarSeenAt.get(s.id) ?? null,
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
    getSynthPaperState: () => synthPaper.getState(),
    getSynthPaperStats: () => synthPaper.stats() as unknown as Record<string, number>,
    getDiagnostics: () => Array.from(engines.entries()).map(([key, eng]) => {
      const [sym, grStr] = key.split("|");
      const gr = Number(grStr);
      return {
        key,
        symbol: sym,
        granularity: gr,
        lastCandleAtMs: lastCandleAtByKey.get(key) ?? null,
        engine: eng.diagnose(sym as SymbolCode),
      };
    }),
    getSynthStrategyStats: () => {
      const sigs = recentSignals;
      return SYNTH_STRATEGIES.map((s) => {
        const detIds = s.detectors.filter((d) => d.enabled).map((d) => d.id);
        const sSyms = new Set(s.symbols);
        const sigsForStrat = sigs.filter((sg) => sSyms.has(sg.symbol) && detIds.includes(sg.detector));
        const closed = synthPaper.getState().closed;
        const tradesForStrat = closed.filter((t) => sSyms.has(t.symbol) && detIds.includes(t.detector));
        const wins = tradesForStrat.filter((t) => t.pnl > 0).length;
        const pnl = tradesForStrat.reduce((acc, t) => acc + t.pnl, 0);
        let barsSeen = 0;
        for (const sym of s.symbols) {
          barsSeen += totalNewBarsByKey.get(`${sym}|${s.granularity}`) ?? 0;
        }
        return {
          id: s.id, name: s.name, description: s.description, symbols: s.symbols, granularity: s.granularity,
          validation: { expectancyR: s.validation?.expectancyR, winRate: s.validation?.winRate, pnlUsd: s.validation?.pnlUsd, trades: s.validation?.trades },
          live: {
            signals: sigsForStrat.length, trades: tradesForStrat.length, wins, losses: tradesForStrat.length - wins,
            pnlUsd: pnl, winRate: tradesForStrat.length ? wins / tradesForStrat.length : 0, expectancyR: 0,
            lastSignalAt: sigsForStrat.length ? Math.max(...sigsForStrat.map((sg) => sg.ts)) : null,
            lastTradeAt: tradesForStrat.length ? Math.max(...tradesForStrat.map((t) => t.closedAt ?? 0)) : null,
            barsSeen,
            lastBarSeenAt: strategyLastBarSeenAt.get(s.id) ?? null,
          },
        };
      });
    },
    getRecentLogs: (limit: number) => log.tail(limit),
  });

  // Build the per-(sym, gr) engine detector config by merging every strategy
  // (real + synth) that runs on this key. Each detector starts disabled with
  // default params; for each matching strategy, any detector that strategy
  // enables is copied in with that strategy's validated params and flipped on.
  // Handles the gold_ob + gold_fvg case where two strategies share
  // (frxXAUUSD, 3600) but enable different detectors. Collisions on the same
  // detector across strategies log a warning — currently impossible by
  // construction (each strategy enables exactly one distinct detector per key).
  function buildEngineDetectorConfigs(sym: string, gr: number) {
    const merged = defaultDetectorConfigs().map((d) => ({ ...d, enabled: false }));
    const matches = [
      ...STRATEGIES.filter((s) => s.symbols.includes(sym as SymbolCode) && s.granularity === gr),
      ...SYNTH_STRATEGIES.filter((s) => s.symbols.includes(sym) && s.granularity === gr),
    ];
    for (const strat of matches) {
      for (const sd of strat.detectors) {
        if (!sd.enabled) continue;
        const slot = merged.find((m) => m.id === sd.id);
        if (!slot) continue;
        if (slot.enabled) {
          log.warn(`detector ${sd.id} on ${sym}@${gr}s enabled by multiple strategies — using ${strat.id}'s params (last write wins)`);
        }
        slot.enabled = true;
        slot.params = { ...sd.params };
      }
    }
    return merged;
  }

  // Subscribe to all (symbol, granularity) pairs from STRATEGIES.
  // Tick subscriptions are deduped by symbol — Deriv allows multiple candle
  // granularities per symbol but only ONE tick stream per symbol.
  async function subscribeAll() {
    const pairs = new Set<string>();
    for (const s of STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    // Also subscribe to synth-strategy pairs — they share the same engine map and
    // candle pipeline; synth signals get routed to synthPaper in executeSignal.
    for (const s of SYNTH_STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
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
          // with another granularity of the same symbol. Detector configs are
          // merged from every strategy (real + synth) that runs on this key so
          // each strategy's validated params are applied, and any detector not
          // claimed by some strategy stays disabled.
          const detectorConfigs = buildEngineDetectorConfigs(sym, gr);
          const eng = new Engine(detectorConfigs, { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
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
    lastCandleAtByKey.set(key, Date.now());
    candlesSinceHeartbeat.set(key, (candlesSinceHeartbeat.get(key) ?? 0) + 1);
    totalCandlesByKey.set(key, (totalCandlesByKey.get(key) ?? 0) + 1);
    // Update chart buffer using epoch-aware merge. Deriv's WS may emit ohlc
    // updates that alternate between the just-closed bar and the in-progress
    // bar within the same tick — trusting `isNew` causes duplicate pushes
    // that evict seeded history. Compare epochs against the buffer tail:
    //   - greater than last → append
    //   - equal to last     → update in place
    //   - equal to N-th-last → update that slot (handles bar revisions)
    //   - older / unknown   → ignore (out-of-order or stale)
    // Compute isNewBar ourselves (Deriv's isNew flag is unreliable — alternates
     // between just-closed and in-progress bars). The engine uses isNew to gate
     // signal emission, so we MUST pass the epoch-derived value, not the WS flag.
    let isNewBar = false;
    const buf = chartBuffers.get(key);
    if (buf && buf.length > 0) {
      const lastIdx = buf.length - 1;
      const lastEpoch = buf[lastIdx].epoch;
      if (candle.epoch > lastEpoch) {
        buf.push(candle);
        if (buf.length > 1500) buf.splice(0, buf.length - 1500);
        isNewBar = true;
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
      isNewBar = true;
    }
    // Settle any paper positions whose TP/SL was touched this candle
    const settled = paper.onCandle(symbol, granularity, candle);
    for (const c of settled) {
      log.info(`paper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${paper.getState().balance.toFixed(2)}`);
    }
    // Settle synth paper positions (separate sandbox).
    const settledSynth = synthPaper.onCandle(symbol, granularity, candle);
    for (const c of settledSynth) {
      log.info(`synthPaper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${synthPaper.getState().balance.toFixed(2)}`);
    }

    // Run the matching engine (only one per key — silver_15m engine doesn't see 1h candles)
    const eng = engines.get(key);
    if (!eng) return;
    if (isNewBar) {
      newBarsSinceHeartbeat.set(key, (newBarsSinceHeartbeat.get(key) ?? 0) + 1);
      totalNewBarsByKey.set(key, (totalNewBarsByKey.get(key) ?? 0) + 1);
      // Track per-strategy "I saw a bar" so a stalled stream is observable.
      const now = Date.now();
      for (const s of STRATEGIES) {
        if (s.symbols.includes(symbol as SymbolCode) && s.granularity === granularity) {
          strategyLastBarSeenAt.set(s.id, now);
        }
      }
      for (const s of SYNTH_STRATEGIES) {
        if (s.symbols.includes(symbol) && s.granularity === granularity) {
          strategyLastBarSeenAt.set(s.id, now);
        }
      }
      log.info(`new bar ${symbol}@${granularity}s epoch=${candle.epoch} close=${candle.close}`);
    }
    const r = eng.onCandle(symbol, candle, isNewBar);
    if (isNewBar && r.signals.length === 0) {
      log.info(`bar processed no signal ${symbol}@${granularity}s rejected=${r.rejected ?? 0} adx=${r.regime?.adx?.toFixed(1) ?? "?"}`);
    }
    // Stacked-zone dedupe: when multiple FVGs (or sweeps, or OBs) retest on
    // the same bar, the detector emits one signal per zone. Trade layer
    // already dedupes via the same-side-already-open guard, but the
    // recentSignals buffer + UI would still show every duplicate. Suppress
    // duplicates here so the operator sees one signal per (bar, sym, det,
    // side); the first one wins, others are discarded silently.
    const seenThisBar = new Set<string>();
    for (const sig of r.signals) {
      const dedupeKey = `${candle.epoch}|${sig.symbol}|${sig.detector}|${sig.action}`;
      if (seenThisBar.has(dedupeKey)) {
        log.debug("signal deduped (stacked zones on same bar)", { dedupeKey });
        continue;
      }
      seenThisBar.add(dedupeKey);
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
    const eng = engines.get(key);
    const atr = eng?.atrFor(sig.symbol) ?? 0;
    const entryPriceHint = eng?.lastCloseFor(sig.symbol) ?? candle.close;
    // Strategy descriptor filters (buyOnly/sellOnly/minAdx/maxAdx) were used during
    // validation but were NOT applied at signal-time — meaning live trades fired in
    // both directions and on weak-ADX regimes for filter-gated strategies. Apply
    // them here so live behavior matches the validated config.
    const regime = eng?.regimeFor(sig.symbol);
    const adx = regime?.adx ?? 0;
    function passesStrategyFilters(s: { buyOnly?: boolean; sellOnly?: boolean; minAdx?: number; maxAdx?: number }): boolean {
      if (s.buyOnly && sig.action !== "BUY") return false;
      if (s.sellOnly && sig.action !== "SELL") return false;
      if (s.minAdx != null && adx < s.minAdx) return false;
      if (s.maxAdx != null && adx > s.maxAdx) return false;
      return true;
    }

    // Synth signals always paper-trade via synthPaper (never live, never via real bot).
    if (isSynthSymbol(sig.symbol)) {
      const synthCandidates = synthStrategiesForSymbol(sig.symbol)
        .filter((s) => s.detectors.some((d) => d.id === sig.detector && d.enabled));
      const synthMatches = synthCandidates.filter(passesStrategyFilters);
      if (synthMatches.length === 0) {
        // Promote to info so operators can see why a synth signal didn't trade
        // without enabling debug logging.
        log.info("synth signal blocked by strategy filters", { symbol: sig.symbol, side: sig.action, detector: sig.detector, adx, candidates: synthCandidates.map((s) => s.id) });
        return;
      }
      // Don't pile on: validation used one-position-at-a-time. The FVG detector
      // can emit multiple signals on the same bar (stacked FVGs) and new bars
      // can fire while a prior position is still open — both would multiply
      // exposure 3-10x vs the validated config.
      const synthAlreadyOpen = synthPaper.getState().open.some((p) => p.symbol === sig.symbol && p.side === sig.action);
      if (synthAlreadyOpen) {
        log.info("synth signal skipped — same-side position already open", { symbol: sig.symbol, side: sig.action });
        return;
      }
      const synthMatch = synthMatches[0];
      const pos = synthPaper.openPosition({
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.action,
        detector: sig.detector,
        entryPrice: entryPriceHint,
        atr,
        atrTpMult: synthMatch.atrTpMult,
        atrSlMult: synthMatch.atrSlMult,
        multiplier: cfg.multiplier,
        granularity,
        candleEpoch: candle.epoch,
        baseStake: cfg.stake,
        minStake: 1,
        nowMs: Date.now(),
        signalStopPrice: sig.stopPrice,
        signalTargetPrice: sig.targetPrice,
      });
      if (pos) {
        log.info(`synthPaper opened ${pos.symbol} ${pos.side} stake=$${pos.stake.toFixed(2)} entry=${pos.entryPrice.toFixed(5)} sl=${pos.stopPrice.toFixed(5)} tp=${pos.takeProfitPrice.toFixed(5)}`);
      }
      return;
    }

    // Match signal to a registered strategy on this symbol — only those gate trades.
    // Apply strategy descriptor filters too (buyOnly/sellOnly/minAdx/maxAdx).
    const candidates = strategiesForSymbol(sig.symbol)
      .filter((s) => s.detectors.some((d) => d.id === sig.detector && d.enabled));
    const matches = candidates.filter(passesStrategyFilters);
    if (matches.length === 0) {
      // Promote to info so operators can see WHY a signal didn't trade without
      // enabling debug logging. Distinguish "no matching strategy" from
      // "strategy gates rejected" so the operator knows where to look.
      if (candidates.length === 0) {
        log.info("signal blocked — no strategy enables this detector on this symbol", { symbol: sig.symbol, detector: sig.detector, side: sig.action });
      } else {
        log.info("signal blocked by strategy filters (buyOnly/sellOnly/minAdx/maxAdx)", { symbol: sig.symbol, detector: sig.detector, side: sig.action, adx, candidates: candidates.map((s) => s.id) });
      }
      return;
    }
    const match = matches[0];
    // Don't pile on same-side positions (validation used one-at-a-time).
    const realState = real.state();
    const liveOpenSameSide = (realState.open ?? []).some((t) => t.symbol === sig.symbol && t.side === sig.action);
    const paperOpenSameSide = paper.getState().open.some((p) => p.symbol === sig.symbol && p.side === sig.action);
    if ((cfg.liveTradingEnabled && liveOpenSameSide) || (!cfg.liveTradingEnabled && paperOpenSameSide)) {
      log.info("signal skipped — same-side position already open", { symbol: sig.symbol, side: sig.action, mode: cfg.liveTradingEnabled ? "live" : "paper" });
      return;
    }

    if (!cfg.liveTradingEnabled) {
      // Paper trade: open a simulated position, settle later via candle stream.
      const pos = paper.openPosition({
        signalId: sig.id,
        symbol: sig.symbol,
        side: sig.action,
        detector: sig.detector,
        entryPrice: entryPriceHint,
        atr,
        atrTpMult: match.atrTpMult,
        atrSlMult: match.atrSlMult,
        multiplier: cfg.multiplier,
        granularity,
        candleEpoch: candle.epoch,
        baseStake: cfg.stake,
        minStake: 1,
        nowMs: Date.now(),
        signalStopPrice: sig.stopPrice,
        signalTargetPrice: sig.targetPrice,
      });
      if (pos) {
        log.info(`paper opened ${pos.symbol} ${pos.side} strategy=${match.id} stake=$${pos.stake.toFixed(2)} entry=${pos.entryPrice.toFixed(5)} sl=${pos.stopPrice.toFixed(5)} tp=${pos.takeProfitPrice.toFixed(5)} shift=${pos.appliedShiftReasons}`);
      } else {
        log.warn(`paper open rejected ${sig.symbol} ${sig.action} (atr=${atr}, balance=$${paper.getState().balance.toFixed(2)})`);
      }
      return;
    }
    const gate = real.canOpen();
    if (!gate.ok) {
      log.info("trade gated", { reason: gate.reason, symbol: sig.symbol, side: sig.action });
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
        atrTpMult: match.atrTpMult,
        atrSlMult: match.atrSlMult,
        atr,
        entryPriceHint,
        detector: sig.detector,
        signalStopPrice: sig.stopPrice,
        signalTargetPrice: sig.targetPrice,
      });
      log.info("placeTrade ok", { id: trade.id, contractId: trade.contractId, stake: trade.stake, strategy: match.id });
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
        // Record the reconnect timestamp so the post-reconnect heal can detect
        // streams that didn't actually re-attach.
        lastReconnectMs = Date.now();
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

  // ──────── Resilience layer (heartbeat + self-heal + watchdog) ────────
  // Self-heal: if 30s after authorize we have no subscriptions, force fresh resub.
  safeInterval("self-heal-subs", async () => {
    if (shuttingDown || !wsConnected || !authorized) return;
    if (subscribedKeys.size > 0) return;
    log.warn("self-heal: subscribedKeys is empty, forcing resubscribe");
    await deriv.forgetAll("candles").catch(() => undefined);
    await deriv.forgetAll("ticks").catch(() => undefined);
    engines.clear();
    chartBuffers.clear();
    subscribedKeys.clear();
    await subscribeAll();
    log.info(`self-heal complete: ${subscribedKeys.size} pairs subscribed`);
  }, 30_000);

  // Heartbeat: structured ops snapshot every 60s. Updates lastHeartbeatMs which
  // /health uses to detect hangs (Railway restarts on 503).
  safeInterval("heartbeat", () => {
    lastHeartbeatMs = Date.now();
    const realState = real.state();
    const paperState = paper.getState();
    const synthState = synthPaper.getState();
    const realBalance = account?.balance ?? 0;
    // Snapshot per-key counters then reset for the next interval. Operator can
    // see in a glance: `candlesByKey: {"frxXAUUSD|3600": 14}` → stream alive,
    // empty/missing key → stream dead.
    const candlesByKey: Record<string, number> = {};
    for (const [k, v] of candlesSinceHeartbeat) candlesByKey[k] = v;
    const newBarsByKey: Record<string, number> = {};
    for (const [k, v] of newBarsSinceHeartbeat) newBarsByKey[k] = v;
    candlesSinceHeartbeat.clear();
    newBarsSinceHeartbeat.clear();
    log.info("heartbeat", {
      uptimeSec: Math.floor((Date.now() - startTs) / 1000),
      wsConnected,
      authorized,
      paused: manualPaused,
      subs: subscribedKeys.size,
      realBalance,
      realOpenTrades: realState.open.length,
      realClosedTrades: realState.closed.length,
      paperBalance: paperState.balance,
      paperOpenTrades: paperState.open.length,
      paperClosedTrades: paperState.closed.length,
      synthPaperBalance: synthState.balance,
      synthPaperOpenTrades: synthState.open.length,
      synthPaperClosedTrades: synthState.closed.length,
      consecLosses: real.getAdaptiveShift().consecLosses,
      paperConsecLosses: paperState.adaptiveShift.consecLosses,
      signalsBuffered: recentSignals.length,
      candlesByKey,
      newBarsByKey,
    });
    // Subscription staleness — warn if a stream hasn't received a candle in
    // 1.5× granularity. Old threshold was 2×, which hid 90-min outages on 1h
    // streams. 1.5× → 1h streams flagged at 90 min, 15m streams at 22.5 min.
    const nowMs = Date.now();
    for (const key of subscribedKeys) {
      const [, grStr] = key.split("|");
      const gr = Number(grStr);
      const lastMs = lastCandleAtByKey.get(key);
      if (!lastMs) continue; // not seen yet — fine
      const stalenessSec = Math.floor((nowMs - lastMs) / 1000);
      if (stalenessSec > 1.5 * gr) {
        log.warn(`stale subscription ${key}: no candle for ${stalenessSec}s (granularity ${gr}s)`);
      }
    }
  }, 60_000);

  // Watchdog: detect a hung event loop. If no heartbeat in 3min after the bot
  // has been alive >2min, exit so Railway restarts the container cleanly.
  // /health also surfaces this state for external monitoring.
  safeInterval("watchdog", () => {
    const upSec = Math.floor((Date.now() - startTs) / 1000);
    const hbAgeSec = Math.floor((Date.now() - lastHeartbeatMs) / 1000);
    if (upSec > 120 && hbAgeSec > 180) {
      log.error(`watchdog: heartbeat stale ${hbAgeSec}s — exiting for Railway restart`);
      // Brief async flush window for the log line, then exit
      setTimeout(() => process.exit(1), 500);
    }
  }, 30_000);

  // Per-pair confirmation from DerivClient.resubscribeAll(). Logs make it
  // possible to tell, after a WS reconnect, which streams actually re-attached.
  (deriv as unknown as { on(event: "resubscribed", l: (info: { kind: "ticks" | "candles"; symbol: string; granularity?: number }) => void): void }).on(
    "resubscribed",
    (info) => {
      if (info.kind === "candles") log.info(`resubscribed ${info.symbol}@${info.granularity}s`);
      else log.info(`resubscribed ticks ${info.symbol}`);
    },
  );
  (deriv as unknown as { on(event: "resubscribeError", l: (info: { kind: "ticks" | "candles"; symbol: string; granularity?: number; error: Error }) => void): void }).on(
    "resubscribeError",
    (info) => {
      if (info.kind === "candles") log.error(`resubscribe failed ${info.symbol}@${info.granularity}s`, { err: info.error.message });
      else log.error(`resubscribe failed ticks ${info.symbol}`, { err: info.error.message });
    },
  );

  // Post-reconnect heal: after the auto-resubscribe quiet period, scan every
  // (sym,gr) we expected and force a fresh subscribe for any that haven't
  // received a candle since the reconnect. Catches the case where Deriv
  // accepts the resubscribe response but never starts emitting ohlc updates.
  let lastReconnectMs = 0;
  safeInterval("post-reconnect-heal", async () => {
    if (shuttingDown || !wsConnected || !authorized) return;
    if (lastReconnectMs === 0) return; // first connection — subscribeAll handled it
    const elapsed = Date.now() - lastReconnectMs;
    if (elapsed < 30_000 || elapsed > 120_000) return; // act in the 30-120s window after reconnect, then once
    const stalePairs: Array<{ sym: string; gr: number }> = [];
    for (const key of subscribedKeys) {
      const lastMs = lastCandleAtByKey.get(key) ?? 0;
      // If lastMs predates the reconnect, no candle has arrived since reconnect.
      if (lastMs < lastReconnectMs) {
        const [sym, grStr] = key.split("|");
        stalePairs.push({ sym, gr: Number(grStr) });
      }
    }
    if (stalePairs.length === 0) return;
    log.warn("post-reconnect-heal: streams silent since reconnect, forcing fresh subscribe", { stalePairs });
    for (const { sym, gr } of stalePairs) {
      try {
        const history = await deriv.subscribeCandles(sym as SymbolCode, gr as Granularity, 100);
        log.info(`post-reconnect re-subscribed ${sym}@${gr}s (history=${history.length})`);
      } catch (e) {
        log.error(`post-reconnect re-subscribe failed ${sym}@${gr}s`, { err: (e as Error).message });
      }
    }
    // Mark this reconnect as healed so we don't loop the action.
    lastReconnectMs = 0;
  }, 15_000);

  deriv.on("close", () => {
    wsConnected = false;
    authorized = false;
    lastReconnectMs = Date.now(); // record so the next "open" is treated as reconnect by heal
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

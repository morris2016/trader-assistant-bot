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
import { FAST_STRATEGIES, isFastSymbol, fastStrategiesForSymbol } from "../main/engine/fast-strategies";
import { FAST2_STRATEGIES } from "../main/engine/fast2-strategies";
import { FAST3_STRATEGIES, FAST3_DETECTOR_TAG } from "../main/engine/fast3-strategies";
import { FAST2_DIGITOVER0_DETECTOR_TAG } from "../main/engine/fast2-strategies";
import { DEFAULT_FAST_MARTINGALE, emptyMartingaleState, nextStake as fastNextStake, updateAfterTrade as fastMartingaleUpdate, type MartingaleParams, type MartingaleState } from "../main/engine/martingale";
import { emptyAdaptiveShiftState } from "../main/engine/adaptive-shift";
import type { AccountInfo, Candle, Granularity, Signal, SymbolCode } from "@shared/types";
import { loadConfig, describeConfig } from "./config";
import { Logger } from "./logger";
import { BotStorage, DEFAULT_FAST1_CONFIG, DEFAULT_FAST2_CONFIG, DEFAULT_FAST3_CONFIG, DEFAULT_REAL_CONFIG, DERIV_MULTIPLIER_OPTIONS, DERIV_MAX_STAKE_USD, DERIV_MIN_STAKE_USD, clampDerivMultiplier, resolveFastConfig, type Fast1Config, type Fast2Config, type Fast3Config, type RealConfig } from "./storage";
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
      getRealRecentSignals: () => [],
      getFastRecentSignals: () => [],
      getFast2RecentSignals: () => [],
      getAdaptiveShiftDescription: () => `config error: ${(e as Error).message}`,
      manualControls: { isPaused: () => true, setPaused: () => {}, resetAdaptiveShift: () => {}, resetDaily: () => {}, resetPaper: () => {}, resetFastPaper: () => {}, updateFast1Config: () => {}, resetFast2Paper: () => {}, updateFast2Config: () => {}, updateFast2StrategyConfig: () => {}, resetFast3Paper: () => {}, updateFast3Config: () => {}, updateFast3StrategyConfig: () => {}, updateRealConfig: () => {}, getRealConfig: () => ({ liveTradingEnabled: false }), closeFast2Position: async () => {}, forceResubscribe: async () => {}, reconcileContracts: async () => {} },
      getCandles: () => [],
      getStrategyStats: () => [],
      getConfig: () => ({ error: (e as Error).message }),
      getSubscriptions: () => [],
      getPaperState: () => emptyPaperState(),
      getPaperStats: () => ({}),
      getFastPaperState: () => emptyPaperState(),
      getFastPaperStats: () => ({}),
      getFastMartingale: () => ({}),
      getFastStrategyStats: () => [],
      getFast1Config: () => ({ ...DEFAULT_FAST1_CONFIG }),
      getFast2PaperState: () => emptyPaperState(),
      getFast2PaperStats: () => ({}),
      getFast2Martingale: () => ({}),
      getFast2StrategyStats: () => [],
      getFast2Config: () => ({ ...DEFAULT_FAST2_CONFIG }),
      getFast3PaperState: () => emptyPaperState(),
      getFast3PaperStats: () => ({}),
      getFast3Martingale: () => ({}),
      getFast3StrategyStats: () => [],
      getFast3Config: () => ({ ...DEFAULT_FAST3_CONFIG }),
      getDiagnostics: () => [],
      getLastPriceFor: () => null,
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
    fastStrategies: FAST_STRATEGIES.map((s) => s.id),
    fast2Strategies: FAST2_STRATEGIES.map((s) => s.id),
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

  // Fast-trade sandbox — own paper account ($200 starting, smaller because
  // martingale needs less headroom). Stake comes from per-strategy martingale
  // ladder, not adaptive shift; the PaperEngine just records open/close.
  const fastPaper = new PaperEngine(persisted.fastPaper);
  // Per-strategy martingale state, restored from disk; missing strategies seed empty.
  const fastMartingale: Record<string, MartingaleState> = { ...persisted.fastMartingale };
  for (const s of FAST_STRATEGIES) {
    if (!fastMartingale[s.id]) fastMartingale[s.id] = emptyMartingaleState();
  }
  // Fast (sandbox 1) runtime config — replaces the old hardcoded
  // DEFAULT_FAST_MARTINGALE constant. Driven by the UI so leverage, martingale
  // multiplier, base stake, ladder depth, per-trade cap, and Deriv-fee model
  // can be tuned live. fast1MartingaleParams() rebuilds the MartingaleParams
  // view on every call so config changes take effect on the next trade.
  let fast1Config: Fast1Config = { ...DEFAULT_FAST1_CONFIG, ...persisted.fast1Config };
  const fast1MartingaleParams = (): MartingaleParams => ({
    baseStake: fast1Config.baseStake,
    multiplier: fast1Config.martingaleMultiplier,
    maxLevels: fast1Config.maxLevels,
    perTradeCap: fast1Config.perTradeCap,
  });
  log.info("fastPaper: state loaded", {
    balance: fastPaper.getState().balance,
    closed: fastPaper.getState().closed.length,
    config: fast1Config,
    martingale: Object.fromEntries(FAST_STRATEGIES.map((s) => [s.id, fastMartingale[s.id]])),
  });

  // Fast2 sandbox — independent paper account, ladders, and runtime config
  // (tradeMultiplier + martingaleMultiplier set from the UI). Same shape as
  // fastPaper but with config-driven martingale params and trade leverage so
  // the user can swap C-7-style (200×/2.0×) and B-1.7-style (100×/1.7×) at
  // runtime without redeploying.
  const fast2Paper = new PaperEngine(persisted.fast2Paper);
  // SPLIT MARTINGALE LADDERS: paper-mode and live-mode ladders are tracked
  // separately so paper losses cannot influence live stake (and vice versa).
  // Bug history: a single shared ladder caused a paper-trade loss before a
  // mode switch to inflate the next live trade's stake from $5 to $11.
  const fast2MartingalePaper: Record<string, MartingaleState> = { ...persisted.fast2MartingalePaper };
  const fast2MartingaleLive: Record<string, MartingaleState> = { ...persisted.fast2MartingaleLive };
  for (const s of FAST2_STRATEGIES) {
    if (!fast2MartingalePaper[s.id]) fast2MartingalePaper[s.id] = emptyMartingaleState();
    if (!fast2MartingaleLive[s.id]) fast2MartingaleLive[s.id] = emptyMartingaleState();
  }
  const fast2MartingaleFor = (mode: "paper" | "live"): Record<string, MartingaleState> =>
    mode === "live" ? fast2MartingaleLive : fast2MartingalePaper;
  const fast2ActiveMode = (): "paper" | "live" =>
    fast2Config.liveTradingEnabled ? "live" : "paper";
  let fast2Config: Fast2Config = { ...DEFAULT_FAST2_CONFIG, ...persisted.fast2Config };
  // Per-strategy resolver: overlays fast2Config.perStrategy[strategyId] on top
  // of the general fast2Config so each strategy can have its own stake/mart/
  // sideFilter without affecting the rest of the stack. Unset fields fall
  // back to the general config.
  const fast2ConfigFor = (strategyId: string): Fast2Config =>
    resolveFastConfig(fast2Config, strategyId);
  // Build a MartingaleParams view for a specific strategy — used at every
  // trade open / settle. Reflects per-strategy overrides if present.
  const fast2MartingaleParams = (strategyId?: string): MartingaleParams => {
    const cfg = strategyId ? fast2ConfigFor(strategyId) : fast2Config;
    return {
      baseStake: cfg.baseStake,
      multiplier: cfg.martingaleMultiplier,
      maxLevels: cfg.maxLevels,
      perTradeCap: cfg.perTradeCap,
    };
  };
  log.info("fast2Paper: state loaded", {
    balance: fast2Paper.getState().balance,
    closed: fast2Paper.getState().closed.length,
    config: fast2Config,
    martingalePaper: Object.fromEntries(FAST2_STRATEGIES.map((s) => [s.id, fast2MartingalePaper[s.id]])),
    martingaleLive: Object.fromEntries(FAST2_STRATEGIES.map((s) => [s.id, fast2MartingaleLive[s.id]])),
  });

  // Fast2 session-DD circuit state — hoisted here so resetFast2Paper can clear
  // the session peak (otherwise the peak from the prior session balance keeps
  // tripping the circuit even after the user explicitly resets to a lower
  // balance via the UI).
  let fast2SessionPeak = fast2Paper.getState().balance;
  let fast2DDPaused = false;

  // ── Fast3: DIGITODD tick-level sandbox ───────────────────────────────────
  // Distinct from Fast2: fires on every TICK (not bar close), uses binary
  // 1-tick contracts (DIGITODD), no SL/TP geometry. Per-tick: 55% WR base
  // rate × 1.95× payout = ~5% per-tick edge. Validated 2026-05-03.
  const fast3Paper = new PaperEngine(persisted.fast3Paper);
  const fast3MartingalePaper: Record<string, MartingaleState> = { ...persisted.fast3MartingalePaper };
  const fast3MartingaleLive: Record<string, MartingaleState> = { ...persisted.fast3MartingaleLive };
  for (const s of FAST3_STRATEGIES) {
    if (!fast3MartingalePaper[s.id]) fast3MartingalePaper[s.id] = emptyMartingaleState();
    if (!fast3MartingaleLive[s.id]) fast3MartingaleLive[s.id] = emptyMartingaleState();
  }
  let fast3Config: Fast3Config = { ...DEFAULT_FAST3_CONFIG, ...persisted.fast3Config };
  const fast3ConfigFor = (strategyId: string): Fast3Config =>
    resolveFastConfig(fast3Config, strategyId);
  const fast3MartingaleFor = (mode: "paper" | "live"): Record<string, MartingaleState> =>
    mode === "live" ? fast3MartingaleLive : fast3MartingalePaper;
  const fast3ActiveMode = (): "paper" | "live" =>
    fast3Config.liveTradingEnabled ? "live" : "paper";
  // Per-symbol pending bet: tracks DIGITODD bets that have been placed at
  // tick T and are waiting for tick T+1 to settle. Key = symbol; value =
  // { entryEpoch, stake, strategyId, mode }. The next tick on the same
  // symbol settles it.
  type Fast3Pending = { entryEpoch: number; stake: number; strategyId: string; mode: "paper" | "live" };
  const fast3Pending = new Map<string, Fast3Pending>();
  // ── Fast3 LIVE concurrency guards ──
  // No client-side throttling. Deriv enforces its own rate limits server-
  // side and returns "RateLimit" errors when exceeded; we surface those as
  // log warnings and the next tick simply tries again.
  // Two guards remain (correctness, not throttling):
  //   - per-symbol in-flight: don't double-fire while a placeTrade promise
  //     is still pending for that symbol
  //   - open-contract: DIGITODD settles next tick, so don't stack bets on
  //     the same symbol
  const fast3LiveInFlight = new Set<string>();
  // ── Per-strategy loss-streak pause ──
  // After N consecutive losses on a strategy, pause that strategy for a short
  // window. The hypothesis: a string of opposite-parity ticks just clobbered
  // the ladder; sitting out the next few ticks lets the run end before the
  // bot starts climbing the ladder again. Math says streaks have no auto-
  // correlation in a memoryless RNG, but lower bet count = less total $ bled
  // when the bot is in a bad regime, so it's a safe behavioral guard.
  // Tunable via env: FAST3_STREAK_PAUSE_AFTER_LOSSES (default 3 consecutive
  // losses), FAST3_STREAK_PAUSE_MS (default 1000ms cooldown).
  const FAST3_STREAK_PAUSE_AFTER_LOSSES = Number(process.env.FAST3_STREAK_PAUSE_AFTER_LOSSES ?? 3);
  const FAST3_STREAK_PAUSE_MS = Number(process.env.FAST3_STREAK_PAUSE_MS ?? 1000);
  const fast3ConsecutiveLosses = new Map<string, number>();
  const fast3StreakPauseUntil = new Map<string, number>();
  // Per-symbol decimal places for DIGITODD digit extraction. Populated at
  // boot from Deriv's active_symbols (pip_size → display_decimals). The
  // paper-mode settle path uses this to read the LAST digit of the quote
  // including trailing zeros — e.g. R_75's quote "213.4570" must be read
  // as digit 0, not digit 7. Number.toString() strips the trailing zero,
  // so we must pad via toFixed(decimals) before slicing.
  // Bug history (2026-05-04): paper engine's settle was using
  // `quote.toString()` and got the wrong digit for any quote ending in 0,
  // making paper estimate P(odd)≈55% when live is closer to 50% — paper
  // balance diverged sharply upward from live. Without active_symbols
  // populated the fallback uses sensible defaults: synthetics are 2-5dp,
  // metals are 5dp.
  const pipDecimalsBySymbol = new Map<string, number>();
  log.info("fast3Paper: state loaded", {
    balance: fast3Paper.getState().balance,
    closed: fast3Paper.getState().closed.length,
    config: fast3Config,
  });

  // ── Real-strategy book runtime config ───────────────────────────────────
  // Mutable at runtime via /api/control/update-real-config so the operator can
  // flip silver/gold/plat strategies between paper and live without
  // redeploying. Initial value: env LIVE_TRADING wins on first boot, then
  // persisted realConfig takes over.
  let realConfig: RealConfig = {
    ...DEFAULT_REAL_CONFIG,
    // First-boot bootstrap: if no persisted realConfig, seed from env so a
    // freshly-deployed bot still honors STAKE / MULTIPLIER / DAILY_MAX_LOSS
    // / LIVE_TRADING. After the user touches the UI, persisted state wins.
    baseStake: persisted.realConfig?.baseStake ?? cfg.stake,
    multiplier: persisted.realConfig?.multiplier ?? cfg.multiplier,
    dailyMaxLoss: persisted.realConfig?.dailyMaxLoss ?? cfg.dailyMaxLoss,
    liveTradingEnabled: persisted.realConfig?.liveTradingEnabled ?? cfg.liveTradingEnabled,
    ...persisted.realConfig,
  };
  const realActiveMode = (): "paper" | "live" => realConfig.liveTradingEnabled ? "live" : "paper";
  log.info("realConfig: loaded", { config: realConfig });

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
  // setCaps takes (stakePerTrade, dailyMaxLoss). Read from realConfig so the
  // UI can retune them at runtime without a redeploy. The realConfig values
  // are seeded from env (STAKE / DAILY_MAX_LOSS) on first boot above.
  real.setCaps(realConfig.baseStake, realConfig.dailyMaxLoss);
  // Production safety: price-tolerance gate before any live placeTrade. 5bps
  // (0.05% of price) is a conservative default for 1m synthetic strategies.
  // Set via env DERIV_PRICE_TOL_BPS to override (0 disables).
  const priceTolBps = Number(process.env.DERIV_PRICE_TOL_BPS ?? 5);
  real.setPriceTolerance(priceTolBps / 10000);

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
  // Per-sandbox signal buffers — each only gets signals that matched a
  // strategy in THAT sandbox's registry (by sym + gr + detector tuple). Lets
  // the UI show "what signals would have routed here?" definitively. A
  // single signal can appear in multiple buffers if multiple sandboxes
  // share its (sym,gr,det) tuple.
  const realRecentSignals: Signal[] = [];
  const fastRecentSignals: Signal[] = [];
  const fast2RecentSignals: Signal[] = [];
  const pushBounded = (buf: Signal[], sig: Signal) => {
    buf.push(sig);
    if (buf.length > SIGNAL_HISTORY) buf.splice(0, buf.length - SIGNAL_HISTORY);
  };
  // Heartbeat state — used for hang detection in /health
  let lastHeartbeatMs = Date.now();
  const lastCandleAtByKey = new Map<string, number>(); // sym|gr -> Date.now() ms
  // Per-key counters reset every heartbeat. Tells the operator which streams
  // actually delivered candles + which closed a bar in the last minute.
  const candlesSinceHeartbeat = new Map<string, number>();
  const newBarsSinceHeartbeat = new Map<string, number>();
  // Cumulative since startup — surfaced in /api/diag and Strategies panel.
  // totalNewBarsByKey is primed with the seed-history length when subscribePair
  // wires a stream, then incremented per closed bar. So `barsSeen` in the UI
  // reflects the engine's full context (seeded + live), not just the bars
  // that closed since boot.
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
      fastPaper: fastPaper.getState(),
      fastMartingale,
      fast1Config,
      fast2Paper: fast2Paper.getState(),
      fast2MartingalePaper,
      fast2MartingaleLive,
      fast2Config,
      fast3Paper: fast3Paper.getState(),
      fast3MartingalePaper,
      fast3MartingaleLive,
      fast3Config,
      realConfig,
    }).catch((e) => log.error("persist failed", { err: (e as Error).message }));
  };
  paper.onChange(() => persist());
  fastPaper.onChange(() => persist());
  fast2Paper.onChange(() => persist());
  fast3Paper.onChange(() => persist());

  // Persist on every state change (settle, open, capHit, adaptive update)
  real.on("opened", (t) => { log.info("trade opened", { symbol: t.symbol, side: t.side, stake: t.stake, detector: t.detector, contractId: t.contractId, sandbox: t.sandbox ?? "real" }); persist(); });
  real.on("settled", (t) => {
    log.info("trade settled", { symbol: t.symbol, side: t.side, profit: t.profit, status: t.status, sandbox: t.sandbox ?? "real", openLatencyMs: t.openLatencyMs, entrySlippage: t.entrySlippage });
    // Fast2 LIVE settlements advance the same per-strategy ladder that the
    // paper path uses. Treat the contract's `profit` as the pnl for ladder
    // purposes (positive = win, negative = loss). Ignore "real" sandbox
    // settles — they don't touch fast2 state.
    if (t.sandbox === "fast2" && t.sandboxStrategyId) {
      // Live settle → ALWAYS updates the LIVE ladder, regardless of the
      // current liveTradingEnabled flag. (A user who flips back to paper
      // before a contract settles still gets the live ladder updated; it
      // does not bleed into the paper ladder.)
      const fast2Strat = FAST2_STRATEGIES.find((s) => s.id === t.sandboxStrategyId);
      const before = fast2MartingaleLive[t.sandboxStrategyId] ?? emptyMartingaleState();
      const sCfgLive = fast2ConfigFor(t.sandboxStrategyId);
      const martingaleActive = (fast2Strat?.useMartingale ?? false) || sCfgLive.forceMartingale;
      const pnl = t.profit ?? 0;
      if (martingaleActive) {
        const params = fast2MartingaleParams(t.sandboxStrategyId);
        const { state: nextLadder, circuitBreakerFired } = fastMartingaleUpdate(before, pnl, params, Date.now(), sCfgLive.martingaleMode);
        fast2MartingaleLive[t.sandboxStrategyId] = nextLadder;
        const modeTag = sCfgLive.martingaleMode === "anti" ? " ANTI" : "";
        log.info(`fast2 LIVE settled ${t.symbol} ${t.side} ${t.status} pnl=$${pnl.toFixed(2)} strategy=${t.sandboxStrategyId} lvl=${nextLadder.level} W=${nextLadder.wins} L=${nextLadder.losses} mart=${params.multiplier}×${modeTag} contract=${t.contractId}${circuitBreakerFired ? " CIRCUIT-BREAKER" : ""}`);
        if (circuitBreakerFired) {
          log.warn(`fast2 LIVE martingale circuit-breaker fired for ${t.sandboxStrategyId}: ladder reset after ${params.maxLevels} ${sCfgLive.martingaleMode === "anti" ? "wins" : "losses"}`);
        }
      } else {
        fast2MartingaleLive[t.sandboxStrategyId] = {
          ...before,
          wins: before.wins + (pnl > 0 ? 1 : 0),
          losses: before.losses + (pnl > 0 ? 0 : 1),
          level: 0,
          cumulativeSinceReset: 0,
        };
        log.info(`fast2 LIVE settled ${t.symbol} ${t.side} ${t.status} pnl=$${pnl.toFixed(2)} strategy=${t.sandboxStrategyId} W=${fast2MartingaleLive[t.sandboxStrategyId].wins} L=${fast2MartingaleLive[t.sandboxStrategyId].losses} (no martingale)`);
      }
    }
    // Fast3 LIVE settlement — DIGITODD contracts settle 1 tick after open.
    // Advance the live ladder, mirror the closed trade into fast3Paper's
    // closed-trades log so the UI shows it (but DON'T touch the paper
    // balance — live P&L flows through the Deriv account balance).
    if (t.sandbox === "fast3" && t.sandboxStrategyId) {
      const before = fast3MartingaleLive[t.sandboxStrategyId] ?? emptyMartingaleState();
      const sCfgLive = fast3ConfigFor(t.sandboxStrategyId);
      const pnl = t.profit ?? 0;
      const params: MartingaleParams = {
        baseStake: sCfgLive.baseStake,
        multiplier: sCfgLive.martingaleMultiplier,
        maxLevels: sCfgLive.maxLevels,
        perTradeCap: sCfgLive.perTradeCap,
      };
      const { state: nextLadder } = fastMartingaleUpdate(before, pnl, params, Date.now(), sCfgLive.martingaleMode);
      fast3MartingaleLive[t.sandboxStrategyId] = nextLadder;
      log.info(`fast3 LIVE settled ${t.symbol} DIGITODD ${t.status} pnl=$${pnl.toFixed(2)} strategy=${t.sandboxStrategyId} lvl=${nextLadder.level} W=${nextLadder.wins} L=${nextLadder.losses} contract=${t.contractId}`);
      // Loss-streak pause: track consecutive losses on this strategy.
      // After threshold, set pause-until so the dispatch loop skips this
      // strategy for a brief window — the goal is to sit out the tail of
      // a bad-parity streak before re-engaging the ladder.
      if (pnl <= 0) {
        const streak = (fast3ConsecutiveLosses.get(t.sandboxStrategyId) ?? 0) + 1;
        fast3ConsecutiveLosses.set(t.sandboxStrategyId, streak);
        if (streak >= FAST3_STREAK_PAUSE_AFTER_LOSSES) {
          fast3StreakPauseUntil.set(t.sandboxStrategyId, Date.now() + FAST3_STREAK_PAUSE_MS);
          fast3ConsecutiveLosses.set(t.sandboxStrategyId, 0);
          log.info(`fast3 LIVE streak pause [${t.sandboxStrategyId}] — ${streak} losses → ${FAST3_STREAK_PAUSE_MS}ms cooldown`);
        }
      } else {
        fast3ConsecutiveLosses.set(t.sandboxStrategyId, 0);
      }
    }
    persist();
  });
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
    getRealRecentSignals: () => realRecentSignals,
    getFastRecentSignals: () => fastRecentSignals,
    getFast2RecentSignals: () => fast2RecentSignals,
    getAdaptiveShiftDescription: () => real.describeAdaptiveShift(),
    manualControls: {
      isPaused: () => manualPaused,
      setPaused: (p: boolean) => { manualPaused = p; log.warn(`manual ${p ? "PAUSE" : "RESUME"} via API`); },
      resetAdaptiveShift: () => { real.loadAdaptiveShift(emptyAdaptiveShiftState()); persist(); log.warn("adaptive shift state reset via API"); },
      resetDaily: () => { real.resetDaily(); persist(); log.warn("daily P&L reset via API"); },
      resetPaper: (balance?: number) => { paper.reset(balance ?? cfg.paperStartingBalance); log.warn(`paper reset via API to $${(balance ?? cfg.paperStartingBalance).toFixed(2)}`); },
      resetFastPaper: (balance?: number) => {
        const newBal = balance ?? 200;
        fastPaper.reset(newBal);
        // Also wipe per-strategy martingale ladders so the next trade starts at level 0.
        for (const sId of Object.keys(fastMartingale)) fastMartingale[sId] = emptyMartingaleState();
        persist();
        log.warn(`fastPaper reset via API to $${newBal.toFixed(2)} — all martingale ladders cleared`);
      },
      updateFast1Config: (patch: Partial<Fast1Config>) => {
        const before = { ...fast1Config };
        const next: Fast1Config = { ...fast1Config, ...patch };
        if (!isFinite(next.tradeMultiplier) || next.tradeMultiplier <= 0) next.tradeMultiplier = before.tradeMultiplier;
        if (!isFinite(next.martingaleMultiplier) || next.martingaleMultiplier <= 1) next.martingaleMultiplier = before.martingaleMultiplier;
        if (!isFinite(next.baseStake) || next.baseStake <= 0) next.baseStake = before.baseStake;
        if (!isFinite(next.maxLevels) || next.maxLevels < 1) next.maxLevels = before.maxLevels;
        if (!isFinite(next.perTradeCap) || next.perTradeCap <= 0) next.perTradeCap = before.perTradeCap;
        if (!isFinite(next.commissionPct) || next.commissionPct < 0) next.commissionPct = before.commissionPct;
        if (!isFinite(next.entrySpreadBps) || next.entrySpreadBps < 0) next.entrySpreadBps = before.entrySpreadBps;
        if (!isFinite(next.slSlippageBps) || next.slSlippageBps < 0) next.slSlippageBps = before.slSlippageBps;
        if (typeof next.forceMartingale !== "boolean") next.forceMartingale = before.forceMartingale;
        if (next.sideFilter !== "both" && next.sideFilter !== "BUY" && next.sideFilter !== "SELL") next.sideFilter = before.sideFilter;
        if (next.martingaleMode !== "classic" && next.martingaleMode !== "anti") next.martingaleMode = before.martingaleMode;
        if (typeof next.liveTradingEnabled !== "boolean") next.liveTradingEnabled = before.liveTradingEnabled;
        fast1Config = next;
        persist();
        log.warn("fast1Config updated via API", { before, after: next });
      },
      resetFast2Paper: (balance?: number) => {
        const newBal = balance ?? 50;
        fast2Paper.reset(newBal);
        // Reset BOTH ladders (paper + live) on a sandbox reset. The user is
        // explicitly asking for a clean slate; preserving live ladder state
        // across a paper reset would be surprising.
        for (const sId of Object.keys(fast2MartingalePaper)) fast2MartingalePaper[sId] = emptyMartingaleState();
        for (const sId of Object.keys(fast2MartingaleLive)) fast2MartingaleLive[sId] = emptyMartingaleState();
        // Reset the session-DD circuit too — peak was stale from the prior
        // balance, so without this the circuit would re-trip immediately on
        // a smaller new balance even though the user just reset.
        fast2SessionPeak = newBal;
        fast2DDPaused = false;
        persist();
        log.warn(`fast2Paper reset via API to $${newBal.toFixed(2)} — all martingale ladders (paper + live) + session-DD circuit cleared`);
      },
      updateFast2Config: (patch: Partial<Fast2Config>) => {
        const before = { ...fast2Config };
        const next: Fast2Config = { ...fast2Config, ...patch };
        // Bound numbers so a malformed payload can't bust the engine.
        if (!isFinite(next.tradeMultiplier) || next.tradeMultiplier <= 0) next.tradeMultiplier = before.tradeMultiplier;
        if (!isFinite(next.martingaleMultiplier) || next.martingaleMultiplier <= 1) next.martingaleMultiplier = before.martingaleMultiplier;
        if (!isFinite(next.baseStake) || next.baseStake <= 0) next.baseStake = before.baseStake;
        if (!isFinite(next.maxLevels) || next.maxLevels < 1) next.maxLevels = before.maxLevels;
        if (!isFinite(next.perTradeCap) || next.perTradeCap <= 0) next.perTradeCap = before.perTradeCap;
        if (!isFinite(next.commissionPct) || next.commissionPct < 0) next.commissionPct = before.commissionPct;
        if (!isFinite(next.entrySpreadBps) || next.entrySpreadBps < 0) next.entrySpreadBps = before.entrySpreadBps;
        if (!isFinite(next.slSlippageBps) || next.slSlippageBps < 0) next.slSlippageBps = before.slSlippageBps;
        if (typeof next.forceMartingale !== "boolean") next.forceMartingale = before.forceMartingale;
        if (next.sideFilter !== "both" && next.sideFilter !== "BUY" && next.sideFilter !== "SELL") next.sideFilter = before.sideFilter;
        if (next.martingaleMode !== "classic" && next.martingaleMode !== "anti") next.martingaleMode = before.martingaleMode;
        if (typeof next.liveTradingEnabled !== "boolean") next.liveTradingEnabled = before.liveTradingEnabled;
        // Deriv contract constraints — clamp to live-tradable range. Even if
        // the operator types an invalid value via the API, the bot enforces
        // valid Deriv-accepted values so live placeTrade can never reject.
        const clampedMult = clampDerivMultiplier(next.tradeMultiplier);
        if (clampedMult !== next.tradeMultiplier) {
          log.warn(`fast2Config tradeMultiplier ${next.tradeMultiplier}× snapped to Deriv-valid ${clampedMult}× (accepts: ${DERIV_MULTIPLIER_OPTIONS.join(",")})`);
          next.tradeMultiplier = clampedMult;
        }
        if (next.baseStake < DERIV_MIN_STAKE_USD) {
          log.warn(`fast2Config baseStake $${next.baseStake} clamped to Deriv min $${DERIV_MIN_STAKE_USD}`);
          next.baseStake = DERIV_MIN_STAKE_USD;
        }
        if (next.perTradeCap > DERIV_MAX_STAKE_USD) {
          log.warn(`fast2Config perTradeCap $${next.perTradeCap} clamped to Deriv max $${DERIV_MAX_STAKE_USD}`);
          next.perTradeCap = DERIV_MAX_STAKE_USD;
        }
        if (next.perTradeCap < DERIV_MIN_STAKE_USD) {
          next.perTradeCap = DERIV_MIN_STAKE_USD;
        }
        fast2Config = next;
        persist();
        log.warn("fast2Config updated via API", { before, after: next });
      },
      updateFast2StrategyConfig: (strategyId: string, patch: Partial<Fast2Config> | null) => {
        const beforePerStrat = { ...(fast2Config.perStrategy ?? {}) };
        if (patch === null) {
          // Clear the override entirely — strategy falls back to general config.
          if (beforePerStrat[strategyId]) delete beforePerStrat[strategyId];
          fast2Config = { ...fast2Config, perStrategy: beforePerStrat };
          persist();
          log.warn("fast2 per-strategy override cleared", { strategyId });
          return;
        }
        // Validate the patch before merging — prevents one bad field from
        // poisoning the override (we just drop invalid fields).
        const cleaned: Partial<Fast2Config> = {};
        if (patch.tradeMultiplier != null && isFinite(patch.tradeMultiplier) && patch.tradeMultiplier > 0) {
          cleaned.tradeMultiplier = clampDerivMultiplier(patch.tradeMultiplier);
        }
        if (patch.martingaleMultiplier != null && isFinite(patch.martingaleMultiplier) && patch.martingaleMultiplier > 1) {
          cleaned.martingaleMultiplier = patch.martingaleMultiplier;
        }
        if (patch.baseStake != null && isFinite(patch.baseStake) && patch.baseStake >= DERIV_MIN_STAKE_USD) {
          cleaned.baseStake = patch.baseStake;
        }
        if (patch.maxLevels != null && isFinite(patch.maxLevels) && patch.maxLevels >= 1) {
          cleaned.maxLevels = Math.round(patch.maxLevels);
        }
        if (patch.perTradeCap != null && isFinite(patch.perTradeCap) && patch.perTradeCap >= DERIV_MIN_STAKE_USD) {
          cleaned.perTradeCap = Math.min(patch.perTradeCap, DERIV_MAX_STAKE_USD);
        }
        if (patch.commissionPct != null && isFinite(patch.commissionPct) && patch.commissionPct >= 0) {
          cleaned.commissionPct = patch.commissionPct;
        }
        if (patch.entrySpreadBps != null && isFinite(patch.entrySpreadBps) && patch.entrySpreadBps >= 0) {
          cleaned.entrySpreadBps = patch.entrySpreadBps;
        }
        if (patch.slSlippageBps != null && isFinite(patch.slSlippageBps) && patch.slSlippageBps >= 0) {
          cleaned.slSlippageBps = patch.slSlippageBps;
        }
        if (typeof patch.forceMartingale === "boolean") cleaned.forceMartingale = patch.forceMartingale;
        if (patch.sideFilter === "both" || patch.sideFilter === "BUY" || patch.sideFilter === "SELL") {
          cleaned.sideFilter = patch.sideFilter;
        }
        if (patch.martingaleMode === "classic" || patch.martingaleMode === "anti") {
          cleaned.martingaleMode = patch.martingaleMode;
        }
        if (typeof patch.enabled === "boolean") cleaned.enabled = patch.enabled;
        // Note: liveTradingEnabled is NOT applied per-strategy — it's a
        // sandbox-wide safety knob. Use the general updateFast2Config to flip.
        const merged: Partial<Fast2Config> = { ...(beforePerStrat[strategyId] ?? {}), ...cleaned };
        beforePerStrat[strategyId] = merged;
        fast2Config = { ...fast2Config, perStrategy: beforePerStrat };
        persist();
        log.warn("fast2 per-strategy override updated", { strategyId, patch: cleaned, merged });
      },
      // ── Fast3 manual controls ──
      resetFast3Paper: (balance?: number) => {
        const newBal = balance ?? 41;
        fast3Paper.reset(newBal);
        for (const sId of Object.keys(fast3MartingalePaper)) fast3MartingalePaper[sId] = emptyMartingaleState();
        for (const sId of Object.keys(fast3MartingaleLive)) fast3MartingaleLive[sId] = emptyMartingaleState();
        persist();
        log.warn(`fast3Paper reset via API to $${newBal.toFixed(2)} — all DIGITODD ladders cleared`);
      },
      updateFast3Config: (patch: Partial<Fast3Config>) => {
        const before = { ...fast3Config };
        const next: Fast3Config = { ...fast3Config, ...patch };
        if (!isFinite(next.martingaleMultiplier) || next.martingaleMultiplier <= 1) next.martingaleMultiplier = before.martingaleMultiplier;
        if (!isFinite(next.baseStake) || next.baseStake <= 0) next.baseStake = before.baseStake;
        if (!isFinite(next.maxLevels) || next.maxLevels < 1) next.maxLevels = before.maxLevels;
        if (!isFinite(next.perTradeCap) || next.perTradeCap <= 0) next.perTradeCap = before.perTradeCap;
        if (typeof next.liveTradingEnabled !== "boolean") next.liveTradingEnabled = before.liveTradingEnabled;
        if (typeof next.forceMartingale !== "boolean") next.forceMartingale = before.forceMartingale;
        if (next.sideFilter !== "both" && next.sideFilter !== "BUY" && next.sideFilter !== "SELL") next.sideFilter = before.sideFilter;
        if (next.martingaleMode !== "classic" && next.martingaleMode !== "anti") next.martingaleMode = before.martingaleMode;
        if (next.baseStake < DERIV_MIN_STAKE_USD) next.baseStake = DERIV_MIN_STAKE_USD;
        if (next.perTradeCap > DERIV_MAX_STAKE_USD) next.perTradeCap = DERIV_MAX_STAKE_USD;
        if (next.perTradeCap < DERIV_MIN_STAKE_USD) next.perTradeCap = DERIV_MIN_STAKE_USD;
        fast3Config = next;
        persist();
        log.warn("fast3Config updated via API", { before, after: next });
      },
      updateRealConfig: (patch: Partial<RealConfig>) => {
        const before = { ...realConfig };
        const next: RealConfig = { ...realConfig, ...patch };
        if (typeof next.liveTradingEnabled !== "boolean") next.liveTradingEnabled = before.liveTradingEnabled;
        if (!isFinite(next.baseStake) || next.baseStake < DERIV_MIN_STAKE_USD) next.baseStake = before.baseStake;
        if (next.baseStake > DERIV_MAX_STAKE_USD) next.baseStake = DERIV_MAX_STAKE_USD;
        if (!isFinite(next.multiplier) || next.multiplier <= 0) next.multiplier = before.multiplier;
        next.multiplier = clampDerivMultiplier(next.multiplier);
        if (!isFinite(next.dailyMaxLoss) || next.dailyMaxLoss < 0) next.dailyMaxLoss = before.dailyMaxLoss;
        realConfig = next;
        // Re-apply the per-trade stake + daily loss cap so the engine's
        // gates use the new numbers immediately (otherwise the UI shows
        // the new cap but trades still fire on the old one until restart).
        real.setCaps(realConfig.baseStake, realConfig.dailyMaxLoss);
        persist();
        log.warn("realConfig updated via API", { before, after: next });
      },
      getRealConfig: () => realConfig,
      updateFast3StrategyConfig: (strategyId: string, patch: Partial<Fast3Config> | null) => {
        const beforePerStrat = { ...(fast3Config.perStrategy ?? {}) };
        if (patch === null) {
          if (beforePerStrat[strategyId]) delete beforePerStrat[strategyId];
          fast3Config = { ...fast3Config, perStrategy: beforePerStrat };
          persist();
          return;
        }
        const cleaned: Partial<Fast3Config> = {};
        if (patch.martingaleMultiplier != null && isFinite(patch.martingaleMultiplier) && patch.martingaleMultiplier > 1) cleaned.martingaleMultiplier = patch.martingaleMultiplier;
        if (patch.baseStake != null && isFinite(patch.baseStake) && patch.baseStake >= DERIV_MIN_STAKE_USD) cleaned.baseStake = patch.baseStake;
        if (patch.maxLevels != null && isFinite(patch.maxLevels) && patch.maxLevels >= 1) cleaned.maxLevels = Math.round(patch.maxLevels);
        if (patch.perTradeCap != null && isFinite(patch.perTradeCap) && patch.perTradeCap >= DERIV_MIN_STAKE_USD) cleaned.perTradeCap = Math.min(patch.perTradeCap, DERIV_MAX_STAKE_USD);
        if (typeof patch.enabled === "boolean") cleaned.enabled = patch.enabled;
        if (patch.sideFilter === "both" || patch.sideFilter === "BUY" || patch.sideFilter === "SELL") cleaned.sideFilter = patch.sideFilter;
        const merged: Partial<Fast3Config> = { ...(beforePerStrat[strategyId] ?? {}), ...cleaned };
        beforePerStrat[strategyId] = merged;
        fast3Config = { ...fast3Config, perStrategy: beforePerStrat };
        persist();
      },
      closeFast2Position: async (id: string, mode: "paper" | "live") => {
        if (mode === "live") {
          await real.closeContract(id);
          log.warn("fast2 LIVE position manually closed via API", { id });
          return;
        }
        // Paper close: settle the position at the current last-known price
        // for that symbol. Picks the latest close from any engine running it.
        const pos = fast2Paper.getState().open.find((p) => p.id === id);
        if (!pos) throw new Error("position not found");
        let exitPrice: number | null = null;
        for (const eng of engines.values()) {
          const px = eng.lastCloseFor(pos.symbol as SymbolCode);
          if (px != null) { exitPrice = px; break; }
        }
        if (exitPrice == null) throw new Error("no live price available for symbol");
        const closed = fast2Paper.closeById(id, exitPrice, Date.now(), "manual");
        if (!closed) throw new Error("close failed");
        log.warn(`fast2Paper position manually closed: ${closed.symbol} ${closed.side} pnl=$${closed.pnl.toFixed(2)} at exit=${exitPrice.toFixed(5)}`);
      },
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
      reconcileContracts: async () => {
        const before = real.state().open.length;
        log.warn("manual contract reconciliation initiated via API", { openBefore: before });
        try {
          const res = await real.reconcileOpenContracts();
          const after = real.state().open.length;
          log.info("manual contract reconciliation complete", { openBefore: before, openAfter: after, ...res });
          if (res.settled > 0) persist();
        } catch (e) {
          log.error("manual contract reconciliation threw", { err: (e as Error).message });
          throw e;
        }
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
    getFastPaperState: () => fastPaper.getState(),
    getFastPaperStats: () => fastPaper.stats() as unknown as Record<string, number>,
    getFastMartingale: () => {
      const params = fast1MartingaleParams();
      return Object.fromEntries(
        FAST_STRATEGIES.map((s) => {
          const m = fastMartingale[s.id] ?? emptyMartingaleState();
          return [s.id, {
            level: m.level,
            wins: m.wins,
            losses: m.losses,
            circuitBreakers: m.circuitBreakers,
            lastCircuitBreakerAt: m.lastCircuitBreakerAt,
            nextStake: fastNextStake(m, params),
          }];
        }),
      );
    },
    getFast1Config: () => ({ ...fast1Config }),
    getFast2PaperState: () => fast2Paper.getState(),
    getFast2PaperStats: () => fast2Paper.stats() as unknown as Record<string, number>,
    getFast2Martingale: () => {
      // Surface the ladder of the *active* mode — that's what governs the
      // next trade's stake. The dormant ladder is still tracked internally
      // and persisted, but doesn't show up in the "current" view to keep
      // the UI legible.
      const params = fast2MartingaleParams();
      const activeMap = fast2MartingaleFor(fast2ActiveMode());
      return Object.fromEntries(
        FAST2_STRATEGIES.map((s) => {
          const m = activeMap[s.id] ?? emptyMartingaleState();
          return [s.id, {
            level: m.level,
            wins: m.wins,
            losses: m.losses,
            circuitBreakers: m.circuitBreakers,
            lastCircuitBreakerAt: m.lastCircuitBreakerAt,
            nextStake: fastNextStake(m, params),
          }];
        }),
      );
    },
    getFast2Config: () => ({ ...fast2Config }),
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
    getLastPriceFor: (symbol: string) => {
      // Prefer the most-recent close from any engine running this symbol
      // (across granularities). Fast2 strategies are 5m so usually only one.
      for (const eng of engines.values()) {
        const px = eng.lastCloseFor(symbol as SymbolCode);
        if (px != null) return px;
      }
      return null;
    },
    getFastStrategyStats: () => {
      const sigs = recentSignals;
      return FAST_STRATEGIES.map((s) => {
        const detIds = s.detectors.filter((d) => d.enabled).map((d) => d.id);
        const sSyms = new Set(s.symbols);
        const sigsForStrat = sigs.filter((sg) => sSyms.has(sg.symbol) && detIds.includes(sg.detector));
        const closed = fastPaper.getState().closed.filter((t) => sSyms.has(t.symbol) && t.granularity === s.granularity && detIds.includes(t.detector));
        const wins = closed.filter((t) => t.pnl > 0).length;
        const pnl = closed.reduce((acc, t) => acc + t.pnl, 0);
        let barsSeen = 0;
        for (const sym of s.symbols) {
          barsSeen += totalNewBarsByKey.get(`${sym}|${s.granularity}`) ?? 0;
        }
        return {
          id: s.id, name: s.name, description: s.description, symbols: s.symbols, granularity: s.granularity,
          validation: { expectancyR: s.validation?.expectancyR, winRate: s.validation?.winRate, pnlUsd: s.validation?.pnlUsd, trades: s.validation?.trades },
          live: {
            signals: sigsForStrat.length, trades: closed.length, wins, losses: closed.length - wins,
            pnlUsd: pnl, winRate: closed.length ? wins / closed.length : 0, expectancyR: 0,
            lastSignalAt: sigsForStrat.length ? Math.max(...sigsForStrat.map((sg) => sg.ts)) : null,
            lastTradeAt: closed.length ? Math.max(...closed.map((t) => t.closedAt ?? 0)) : null,
            barsSeen,
            lastBarSeenAt: strategyLastBarSeenAt.get(s.id) ?? null,
          },
        };
      });
    },
    getFast2StrategyStats: () => {
      const sigs = recentSignals;
      return FAST2_STRATEGIES.map((s) => {
        const detIds = s.detectors.filter((d) => d.enabled).map((d) => d.id);
        const sSyms = new Set(s.symbols);
        const sigsForStrat = sigs.filter((sg) => sSyms.has(sg.symbol) && detIds.includes(sg.detector));
        const closed = fast2Paper.getState().closed.filter((t) => sSyms.has(t.symbol) && t.granularity === s.granularity && detIds.includes(t.detector));
        const wins = closed.filter((t) => t.pnl > 0).length;
        const pnl = closed.reduce((acc, t) => acc + t.pnl, 0);
        let barsSeen = 0;
        for (const sym of s.symbols) {
          barsSeen += totalNewBarsByKey.get(`${sym}|${s.granularity}`) ?? 0;
        }
        return {
          id: s.id, name: s.name, description: s.description, symbols: s.symbols, granularity: s.granularity,
          validation: { expectancyR: s.validation?.expectancyR, winRate: s.validation?.winRate, pnlUsd: s.validation?.pnlUsd, trades: s.validation?.trades },
          live: {
            signals: sigsForStrat.length, trades: closed.length, wins, losses: closed.length - wins,
            pnlUsd: pnl, winRate: closed.length ? wins / closed.length : 0, expectancyR: 0,
            lastSignalAt: sigsForStrat.length ? Math.max(...sigsForStrat.map((sg) => sg.ts)) : null,
            lastTradeAt: closed.length ? Math.max(...closed.map((t) => t.closedAt ?? 0)) : null,
            barsSeen,
            lastBarSeenAt: strategyLastBarSeenAt.get(s.id) ?? null,
          },
        };
      });
    },
    getFast3PaperState: () => fast3Paper.getState(),
    getFast3PaperStats: () => fast3Paper.stats() as unknown as Record<string, number>,
    getFast3Martingale: () => {
      const out: Record<string, { level: number; wins: number; losses: number; circuitBreakers: number; lastCircuitBreakerAt: number; nextStake: number }> = {};
      const map = fast3MartingaleFor(fast3ActiveMode());
      for (const s of FAST3_STRATEGIES) {
        const m = map[s.id] ?? emptyMartingaleState();
        const cfg = fast3ConfigFor(s.id);
        const params: MartingaleParams = { baseStake: cfg.baseStake, multiplier: cfg.martingaleMultiplier, maxLevels: cfg.maxLevels, perTradeCap: cfg.perTradeCap };
        out[s.id] = { level: m.level, wins: m.wins, losses: m.losses, circuitBreakers: m.circuitBreakers, lastCircuitBreakerAt: m.lastCircuitBreakerAt, nextStake: fastNextStake(m, params) };
      }
      return out;
    },
    getFast3Config: () => ({ ...fast3Config }),
    getFast3StrategyStats: () => {
      return FAST3_STRATEGIES.map((s) => {
        const sSyms = new Set(s.symbols);
        // Fast3 closed trades have detector === FAST3_DETECTOR_TAG
        const closed = fast3Paper.getState().closed.filter((t) => sSyms.has(t.symbol) && t.detector === FAST3_DETECTOR_TAG);
        const wins = closed.filter((t) => t.pnl > 0).length;
        const pnl = closed.reduce((acc, t) => acc + t.pnl, 0);
        return {
          id: s.id, name: s.name, description: s.description, symbols: s.symbols, granularity: s.granularity,
          validation: { expectancyR: s.validation?.expectancyR, winRate: s.validation?.winRate, pnlUsd: s.validation?.pnlUsd, trades: s.validation?.trades },
          live: {
            signals: closed.length, trades: closed.length, wins, losses: closed.length - wins,
            pnlUsd: pnl, winRate: closed.length ? wins / closed.length : 0, expectancyR: 0,
            lastSignalAt: closed.length ? Math.max(...closed.map((t) => t.closedAt ?? 0)) : null,
            lastTradeAt: closed.length ? Math.max(...closed.map((t) => t.closedAt ?? 0)) : null,
            barsSeen: 0,
            lastBarSeenAt: null,
          },
        };
      });
    },
    getRecentLogs: (limit: number) => log.tail(limit),
  });

  // Build the per-(sym, gr) engine detector config by merging every strategy
  // (real + fast + fast2) that runs on this key. Each detector starts disabled with
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
      ...FAST_STRATEGIES.filter((s) => s.symbols.includes(sym) && s.granularity === gr),
      ...FAST2_STRATEGIES.filter((s) => s.symbols.includes(sym) && s.granularity === gr),
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

  // Compute the full set of (sym, gr) pairs the bot is supposed to be
  // subscribed to, derived from every strategy registry. The single source of
  // truth that subscribeAll, self-heal, and post-reconnect-heal all consult.
  function expectedPairs(): Set<string> {
    const pairs = new Set<string>();
    for (const s of STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    for (const s of FAST_STRATEGIES) for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    // Skip granularity=0 (tick-level) strategies — those are handled by the
    // tick subscription block, not the candle pipeline. Including them here
    // makes subscribePair call deriv.subscribeCandles with granularity=0,
    // which Deriv rejects with InputValidationFailed: granularity.
    for (const s of FAST2_STRATEGIES) {
      if (s.granularity === 0) continue;
      for (const sym of s.symbols) pairs.add(`${sym}|${s.granularity}`);
    }
    return pairs;
  }

  // Track ticked symbols across calls — Deriv only allows one tick stream per
  // symbol but multiple candle granularities. self-heal calls subscribePair
  // for individual pairs and must not re-subscribe ticks unnecessarily.
  const tickedSymbols = new Set<string>();

  // Track pairs that returned "MarketIsClosed" so self-heal/subscribeAll backs
  // off instead of retrying every 30 seconds during weekends/market closures.
  // Forex (frx*) and commodities close Sat 21:00 UTC → Sun 21:00 UTC.
  // Re-check after MARKET_CLOSED_BACKOFF_MS to catch market reopen on Monday.
  const marketClosedPairs = new Map<string, number>(); // key → timestamp last failed
  const MARKET_CLOSED_BACKOFF_MS = 30 * 60 * 1000; // re-check every 30 min

  // Subscribe a single (sym, gr) pair end-to-end: fetch history, build engine,
  // seed chart buffer, optionally subscribe ticks, register in subscribedKeys.
  // Returns true on success, false on permanent failure (3 retries exhausted).
  async function subscribePair(sym: string, gr: number): Promise<boolean> {
    const key = engKey(sym, gr);
    if (subscribedKeys.has(key) && engines.has(key) && chartBuffers.has(key)) {
      return true; // already fully wired
    }
    // If this pair was recently flagged "MarketIsClosed", back off until the
    // backoff window elapses. Synth indices (R_*, BOOM*, CRASH*, RDBEAR/RDBULL,
    // 1HZ*, JD*, RB*, stpRNG*) are 24/7 and never trigger this gate.
    const closedAt = marketClosedPairs.get(key);
    if (closedAt != null && Date.now() - closedAt < MARKET_CLOSED_BACKOFF_MS) {
      return false; // silently skip — wait for backoff to expire
    }
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        // Seed candle buffer with deep history (was 1000 bars, bumped 2026-05-02
        // to 2000 to ensure ALL strategies are fully warmed for any combo of
        // detector lookback + ATR + efficiency windows. Detector minimums:
        //   breakoutMeanRev / breakoutContinuation: 15 lookback + 14 ATR = 29
        //   spike-fade: 14 ATR + 1 confirm = 15
        // 2000 = 70× headroom; ensures stable indicators on first live bar.
        const history = await deriv.subscribeCandles(sym as SymbolCode, gr as Granularity, 2000);
        const detectorConfigs = buildEngineDetectorConfigs(sym, gr);
        const eng = new Engine(detectorConfigs, { mode: "raw", adxThreshold: 22, confluenceWindowBars: 3 });
        eng.seed(sym as SymbolCode, history);
        engines.set(key, eng);
        chartBuffers.set(key, [...history]);
        // Prime the cumulative bars-seen counter with the seeded history so
        // the Strategies UI reflects the engine's actual context, not just
        // the bars that closed since boot. Without this, a 2-hour-old bot
        // shows "bars seen: 25" on a 5m stream when the detector actually
        // has 2025 bars of context (2000 seeded + 25 new). Use max() so a
        // self-heal re-subscribe (which re-seeds the buffer) doesn't double
        // the count or roll it backward.
        totalNewBarsByKey.set(key, Math.max(totalNewBarsByKey.get(key) ?? 0, history.length));
        if (!tickedSymbols.has(sym)) {
          await deriv.subscribeTicks(sym as SymbolCode);
          tickedSymbols.add(sym);
        }
        subscribedKeys.add(key);
        const enabledDets = detectorConfigs.filter((d) => d.enabled).map((d) => d.id).join(",");
        log.info(`subscribed ${sym}@${gr}s (seeded=${history.length}, detectors=[${enabledDets}], attempt=${attempt + 1}) — fully warmed`);
        return true;
      } catch (e) {
        lastErr = e as Error;
        // MarketIsClosed is a benign weekend state for forex/commodity pairs.
        // Stop retrying immediately, mark for backoff, and let self-heal poll
        // again after 30 min (instead of hammering the API every 30 sec).
        if (lastErr.message.includes("MarketIsClosed")) {
          marketClosedPairs.set(key, Date.now());
          log.info(`market closed ${sym}@${gr}s — backing off for ${MARKET_CLOSED_BACKOFF_MS / 60000} min`);
          return false;
        }
        log.warn(`subscribe attempt ${attempt + 1}/3 failed ${sym}@${gr}s: ${lastErr.message}`);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (lastErr) log.error(`subscribe failed after 3 retries ${sym}@${gr}s: ${lastErr.message}`);
    return false;
  }

  // Subscribe to every (sym, gr) the strategy registries expect. Idempotent —
  // safe to call repeatedly; subscribePair short-circuits when already wired.
  // After all subscriptions resolve, verify FULL WARMUP across every Fast2
  // strategy before declaring the live system armed.
  async function subscribeAll() {
    const pairs = expectedPairs();
    for (const key of pairs) {
      const [sym, grStr] = key.split("|");
      await subscribePair(sym, Number(grStr));
    }
    // Warmup verification: every Fast2 strategy's (sym, gr) pair must be seeded.
    const fast2Pairs = new Set<string>();
    // Only candle-based fast2 strategies need to be warmed via subscribeCandles.
    // Tick-level strategies (granularity=0) get a tick stream from the fast2
    // tick-subscription block below — they don't have candle pipelines to seed.
    for (const s of FAST2_STRATEGIES) {
      if (s.granularity === 0) continue;
      for (const sym of s.symbols) fast2Pairs.add(`${sym}|${s.granularity}`);
    }
    const unwarmed: string[] = [];
    for (const key of fast2Pairs) {
      if (!subscribedKeys.has(key) || !engines.has(key)) unwarmed.push(key);
    }
    if (unwarmed.length === 0) {
      log.info(`✓ ALL Fast2 R-stack strategies fully warmed up (${FAST2_STRATEGIES.length} strategies / ${fast2Pairs.size} sym-gr pairs / 2000 bars seeded each)`);
      log.info(`  LIVE trading armed for: ${FAST2_STRATEGIES.map((s) => s.id).join(", ")}`);
    } else {
      log.warn(`⚠ Fast2 NOT fully warmed — unsubscribed pairs: ${unwarmed.join(", ")}. Live trading will be partial until self-heal completes.`);
    }
    // ── Fast3 tick subscription: ensure every Fast3 symbol has a tick stream ──
    // Fast3 strategies are tick-level (granularity=0) and don't go through the
    // candle pipeline. Subscribe to ticks for any Fast3 symbol that isn't
    // already covered by a Fast2/STRATEGIES candle subscription.
    const fast3Symbols = new Set<string>();
    for (const s of FAST3_STRATEGIES) for (const sym of s.symbols) fast3Symbols.add(sym);
    for (const sym of Array.from(fast3Symbols)) {
      if (tickedSymbols.has(sym)) continue;
      try {
        await deriv.subscribeTicks(sym as SymbolCode);
        tickedSymbols.add(sym);
        log.info(`fast3 tick subscription: ${sym} active`);
      } catch (e) {
        log.warn(`fast3 tick subscription failed for ${sym}: ${(e as Error).message}`);
      }
    }
    log.info(`✓ Fast3 DIGITODD ready (${FAST3_STRATEGIES.length} strategies / ${fast3Symbols.size} symbols)`);
    // ── Fast2 tick subscription: same pattern, for granularity=0 strategies ──
    const fast2TickSymbols = new Set<string>();
    for (const s of FAST2_STRATEGIES) if (s.granularity === 0) for (const sym of s.symbols) fast2TickSymbols.add(sym);
    for (const sym of Array.from(fast2TickSymbols)) {
      if (tickedSymbols.has(sym)) continue;
      try {
        await deriv.subscribeTicks(sym as SymbolCode);
        tickedSymbols.add(sym);
        log.info(`fast2 tick subscription: ${sym} active`);
      } catch (e) {
        log.warn(`fast2 tick subscription failed for ${sym}: ${(e as Error).message}`);
      }
    }
    if (fast2TickSymbols.size > 0) {
      log.info(`✓ Fast2 DIGITOVER 0 ready (${Array.from(fast2TickSymbols).length} tick-level strategies)`);
    }
  }

  // Candle handler — routes the candle to the (symbol, granularity)-specific
  // Engine and chart buffer. The granularity arg is the 4th positional emit
  // parameter from the deriv client (added so multi-granularity can route).
  // Once-per-key warning for candles flowing to a stream the bot has no
  // engine/chartBuffer for. Surfaces the silent-orphan failure mode where
  // DerivClient's auto-resubscribe re-attaches a stream after reconnect but
  // the bot's subscribeAll never seeded the bot-side state for it.
  const orphanWarnedKeys = new Set<string>();

  deriv.on("candle", (symbol, candle, isNew, granularity?: number) => {
    if (granularity == null) return; // pre-emit-update legacy event — ignore
    const key = engKey(symbol, granularity);
    lastCandleAtByKey.set(key, Date.now());
    candlesSinceHeartbeat.set(key, (candlesSinceHeartbeat.get(key) ?? 0) + 1);
    totalCandlesByKey.set(key, (totalCandlesByKey.get(key) ?? 0) + 1);
    // Orphan detection: candles arriving for a key we never wired up. Trigger
    // a one-shot async fix (subscribePair re-seeds engine + chartBuffer).
    if (!engines.has(key) || !chartBuffers.has(key)) {
      if (!orphanWarnedKeys.has(key)) {
        orphanWarnedKeys.add(key);
        log.warn(`orphan candle stream ${key} — bot-side engine/chartBuffer missing, attempting on-the-fly subscribe`);
        subscribePair(symbol, granularity).then((ok) => {
          if (ok) log.info(`orphan ${key} healed via on-the-fly subscribe`);
          else log.error(`orphan ${key} on-the-fly subscribe failed permanently`);
        }).catch((e) => log.error(`orphan ${key} on-the-fly subscribe threw`, { err: (e as Error).message }));
      }
      return; // drop this tick — engine isn't ready yet
    }
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
    // Settle fast-trade paper positions and advance the martingale ladder for
    // each settled position. The martingale state is per-strategy keyed off
    // the FAST_STRATEGIES (sym, gr) match; if a settled position can't be
    // tied back to a fast strategy, ladder is left untouched.
    const settledFast = fastPaper.onCandle(symbol, granularity, candle);
    for (const c of settledFast) {
      const fastStrat = FAST_STRATEGIES.find((s) => s.symbols.includes(c.symbol) && s.granularity === c.granularity);
      if (fastStrat) {
        const before = fastMartingale[fastStrat.id] ?? emptyMartingaleState();
        // Always update the W/L counters (telemetry) but only escalate the
        // ladder for strategies that opted into martingale (per-strategy flag)
        // OR when the UI has flipped the forceMartingale override on the
        // sandbox config.
        const martingaleActive = fastStrat.useMartingale || fast1Config.forceMartingale;
        if (martingaleActive) {
          const params = fast1MartingaleParams();
          const { state: nextLadder, circuitBreakerFired } = fastMartingaleUpdate(before, c.pnl, params, Date.now(), fast1Config.martingaleMode);
          fastMartingale[fastStrat.id] = nextLadder;
          const forced = !fastStrat.useMartingale && fast1Config.forceMartingale ? " FORCED" : "";
          const modeTag = fast1Config.martingaleMode === "anti" ? " ANTI" : "";
          log.info(`fastPaper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${fastPaper.getState().balance.toFixed(2)} strategy=${fastStrat.id} lvl=${nextLadder.level} W=${nextLadder.wins} L=${nextLadder.losses} mart=${params.multiplier}×${modeTag}${forced} MULT=${fast1Config.tradeMultiplier}×${circuitBreakerFired ? " CIRCUIT-BREAKER" : ""}`);
          if (circuitBreakerFired) {
            log.warn(`fast martingale circuit-breaker fired for ${fastStrat.id}: ladder reset after ${params.maxLevels} ${fast1Config.martingaleMode === "anti" ? "wins" : "losses"}`);
          }
        } else {
          // No-martingale path: track W/L for telemetry but never escalate.
          fastMartingale[fastStrat.id] = {
            ...before,
            wins: before.wins + (c.pnl > 0 ? 1 : 0),
            losses: before.losses + (c.pnl > 0 ? 0 : 1),
            level: 0,
            cumulativeSinceReset: 0,
          };
          log.info(`fastPaper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${fastPaper.getState().balance.toFixed(2)} strategy=${fastStrat.id} W=${fastMartingale[fastStrat.id].wins} L=${fastMartingale[fastStrat.id].losses} (no martingale)`);
        }
        persist();
      } else {
        log.info(`fastPaper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} (no matching fast strategy)`);
      }
    }
    // Fast2 settles use the live config-driven martingale params. Every Fast2
    // strategy opts into useMartingale=true, so the W/L counters track the
    // ladder identically to fastPaper.
    const settledFast2 = fast2Paper.onCandle(symbol, granularity, candle);
    for (const c of settledFast2) {
      const fast2Strat = FAST2_STRATEGIES.find((s) => s.symbols.includes(c.symbol) && s.granularity === c.granularity);
      if (fast2Strat) {
        // Paper settle → ALWAYS updates the PAPER ladder, regardless of the
        // current liveTradingEnabled flag. (A paper position open before a
        // mode switch still settles into the paper ladder; it does not bleed
        // into the live ladder.)
        const before = fast2MartingalePaper[fast2Strat.id] ?? emptyMartingaleState();
        const sCfgPaper = fast2ConfigFor(fast2Strat.id);
        const martingaleActive = fast2Strat.useMartingale || sCfgPaper.forceMartingale;
        if (martingaleActive) {
          const params = fast2MartingaleParams(fast2Strat.id);
          const { state: nextLadder, circuitBreakerFired } = fastMartingaleUpdate(before, c.pnl, params, Date.now(), sCfgPaper.martingaleMode);
          fast2MartingalePaper[fast2Strat.id] = nextLadder;
          const forced = !fast2Strat.useMartingale && sCfgPaper.forceMartingale ? " FORCED" : "";
          const modeTag = sCfgPaper.martingaleMode === "anti" ? " ANTI" : "";
          log.info(`fast2Paper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${fast2Paper.getState().balance.toFixed(2)} strategy=${fast2Strat.id} lvl=${nextLadder.level} W=${nextLadder.wins} L=${nextLadder.losses} mart=${params.multiplier}×${modeTag}${forced} MULT=${sCfgPaper.tradeMultiplier}×${circuitBreakerFired ? " CIRCUIT-BREAKER" : ""}`);
          if (circuitBreakerFired) {
            log.warn(`fast2 martingale circuit-breaker fired for ${fast2Strat.id}: ladder reset after ${params.maxLevels} ${sCfgPaper.martingaleMode === "anti" ? "wins" : "losses"}`);
          }
        } else {
          fast2MartingalePaper[fast2Strat.id] = {
            ...before,
            wins: before.wins + (c.pnl > 0 ? 1 : 0),
            losses: before.losses + (c.pnl > 0 ? 0 : 1),
            level: 0,
            cumulativeSinceReset: 0,
          };
          log.info(`fast2Paper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} R=${c.rMultiple.toFixed(2)} balance=$${fast2Paper.getState().balance.toFixed(2)} strategy=${fast2Strat.id} W=${fast2MartingalePaper[fast2Strat.id].wins} L=${fast2MartingalePaper[fast2Strat.id].losses} (no martingale)`);
        }
        persist();
      } else {
        log.info(`fast2Paper settled ${c.symbol} ${c.side} ${c.result} pnl=$${c.pnl.toFixed(2)} (no matching fast2 strategy)`);
      }
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
      for (const s of FAST_STRATEGIES) {
        if (s.symbols.includes(symbol) && s.granularity === granularity) {
          strategyLastBarSeenAt.set(s.id, now);
        }
      }
      for (const s of FAST2_STRATEGIES) {
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
      // Per-sandbox routing: push the signal into every sandbox's buffer
      // whose strategy registry contains a matching (sym, gr, detector)
      // tuple. A signal can land in multiple buffers, and zero buffers if
      // it's an orphan — useful diagnostic in itself.
      const sym = sig.symbol;
      const det = sig.detector;
      const matchedReal  = STRATEGIES.some((s) => s.symbols.includes(sym as SymbolCode) && s.granularity === granularity && s.detectors.some((d) => d.id === det && d.enabled));
      const matchedFast  = FAST_STRATEGIES.some((s) => s.symbols.includes(sym) && s.granularity === granularity && s.detectors.some((d) => d.id === det && d.enabled));
      const matchedFast2 = FAST2_STRATEGIES.some((s) => s.symbols.includes(sym) && s.granularity === granularity && s.detectors.some((d) => d.id === det && d.enabled));
      if (matchedReal)  pushBounded(realRecentSignals, sig);
      if (matchedFast)  pushBounded(fastRecentSignals, sig);
      if (matchedFast2) pushBounded(fast2RecentSignals, sig);
      if (!matchedReal && !matchedFast && !matchedFast2) {
        log.warn("signal landed in no sandbox buffer", { symbol: sym, granularity, detector: det, action: sig.action });
      }
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

    // Fast-trade sandbox: signals from the trendContinuation detector on
    // FAST_STRATEGIES (sym, gr) pairs are routed to fastPaper with martingale
    // stake.
    const fastMatch = FAST_STRATEGIES.find((s) =>
      s.symbols.includes(sig.symbol) &&
      s.granularity === granularity &&
      s.detectors.some((d) => d.id === sig.detector && d.enabled),
    );
    let handledFast = false;
    if (fastMatch) {
      const passes = passesStrategyFilters(fastMatch);
      const sideAllowed = fast1Config.sideFilter === "both" || fast1Config.sideFilter === sig.action;
      if (!passes) {
        log.info("fast signal blocked by strategy filters", { symbol: sig.symbol, side: sig.action, strategy: fastMatch.id });
        handledFast = true;
      } else if (!sideAllowed) {
        log.info("fast signal blocked by sandbox sideFilter", { symbol: sig.symbol, side: sig.action, strategy: fastMatch.id, sideFilter: fast1Config.sideFilter });
        handledFast = true;
      } else {
        const alreadyOpen = fastPaper.getState().open.some((p) => p.symbol === sig.symbol);
        if (alreadyOpen) {
          log.info("fast signal skipped — position already open", { symbol: sig.symbol, side: sig.action, strategy: fastMatch.id });
          handledFast = true;
        } else {
          const ladder = fastMartingale[fastMatch.id] ?? emptyMartingaleState();
          const params = fast1MartingaleParams();
          // Strategies with positive raw expectancy can opt out of martingale
          // (useMartingale=false) — they get a flat baseStake. Strategies with
          // useMartingale=true ride the configured ladder. The UI override
          // (fast1Config.forceMartingale) wins regardless of the per-strategy
          // flag so the operator can flip martingale on for any strategy.
          const martingaleActive = fastMatch.useMartingale || fast1Config.forceMartingale;
          const stake = martingaleActive
            ? fastNextStake(ladder, params)
            : params.baseStake;
          const pos = fastPaper.openPosition({
            signalId: sig.id,
            symbol: sig.symbol,
            side: sig.action,
            detector: sig.detector,
            entryPrice: entryPriceHint,
            atr,
            atrTpMult: fastMatch.atrTpMult,
            atrSlMult: fastMatch.atrSlMult,
            // Fast uses the user-selected leverage from fast1Config rather
            // than the bot-wide cfg.multiplier.
            multiplier: fast1Config.tradeMultiplier,
            granularity,
            candleEpoch: candle.epoch,
            baseStake: params.baseStake,
            minStake: 0.5,
            nowMs: Date.now(),
            signalStopPrice: sig.stopPrice,
            signalTargetPrice: sig.targetPrice,
            stakeOverride: stake,
            commissionPct: fast1Config.commissionPct,
            entrySpreadFrac: fast1Config.entrySpreadBps / 10000,
            slSlippageFrac: fast1Config.slSlippageBps / 10000,
          });
          if (pos) {
            log.info(`fastPaper opened ${pos.symbol} ${pos.side} strategy=${fastMatch.id} stake=$${pos.stake.toFixed(2)} lvl=${ladder.level} MULT=${fast1Config.tradeMultiplier}× mart=${params.multiplier}× fee=$${pos.commission.toFixed(2)} entry=${pos.entryPrice.toFixed(5)} sl=${pos.stopPrice.toFixed(5)} tp=${pos.takeProfitPrice.toFixed(5)}`);
          } else {
            log.warn(`fastPaper open rejected ${sig.symbol} ${sig.action} (atr=${atr}, balance=$${fastPaper.getState().balance.toFixed(2)}, stake=$${stake})`);
          }
          handledFast = true;
        }
      }
    }

    // Fast2 sandbox: parallel to Fast. Same signal can be routed to BOTH
    // sandboxes when the (sym, gr, detector) tuple matches both registries —
    // each sandbox owns its own paper account, ladder, leverage, and martingale
    // multiplier so they evolve independently.
    const fast2Match = FAST2_STRATEGIES.find((s) =>
      s.symbols.includes(sig.symbol) &&
      s.granularity === granularity &&
      s.detectors.some((d) => d.id === sig.detector && d.enabled),
    );
    let handledFast2 = false;
    if (fast2Match) {
      // Effective config for THIS strategy — overlays per-strategy overrides
      // on top of the general fast2Config. Lets the operator tune buy/sell,
      // stake, mart per asset without affecting the rest of the stack.
      const sCfg = fast2ConfigFor(fast2Match.id);
      const passes = passesStrategyFilters(fast2Match);
      // Per-strategy side filter (falls back to general). Drops signals on
      // the disabled direction. "both" lets every signal through.
      const sideAllowed = sCfg.sideFilter === "both" || sCfg.sideFilter === sig.action;
      // Per-strategy kill switch. When `enabled === false` (only set via
      // perStrategy override), drop signals before any open path.
      const stratEnabled = (fast2Config.perStrategy?.[fast2Match.id]?.enabled ?? true) !== false;
      if (!stratEnabled) {
        log.info("fast2 signal blocked — strategy disabled by operator", { symbol: sig.symbol, side: sig.action, strategy: fast2Match.id });
        handledFast2 = true;
      } else if (!passes) {
        log.info("fast2 signal blocked by strategy filters", { symbol: sig.symbol, side: sig.action, strategy: fast2Match.id });
        handledFast2 = true;
      } else if (!sideAllowed) {
        log.info("fast2 signal blocked by sideFilter", { symbol: sig.symbol, side: sig.action, strategy: fast2Match.id, sideFilter: sCfg.sideFilter });
        handledFast2 = true;
      } else if (isFast2DDPaused()) {
        log.info("fast2 signal blocked by session-DD circuit", { symbol: sig.symbol, side: sig.action, strategy: fast2Match.id });
        handledFast2 = true;
      } else {
        // Dedupe per-strategy (was per-symbol — too restrictive when one
        // symbol hosts multiple strategies, e.g. BOOM300N has fade_up +
        // drift_down, JD75 has fade_up + fade_down). Each strategy can have
        // ONE concurrent open at a time; different strategies on the same
        // symbol run in parallel.
        const isLiveMode = sCfg.liveTradingEnabled;
        const stratDetectorIds = fast2Match.detectors.filter((d) => d.enabled).map((d) => d.id);
        const alreadyOpen = isLiveMode
          ? real.state().open.some((t) => t.sandbox === "fast2" && t.sandboxStrategyId === fast2Match.id)
          : fast2Paper.getState().open.some((p) =>
              p.symbol === sig.symbol &&
              stratDetectorIds.includes(p.detector) &&
              p.side === sig.action,
            );
        if (alreadyOpen) {
          log.info("fast2 signal skipped — position already open", { symbol: sig.symbol, side: sig.action, strategy: fast2Match.id, mode: isLiveMode ? "live" : "paper" });
          handledFast2 = true;
        } else {
          // Stake is derived from the ladder of the *active* mode only —
          // paper losses cannot influence live stake and vice versa.
          const ladderMap = fast2MartingaleFor(fast2ActiveMode());
          const ladder = ladderMap[fast2Match.id] ?? emptyMartingaleState();
          const params = fast2MartingaleParams(fast2Match.id);
          const martingaleActive = fast2Match.useMartingale || sCfg.forceMartingale;
          const stake = martingaleActive
            ? fastNextStake(ladder, params)
            : params.baseStake;

          if (sCfg.liveTradingEnabled) {
            // ── LIVE PATH: route to real.placeTrade with sandbox tag. ─────
            // All latency hardening from the prior commit applies here:
            //   • lastTickFor() price-tolerance abort before the buy
            //   • signalFiredAt → openLatencyMs telemetry
            //   • entrySlippage captured from proposal.spot
            //   • openLatencyMs feeds the latency circuit breaker
            // The fast2 ladder advances when real.on("settled") fires for
            // a contract tagged sandbox="fast2" (see listener below).
            const realGate = real.canOpen();
            if (!realGate.ok) {
              log.warn(`fast2 LIVE blocked by real-engine gate: ${realGate.reason}`);
              handledFast2 = true;
            } else {
              // Final-mile clamps before sending to Deriv. The validator on
              // updateFast2Config already snaps these; this is a belt-and-
              // braces guard against persisted-state from older deploys.
              const liveMult = clampDerivMultiplier(sCfg.tradeMultiplier);
              const liveStake = Math.min(DERIV_MAX_STAKE_USD, Math.max(DERIV_MIN_STAKE_USD, stake));
              if (liveMult !== sCfg.tradeMultiplier) {
                log.warn(`fast2 LIVE: tradeMultiplier ${sCfg.tradeMultiplier}× → ${liveMult}× (Deriv-valid clamp before placeTrade)`);
              }
              if (liveStake !== stake) {
                log.warn(`fast2 LIVE: stake $${stake} → $${liveStake} (Deriv stake range $${DERIV_MIN_STAKE_USD}-$${DERIV_MAX_STAKE_USD})`);
              }
              try {
                const trade = await real.placeTrade({
                  symbol: sig.symbol as SymbolCode,
                  side: sig.action,
                  family: "MULTIPLIER",
                  multiplier: liveMult,
                  tpSlMode: "atr",
                  atrTpMult: fast2Match.atrTpMult,
                  atrSlMult: fast2Match.atrSlMult,
                  atr,
                  entryPriceHint,
                  detector: sig.detector,
                  signalStopPrice: sig.stopPrice,
                  signalTargetPrice: sig.targetPrice,
                  signalFiredAt: sig.ts,
                  stakeOverride: liveStake,
                  sandbox: "fast2",
                  sandboxStrategyId: fast2Match.id,
                });
                log.info(`fast2 LIVE opened ${trade.symbol} ${trade.side} strategy=${fast2Match.id} stake=$${trade.stake.toFixed(2)} lvl=${ladder.level} MULT=${liveMult}× mart=${params.multiplier}× contract=${trade.contractId} latencyMs=${trade.openLatencyMs ?? "?"} slippage=${trade.entrySlippage?.toFixed(5) ?? "?"}`);
              } catch (e) {
                const msg = (e as Error).message;
                log.error(`fast2 LIVE placeTrade failed`, { err: msg, symbol: sig.symbol, side: sig.action, strategy: fast2Match.id });
              }
              handledFast2 = true;
            }
          } else {
            // ── PAPER PATH (default): existing simulation flow. ───────────
            const pos = fast2Paper.openPosition({
              signalId: sig.id,
              symbol: sig.symbol,
              side: sig.action,
              detector: sig.detector,
              entryPrice: entryPriceHint,
              atr,
              atrTpMult: fast2Match.atrTpMult,
              atrSlMult: fast2Match.atrSlMult,
              // Fast2 uses the per-strategy leverage from sCfg (overlay of
              // general fast2Config + perStrategy override). UI exposes the
              // general value (100/200/300/400/500) plus per-strategy tweaks.
              multiplier: sCfg.tradeMultiplier,
              granularity,
              candleEpoch: candle.epoch,
              baseStake: params.baseStake,
              minStake: 0.5,
              nowMs: Date.now(),
              signalStopPrice: sig.stopPrice,
              signalTargetPrice: sig.targetPrice,
              stakeOverride: stake,
              commissionPct: sCfg.commissionPct,
              entrySpreadFrac: sCfg.entrySpreadBps / 10000,
              slSlippageFrac: sCfg.slSlippageBps / 10000,
            });
            if (pos) {
              log.info(`fast2Paper opened ${pos.symbol} ${pos.side} strategy=${fast2Match.id} stake=$${pos.stake.toFixed(2)} lvl=${ladder.level} MULT=${sCfg.tradeMultiplier}× mart=${params.multiplier}× fee=$${pos.commission.toFixed(2)} entry=${pos.entryPrice.toFixed(5)} sl=${pos.stopPrice.toFixed(5)} tp=${pos.takeProfitPrice.toFixed(5)}`);
            } else {
              log.warn(`fast2Paper open rejected ${sig.symbol} ${sig.action} (atr=${atr}, balance=$${fast2Paper.getState().balance.toFixed(2)}, stake=$${stake})`);
            }
            handledFast2 = true;
          }
        }
      }
    }

    if (handledFast || handledFast2) return;

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
    const realLiveMode = realConfig.liveTradingEnabled;
    if ((realLiveMode && liveOpenSameSide) || (!realLiveMode && paperOpenSameSide)) {
      log.info("signal skipped — same-side position already open", { symbol: sig.symbol, side: sig.action, mode: realLiveMode ? "live" : "paper" });
      return;
    }

    if (!realLiveMode) {
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
        multiplier: realConfig.multiplier,
        granularity,
        candleEpoch: candle.epoch,
        baseStake: realConfig.baseStake,
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
        multiplier: realConfig.multiplier,
        stakeOverride: realConfig.baseStake,
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
        signalFiredAt: sig.ts,
      });
      log.info("placeTrade ok", { id: trade.id, contractId: trade.contractId, stake: trade.stake, strategy: match.id, latencyMs: trade.openLatencyMs, slippage: trade.entrySlippage });
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

      // Populate per-symbol decimals from Deriv's authoritative active_symbols
      // pip_size. fast3 paper-mode settle uses this to read the FULL digit
      // string from the quote (Number.toString strips trailing zeros).
      try {
        const syms = await deriv.fetchActiveSymbols();
        for (const s of syms) {
          const pipSize = s.pip_size ?? s.pip ?? 0.0001;
          const decimals = s.display_decimals ?? Math.max(0, Math.round(-Math.log10(pipSize)));
          pipDecimalsBySymbol.set(s.symbol, Math.round(decimals));
        }
        log.info(`active_symbols: ${syms.length} symbols, fast3 decimals=${FAST3_STRATEGIES.map((st) => `${st.symbols[0]}:${pipDecimalsBySymbol.get(st.symbols[0]) ?? "?"}`).join(",")}`);
      } catch (e) {
        log.warn("fetchActiveSymbols failed — fast3 paper digit extraction may misread trailing zeros", { err: (e as Error).message });
      }

      if (reconnect) {
        // DerivClient's resubscribeAll() already handled it. Don't double-subscribe.
        // Record the reconnect timestamp so the post-reconnect heal can detect
        // streams that didn't actually re-attach.
        lastReconnectMs = Date.now();
        log.info("reconnect — relying on client auto-resubscribe", { previouslySubscribed: subscribedKeys.size });
        // Reconcile open contracts: a WS disconnect window can mean Deriv
        // settled (or partly updated) a contract while the bot wasn't
        // listening. Pull a fresh snapshot for each open contract; the
        // settlement path runs inside onContractUpdate as if the update
        // had arrived live.
        const liveOpen = real.state().open.length;
        if (liveOpen > 0) {
          try {
            const res = await real.reconcileOpenContracts();
            log.info("reconnect: open-contract reconciliation complete", { liveOpen, ...res });
          } catch (e) {
            log.error("reconnect: reconciliation threw", { err: (e as Error).message });
          }
        }
      } else {
        await subscribeAll();
        isFirstConnection = false;
        // Hydrate open + closed contract history from Deriv. Local persistence
        // is wiped on Railway redeploys (ephemeral state dir), so without
        // this the Fast2 panel would show empty history after every push.
        // CRASH 300N MULTIPLIER contracts are tagged sandbox="fast2".
        try {
          const res = await real.restoreFromDeriv(100);
          if (res.openImported > 0 || res.closedImported > 0) {
            log.info("restored from Deriv", res);
            persist();
          }
        } catch (e) {
          log.warn("restoreFromDeriv failed", { err: (e as Error).message });
        }
        log.info("bot ready", { liveTrading: cfg.liveTradingEnabled, strategies: STRATEGIES.length, subs: subscribedKeys.size });
      }
    } catch (e) {
      log.error("authorize/subscribe failed", { err: (e as Error).message });
      authorized = false;
    }
  });

  // ──────── Resilience layer (heartbeat + self-heal + watchdog) ────────
  // Self-heal: every 30s, scan expectedPairs vs subscribedKeys. Two cases:
  //   1. subscribedKeys is empty (catastrophic) — full nuclear resub.
  //   2. some expected pairs missing (partial failure) — targeted subscribe
  //      for just the missing ones via subscribePair. Catches the case where
  //      initial subscribeAll succeeded for some pairs but failed for others
  //      (Deriv WS rate limit at boot, network hiccup), leaving the bot
  //      permanently blind to those streams until manual intervention.
  safeInterval("self-heal-subs", async () => {
    if (shuttingDown || !wsConnected || !authorized) return;
    if (subscribedKeys.size === 0) {
      log.warn("self-heal: subscribedKeys is empty, forcing full resubscribe");
      await deriv.forgetAll("candles").catch(() => undefined);
      await deriv.forgetAll("ticks").catch(() => undefined);
      engines.clear();
      chartBuffers.clear();
      subscribedKeys.clear();
      tickedSymbols.clear();
      await subscribeAll();
      log.info(`self-heal complete: ${subscribedKeys.size} pairs subscribed`);
      return;
    }
    const expected = expectedPairs();
    const missing: string[] = [];
    const closedSkipped: string[] = [];
    const now = Date.now();
    for (const key of expected) {
      if (subscribedKeys.has(key) && engines.has(key) && chartBuffers.has(key)) continue;
      // Pairs flagged "MarketIsClosed" within the backoff window are skipped
      // silently — Deriv closes forex/commodities on weekends, no point pinging
      // every 30 sec. They'll get re-checked when backoff expires.
      const closedAt = marketClosedPairs.get(key);
      if (closedAt != null && now - closedAt < MARKET_CLOSED_BACKOFF_MS) {
        closedSkipped.push(key);
        continue;
      }
      missing.push(key);
    }
    if (missing.length === 0) {
      if (closedSkipped.length > 0) {
        // Log occasionally so the operator knows pairs ARE waiting on market open.
        // Only emit once per 10 self-heal cycles (≈ 5 min) to avoid spam.
        if ((selfHealCount++ % 10) === 0) {
          log.info(`self-heal: ${subscribedKeys.size}/${expected.size} pairs wired; ${closedSkipped.length} waiting on market open: ${closedSkipped.join(", ")}`);
        }
      }
      return;
    }
    log.warn("self-heal: expected pairs missing from bot-side state, subscribing them now", { missing });
    for (const key of missing) {
      const [sym, grStr] = key.split("|");
      await subscribePair(sym, Number(grStr));
    }
    log.info(`self-heal targeted subscribe complete: ${subscribedKeys.size}/${expected.size} expected pairs wired`);
  }, 30_000);
  let selfHealCount = 0;

  // Heartbeat: structured ops snapshot every 60s. Updates lastHeartbeatMs which
  // /health uses to detect hangs (Railway restarts on 503).
  safeInterval("heartbeat", () => {
    lastHeartbeatMs = Date.now();
    const realState = real.state();
    const paperState = paper.getState();
    const fastState = fastPaper.getState();
    const fast2State = fast2Paper.getState();
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
    // Per-engine zone counts: `active/unmitigated` per enabled detector. Tells
    // the operator whether the seeded history actually built any OB/FVG/sweep
    // zones. If a key shows `0/0` across all detectors, the engine is starving
    // for setups and no signal can fire regardless of how many bars close.
    // If unmitigated > 0 but no signals, the bottleneck is the retest gate.
    const zonesByKey: Record<string, Record<string, string>> = {};
    for (const [key, eng] of engines) {
      const [sym] = key.split("|");
      const diag = eng.diagnose(sym as SymbolCode);
      const compact: Record<string, string> = {};
      for (const [det, info] of Object.entries(diag.detectors)) {
        if (!info.enabled) continue;
        // Stateless rule-based detectors (trendContinuation) have no zone map;
        // showing "0/0" for them is misleading because the detector IS firing
        // every bar, it just doesn't carry persistent setups.
        if (!info.hasZoneState) continue;
        const short = det === "orderBlock" ? "ob" : det === "fairValueGap" || det === "fvg" ? "fvg" : det === "liquiditySweep" ? "sw" : det;
        compact[short] = `${info.activeCount}/${info.unmitigatedCount}`;
      }
      if (Object.keys(compact).length > 0) zonesByKey[key] = compact;
    }
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
      fastPaperBalance: fastState.balance,
      fastPaperOpenTrades: fastState.open.length,
      fastPaperClosedTrades: fastState.closed.length,
      fastMartingaleLevel: Object.fromEntries(
        FAST_STRATEGIES.map((s) => [s.id, fastMartingale[s.id]?.level ?? 0]),
      ),
      fast1Config,
      fast2PaperBalance: fast2State.balance,
      fast2PaperOpenTrades: fast2State.open.length,
      fast2PaperClosedTrades: fast2State.closed.length,
      // Surface the ACTIVE mode's ladder under the original key for backwards
      // compatibility, plus break out paper/live for diagnostic clarity.
      fast2MartingaleLevel: Object.fromEntries(
        FAST2_STRATEGIES.map((s) => [s.id, fast2MartingaleFor(fast2ActiveMode())[s.id]?.level ?? 0]),
      ),
      fast2MartingaleLevelPaper: Object.fromEntries(
        FAST2_STRATEGIES.map((s) => [s.id, fast2MartingalePaper[s.id]?.level ?? 0]),
      ),
      fast2MartingaleLevelLive: Object.fromEntries(
        FAST2_STRATEGIES.map((s) => [s.id, fast2MartingaleLive[s.id]?.level ?? 0]),
      ),
      fast2ActiveMode: fast2ActiveMode(),
      fast2Config,
      consecLosses: real.getAdaptiveShift().consecLosses,
      paperConsecLosses: paperState.adaptiveShift.consecLosses,
      signalsBuffered: recentSignals.length,
      candlesByKey,
      newBarsByKey,
      zonesByKey,
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

  // ─── Fast3 stuck-contract watchdog ───
  // DIGITODD settles 1 tick after open (~3-5s). If Deriv silently drops the
  // proposal_open_contract subscription (WS keeps the main connection alive
  // but stops delivering updates for that contract), the local trade stays
  // in real.state().open forever, and the fast3 dispatcher's "open-contract
  // on this symbol" guard then dead-zones that symbol — strategy "dies".
  // Every 20s, scan for fast3 trades older than 30s and reconcile them
  // against Deriv (one-shot proposal_open_contract). reconcileOpenContracts
  // settles finalised contracts and re-subscribes still-live ones.
  safeInterval("fast3-stuck-watchdog", async () => {
    const STUCK_THRESHOLD_MS = 30_000;
    const now = Date.now();
    const stuck = real.state().open.filter(
      (t) => t.sandbox === "fast3" && now - t.openedAt > STUCK_THRESHOLD_MS,
    );
    if (stuck.length === 0) return;
    log.warn(`fast3-stuck-watchdog: ${stuck.length} fast3 contracts open >${STUCK_THRESHOLD_MS / 1000}s — reconciling`, {
      contracts: stuck.map((t) => ({ id: t.contractId, sym: t.symbol, ageSec: Math.floor((now - t.openedAt) / 1000) })),
    });
    try {
      const res = await real.reconcileOpenContracts();
      log.info("fast3-stuck-watchdog: reconcile complete", res);
    } catch (e) {
      log.error("fast3-stuck-watchdog: reconcile threw", { err: (e as Error).message });
    }
  }, 20_000);

  // ──────── Production risk circuit breakers ────────
  // Latency circuit: if the rolling-average open latency exceeds the threshold,
  // auto-pause the bot. The 800ms default was too aggressive — Railway → Deriv
  // round-trips on multiplier_buy commonly land 700–1100ms even from EU West,
  // which would trip on every single trade. Defaults raised to a 2500ms ceiling
  // and 5-sample minimum so a one-off slow buy doesn't blow the circuit.
  // Auto-resumes when avg drops back below threshold/2 — manual-only recovery
  // was the wrong default; the user shouldn't have to babysit every spike.
  // All thresholds are env-configurable (LATENCY_CIRCUIT_MS, LATENCY_MIN_SAMPLES,
  // LATENCY_AUTO_RESUME=0 to disable auto-resume).
  const LATENCY_CIRCUIT_MS = Number(process.env.LATENCY_CIRCUIT_MS ?? 2500);
  const LATENCY_MIN_SAMPLES = Number(process.env.LATENCY_MIN_SAMPLES ?? 5);
  const LATENCY_AUTO_RESUME = (process.env.LATENCY_AUTO_RESUME ?? "1") === "1";
  let latencyPaused = false;
  safeInterval("latency-circuit", () => {
    const avg = real.averageOpenLatencyMs();
    const samples = real.recentOpenLatencySampleCount();
    if (avg == null || samples < LATENCY_MIN_SAMPLES) return; // not enough data yet
    if (avg > LATENCY_CIRCUIT_MS && !latencyPaused) {
      log.error(`LATENCY CIRCUIT: avg open latency ${avg.toFixed(0)}ms > ${LATENCY_CIRCUIT_MS}ms threshold (n=${samples}) — auto-pausing`);
      manualPaused = true;
      latencyPaused = true;
    } else if (avg <= LATENCY_CIRCUIT_MS / 2 && latencyPaused) {
      if (LATENCY_AUTO_RESUME) {
        log.warn(`latency recovered to ${avg.toFixed(0)}ms (n=${samples}, well below ${LATENCY_CIRCUIT_MS}ms) — auto-resuming`);
        // Only flip OFF the latency-induced pause; if the operator manually
        // paused for some other reason, leave it paused.
        manualPaused = false;
        latencyPaused = false;
      } else {
        log.warn(`latency recovered to ${avg.toFixed(0)}ms (well below ${LATENCY_CIRCUIT_MS}ms). Manual resume required (LATENCY_AUTO_RESUME=0).`);
      }
    }
  }, 60_000);

  // Fast2 session-drawdown circuit: track session-peak and pause Fast2 (only)
  // if the balance falls below `1 - DD_FRAC` of the peak. Default 30% — at
  // $50 starting balance with 2.0× martingale a 30% session-DD typically
  // means a deep ladder bust we should stop and review.
  const FAST2_DD_FRAC = Number(process.env.FAST2_SESSION_DD_FRAC ?? 0.30);
  // fast2SessionPeak / fast2DDPaused are hoisted alongside fast2Paper init so
  // resetFast2Paper can clear them (see comment near declaration).
  safeInterval("fast2-session-dd", () => {
    const bal = fast2Paper.getState().balance;
    if (bal > fast2SessionPeak) fast2SessionPeak = bal;
    if (fast2SessionPeak <= 0) return;
    const ddFrac = 1 - bal / fast2SessionPeak;
    if (ddFrac > FAST2_DD_FRAC && !fast2DDPaused) {
      log.error(`FAST2 SESSION-DD CIRCUIT: balance $${bal.toFixed(2)} is ${(ddFrac * 100).toFixed(1)}% below session peak $${fast2SessionPeak.toFixed(2)} (threshold ${(FAST2_DD_FRAC * 100).toFixed(0)}%) — pausing fast2 trades`);
      fast2DDPaused = true;
      // Force fast2 sideFilter to a side that BOTH excludes (a poor man's
      // disable). Operator must reset sideFilter and DD-paused flag from UI.
      // Note: this only pauses Fast2 — Fast/Real keep running.
    }
    if (fast2DDPaused) {
      // Persistent log nudge so the operator notices.
      log.warn(`fast2 session-DD circuit active: bal=$${bal.toFixed(2)} peak=$${fast2SessionPeak.toFixed(2)} dd=${(ddFrac * 100).toFixed(1)}%. Reset balance or peak via UI to resume.`);
    }
  }, 60_000);
  // Expose the DD circuit flag to executeSignal via closure; gate fast2 opens
  // when active. This requires plumbing a shared boolean — done via the
  // `fast2DDPaused` reference captured by the `if (fast2Match)` branch
  // (added below in the next commit step).
  const isFast2DDPaused = () => fast2DDPaused;

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
  // EXPECTED (sym,gr) pair (not just `subscribedKeys`) and force a fresh
  // subscribePair for any that haven't received a candle since the reconnect.
  // Scanning `expectedPairs()` instead of `subscribedKeys` is critical — pairs
  // that initial subscribeAll never wired up are still expected; they need
  // post-reconnect rescue too. subscribePair re-seeds engine + chartBuffer, so
  // candles flowing after the heal will properly trigger isNewBar + detector.
  let lastReconnectMs = 0;
  safeInterval("post-reconnect-heal", async () => {
    if (shuttingDown || !wsConnected || !authorized) return;
    if (lastReconnectMs === 0) return; // first connection — subscribeAll handled it
    const elapsed = Date.now() - lastReconnectMs;
    if (elapsed < 30_000 || elapsed > 120_000) return; // act in the 30-120s window after reconnect, then once
    const stalePairs: Array<{ sym: string; gr: number }> = [];
    for (const key of expectedPairs()) {
      const lastMs = lastCandleAtByKey.get(key) ?? 0;
      const wired = subscribedKeys.has(key) && engines.has(key) && chartBuffers.has(key);
      // Stale if no candle since reconnect, OR pair is unwired (engine missing).
      if (lastMs < lastReconnectMs || !wired) {
        const [sym, grStr] = key.split("|");
        stalePairs.push({ sym, gr: Number(grStr) });
      }
    }
    if (stalePairs.length === 0) return;
    log.warn("post-reconnect-heal: pairs silent or unwired, forcing fresh subscribe", { stalePairs });
    for (const { sym, gr } of stalePairs) {
      await subscribePair(sym, gr);
    }
    log.info(`post-reconnect-heal complete: ${subscribedKeys.size} pairs subscribed`);
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

  // ── Fast3: tick-level DIGITODD dispatch ──────────────────────────────────
  // For each Fast3 symbol, on every tick:
  //   1. Settle any pending bet from the previous tick (resolution = current digit).
  //   2. Place a new DIGITODD bet for the next tick (per-strategy ladder stake).
  // The "next-tick" model: we bet at tick T on whether tick T+1 will be ODD.
  // The pending map holds the in-flight bet until the next tick arrives.
  // Read the last decimal digit of `price` at the symbol's pip precision.
  // Uses Deriv's per-symbol display_decimals so trailing zeros are NOT
  // dropped — Number.toString(213.4570) returns "213.457", which would
  // mis-report digit 7 instead of digit 0. Falls back to a 4dp default if
  // the symbol isn't in pipDecimalsBySymbol yet (e.g. active_symbols not
  // loaded), which is enough for 1HZ*V / R_*  / RDB*** / JD*.
  const fast3LastDigitFor = (price: number, symbol: string): number => {
    const decimals = pipDecimalsBySymbol.get(symbol) ?? 4;
    const s = price.toFixed(decimals);
    return Number(s.slice(-1));
  };
  deriv.on("tick", (tick) => {
    // Find all Fast3 strategies for this symbol
    const stratsForSym = FAST3_STRATEGIES.filter((s) => s.symbols.includes(tick.symbol));
    if (stratsForSym.length === 0) return;

    // ── Settle any pending bet on this symbol ──
    const pending = fast3Pending.get(tick.symbol);
    if (pending && pending.entryEpoch < tick.epoch) {
      fast3Pending.delete(tick.symbol);
      const isOdd = fast3LastDigitFor(tick.quote, tick.symbol) % 2 !== 0;
      const cfg = fast3ConfigFor(pending.strategyId);
      // Each strategy carries its own digitContractType (default DIGITODD).
      // EVEN-side strategies win when the next digit is even; ODD-side win
      // when odd. Payout ratio is the same family-wide.
      const stratForPending = FAST3_STRATEGIES.find((s) => s.id === pending.strategyId);
      const wantOdd = (stratForPending?.digitContractType ?? "DIGITODD") === "DIGITODD";
      const wins = wantOdd ? isOdd : !isOdd;
      // DIGITODD/EVEN payout: 1.95× win (1.92× on R_100). Net profit = stake * 0.95.
      const payoutRatio = tick.symbol === "R_100" ? 1.92 : 1.95;
      const netPnl = wins ? Number((pending.stake * (payoutRatio - 1)).toFixed(2)) : -pending.stake;
      const ladderMap = pending.mode === "live" ? fast3MartingaleLive : fast3MartingalePaper;
      const ladder = ladderMap[pending.strategyId] ?? emptyMartingaleState();
      const params: MartingaleParams = {
        baseStake: cfg.baseStake,
        multiplier: cfg.martingaleMultiplier,
        maxLevels: cfg.maxLevels,
        perTradeCap: cfg.perTradeCap,
      };
      const { state: nextLadder } = fastMartingaleUpdate(ladder, netPnl, params, Date.now(), cfg.martingaleMode);
      ladderMap[pending.strategyId] = nextLadder;

      // Loss-streak pause (paper-mode tally; live-mode tally is handled in
      // real.on("settled")). Mirrors the live-side logic so paper and live
      // behave identically under the same streak.
      if (pending.mode === "paper") {
        if (netPnl <= 0) {
          const streak = (fast3ConsecutiveLosses.get(pending.strategyId) ?? 0) + 1;
          fast3ConsecutiveLosses.set(pending.strategyId, streak);
          if (streak >= FAST3_STREAK_PAUSE_AFTER_LOSSES) {
            fast3StreakPauseUntil.set(pending.strategyId, Date.now() + FAST3_STREAK_PAUSE_MS);
            fast3ConsecutiveLosses.set(pending.strategyId, 0);
            log.debug(`fast3Paper streak pause [${pending.strategyId}] — ${streak} losses → ${FAST3_STREAK_PAUSE_MS}ms cooldown`);
          }
        } else {
          fast3ConsecutiveLosses.set(pending.strategyId, 0);
        }
      }

      if (pending.mode === "paper") {
        // Apply pnl to fast3 paper balance directly (no SL/TP geometry).
        const ps = fast3Paper.getState();
        const newBal = Number((ps.balance + netPnl).toFixed(2));
        fast3Paper.applyDelta(netPnl, {
          symbol: tick.symbol,
          side: "BUY",  // arbitrary tag — DIGITODD is a digit prediction, not directional
          detector: FAST3_DETECTOR_TAG,
          strategyId: pending.strategyId,
          stake: pending.stake,
          result: netPnl > 0 ? "won" : "lost",
          pnl: netPnl,
          openedAt: pending.entryEpoch * 1000,
          closedAt: tick.epoch * 1000,
          entryPrice: 0,
          exitPrice: tick.quote,
        });
        log.debug(`fast3Paper settled ${tick.symbol} ${netPnl > 0 ? "WIN" : "LOSS"} pnl=$${netPnl.toFixed(2)} bal=$${newBal.toFixed(2)} W=${nextLadder.wins} L=${nextLadder.losses} lvl=${nextLadder.level}`);
      }
      // (live settlement is handled via real.on("settled") elsewhere)
    }

    // ── Place a new bet for the next tick ──
    if (fast3Pending.has(tick.symbol)) return; // still busy waiting on settle from last tick
    for (const strat of stratsForSym) {
      const cfg = fast3ConfigFor(strat.id);
      const enabled = (fast3Config.perStrategy?.[strat.id]?.enabled ?? true) !== false;
      if (!enabled) continue;
      // Loss-streak cooldown: skip this strategy while its pause window is
      // active. Set when consecutive losses ≥ FAST3_STREAK_PAUSE_AFTER_LOSSES
      // in the settle handlers above.
      const pauseUntil = fast3StreakPauseUntil.get(strat.id) ?? 0;
      if (Date.now() < pauseUntil) continue;
      const mode = fast3ActiveMode();
      const ladderMap = mode === "live" ? fast3MartingaleLive : fast3MartingalePaper;
      const ladder = ladderMap[strat.id] ?? emptyMartingaleState();
      const stake = Number((cfg.baseStake * Math.pow(cfg.martingaleMultiplier, ladder.level)).toFixed(2));
      // Affordability + stake cap
      const cappedStake = Math.min(stake, cfg.perTradeCap);
      const ps = fast3Paper.getState();
      if (mode === "paper" && ps.balance < cappedStake) {
        // Reset ladder, can't afford this level
        if (ladder.level > 0) ladderMap[strat.id] = emptyMartingaleState();
        continue;
      }
      // Stake-cap hit → reset to L0 base stake
      const finalStake = stake > cfg.perTradeCap ? cfg.baseStake : stake;
      if (mode === "live") {
        // No client-side throttling — Deriv enforces server-side rate limits
        // and surfaces "RateLimit" errors when the bucket is exceeded; we
        // log+drop and the next tick retries.
        if (fast3LiveInFlight.has(tick.symbol)) continue;
        if (real.state().open.some((t) => t.sandbox === "fast3" && t.symbol === tick.symbol)) continue;

        fast3LiveInFlight.add(tick.symbol);
        const liveContractType = strat.digitContractType ?? "DIGITODD";
        real.placeTrade({
          symbol: tick.symbol as SymbolCode,
          side: "BUY",
          family: "DIGIT",
          digitContractType: liveContractType,
          detector: FAST3_DETECTOR_TAG,
          stakeOverride: finalStake,
          signalFiredAt: Date.now(),
          sandbox: "fast3",
          sandboxStrategyId: strat.id,
          entryPriceHint: tick.quote,
        }).then((trade) => {
          log.info(`fast3 LIVE opened ${liveContractType} ${tick.symbol} stake=$${trade.stake.toFixed(2)} contract=${trade.contractId} strategy=${strat.id} lvl=${ladder.level}`);
        }).catch((e) => {
          const msg = (e as Error).message;
          if (msg.includes("RateLimit") || msg.includes("rate limit")) {
            log.debug(`fast3 LIVE rate-limited by Deriv on ${tick.symbol} — next tick will retry`);
          } else {
            log.warn(`fast3 LIVE placeTrade failed ${tick.symbol}: ${msg}`);
          }
        }).finally(() => {
          fast3LiveInFlight.delete(tick.symbol);
        });
        break;
      }
      fast3Pending.set(tick.symbol, {
        entryEpoch: tick.epoch,
        stake: finalStake,
        strategyId: strat.id,
        mode,
      });
      // Only one strategy fires per symbol per tick (first match wins);
      // multiple Fast3 strategies on same symbol would collide on the
      // pending slot anyway.
      break;
    }
  });

  // ── Fast2 DIGITOVER 0 tick-level dispatcher (added 2026-05-04) ──
  // Mirrors the fast3 handler but routes to Fast2 paper/live state and
  // uses DIGITOVER barrier=0 contract type. Per-symbol in-flight + open-
  // contract guard only; Deriv enforces rate limits server-side.
  type Fast2TickPending = { entryEpoch: number; stake: number; strategyId: string; mode: "paper" | "live" };
  const fast2TickPending = new Map<string, Fast2TickPending>();
  const fast2LiveInFlight = new Set<string>();
  deriv.on("tick", (tick) => {
    const stratsForSym = FAST2_STRATEGIES.filter((s) => s.granularity === 0 && s.symbols.includes(tick.symbol));
    if (stratsForSym.length === 0) return;
    const now = Date.now();

    // Settle any pending bet on this symbol (paper-mode only; live settles
    // come via real.on("settled")).
    const pending = fast2TickPending.get(tick.symbol);
    if (pending && pending.entryEpoch < tick.epoch) {
      fast2TickPending.delete(tick.symbol);
      // Same trailing-zero issue as fast3: read the digit at pip precision
      // so a quote like "213.4570" doesn't get its trailing 0 dropped.
      const settleDigit = fast3LastDigitFor(tick.quote, tick.symbol);
      const isWin = settleDigit > 0;  // DIGITOVER 0 → win when digit > 0
      const cfg = fast2ConfigFor(pending.strategyId);
      const payout = 1.09;            // DIGITOVER 0 broker price
      const netPnl = isWin ? Number((pending.stake * (payout - 1)).toFixed(2)) : -pending.stake;
      const ladderMap = pending.mode === "live" ? fast2MartingaleLive : fast2MartingalePaper;
      const ladder = ladderMap[pending.strategyId] ?? emptyMartingaleState();
      const params: MartingaleParams = {
        baseStake: cfg.baseStake,
        multiplier: cfg.martingaleMultiplier,
        maxLevels: cfg.maxLevels,
        perTradeCap: cfg.perTradeCap,
      };
      const { state: nextLadder } = fastMartingaleUpdate(ladder, netPnl, params, Date.now(), cfg.martingaleMode);
      ladderMap[pending.strategyId] = nextLadder;
      if (pending.mode === "paper") {
        fast2Paper.applyDelta(netPnl, {
          symbol: tick.symbol,
          side: "BUY",
          detector: FAST2_DIGITOVER0_DETECTOR_TAG,
          strategyId: pending.strategyId,
          stake: pending.stake,
          result: netPnl > 0 ? "won" : "lost",
          pnl: netPnl,
          openedAt: pending.entryEpoch * 1000,
          closedAt: tick.epoch * 1000,
          entryPrice: 0,
          exitPrice: tick.quote,
        });
      }
    }

    if (fast2TickPending.has(tick.symbol)) return;
    for (const strat of stratsForSym) {
      const cfg = fast2ConfigFor(strat.id);
      const enabled = (fast2Config.perStrategy?.[strat.id]?.enabled ?? true) !== false;
      if (!enabled) continue;
      const mode = fast2ActiveMode();
      const ladderMap = mode === "live" ? fast2MartingaleLive : fast2MartingalePaper;
      const ladder = ladderMap[strat.id] ?? emptyMartingaleState();
      const stake = Number((cfg.baseStake * Math.pow(cfg.martingaleMultiplier, ladder.level)).toFixed(2));
      const finalStake = stake > cfg.perTradeCap ? cfg.baseStake : stake;
      const ps = fast2Paper.getState();
      if (mode === "paper" && ps.balance < finalStake) {
        if (ladder.level > 0) ladderMap[strat.id] = emptyMartingaleState();
        continue;
      }
      if (mode === "live") {
        if (fast2LiveInFlight.has(tick.symbol)) continue;
        if (real.state().open.some((t) => t.sandbox === "fast2" && t.symbol === tick.symbol)) continue;
        fast2LiveInFlight.add(tick.symbol);
        real.placeTrade({
          symbol: tick.symbol as SymbolCode,
          side: "BUY",
          family: "DIGIT",
          digitContractType: "DIGITOVER",
          digitBarrier: 0,
          detector: FAST2_DIGITOVER0_DETECTOR_TAG,
          stakeOverride: finalStake,
          signalFiredAt: now,
          sandbox: "fast2",
          sandboxStrategyId: strat.id,
          entryPriceHint: tick.quote,
        }).then((trade) => {
          log.info(`fast2 LIVE opened DIGITOVER 0 ${tick.symbol} stake=$${trade.stake.toFixed(2)} contract=${trade.contractId} strategy=${strat.id} lvl=${ladder.level}`);
        }).catch((e) => {
          const msg = (e as Error).message;
          if (msg.includes("RateLimit") || msg.includes("rate limit")) {
            log.debug(`fast2 LIVE rate-limited by Deriv on ${tick.symbol} — next tick will retry`);
          } else {
            log.warn(`fast2 LIVE placeTrade failed ${tick.symbol}: ${msg}`);
          }
        }).finally(() => {
          fast2LiveInFlight.delete(tick.symbol);
        });
        break;
      }
      fast2TickPending.set(tick.symbol, { entryEpoch: tick.epoch, stake: finalStake, strategyId: strat.id, mode });
      break;
    }
  });

  deriv.on("balance", (b) => {
    if (account) {
      const prev = account.balance;
      account = { ...account, balance: b.balance ?? account.balance, currency: b.currency ?? account.currency };
      // Plumb the fresh balance through to the real engine — otherwise its
      // cached this.account.balance stays stuck at auth-time, silently
      // diverging from reality whenever a contract settles externally
      // (other Deriv app, prior bot session, manual trade, etc.).
      real.setAccount(account);
      const delta = (b.balance ?? prev) - prev;
      // Promote balance pushes to INFO so operators can actually see the
      // account move in production logs. They were debug-only before, which
      // made it impossible to tell whether the subscription was alive.
      if (Math.abs(delta) >= 0.01) {
        log.info("balance updated", { balance: b.balance, currency: b.currency, delta: Number(delta.toFixed(2)) });
      } else {
        log.debug("balance heartbeat", { balance: b.balance, currency: b.currency });
      }
    }
  });

  // Polling fallback: even when the WS balance subscription is alive, Deriv
  // can drop pushes silently after long-lived connections, network blips, or
  // server-side prunes. Every 60s we send a non-subscribe `balance:1` to
  // re-sync against the truth on Deriv's side. The handler above will fire
  // on the response just like a push event.
  safeInterval("balance-refresh", () => {
    if (!authorized) return;
    deriv.send({ balance: 1 }).catch((e) => log.warn("balance poll failed", { err: (e as Error).message }));
  }, 60_000);

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

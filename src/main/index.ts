import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import { DerivClient } from "./deriv/client";
import { BinanceClient } from "./binance/client";
import { BinanceEngine } from "./engine/binance";
import { BINANCE_ASSETS } from "@shared/binance-assets";
import { Engine } from "./engine/runner";
import { PaperEngine } from "./engine/paper";
import { RealEngine } from "./engine/real";
import { STRATEGIES } from "./engine/strategies";
import { runBacktest } from "./engine/backtest";
import type { AiSignaler } from "./engine/backtest";
import { clearAdvisorCooldown, getLastAdvice, inferAdvice, maybeAdvise } from "./engine/deepseek";
import { randomUUID } from "node:crypto";
import {
  getAdaptiveShiftState,
  getDeepseekKey,
  getDerivToken,
  getPaperState,
  getRealState,
  getSettings,
  getBinanceKey,
  getBinanceSecret,
  hasBinanceCreds,
  hasDeepseekKey,
  hasToken,
  getBinanceTestnet,
  getBinanceState,
  getBinanceEnabled,
  setAdaptiveShiftState,
  setBinanceCreds,
  setBinanceTestnet,
  setBinanceState,
  setBinanceEnabled,
  setDeepseekKey,
  setDerivToken,
  setPaperState,
  setRealState,
  setSettings,
} from "./storage/store";
import { CH } from "./ipc/channels";
import type {
  AccountInfo,
  BacktestRequest,
  Candle,
  MainEvent,
  OrderBlock,
  RealModeGate,
  RealTradeSide,
  Settings,
  Signal,
  SymbolCode,
  SymbolMeta,
  WatcherStatus,
} from "@shared/types";

let mainWindow: BrowserWindow | null = null;
const deriv = new DerivClient();
let engine = new Engine(getSettings().detectors, getSettings().strategy);
const paper = new PaperEngine();
paper.load(getPaperState());
const real = new RealEngine(deriv);
real.load(getRealState());
real.loadAdaptiveShift(getAdaptiveShiftState());
real.setCaps(getSettings().risk.perTradeMaxStake, getSettings().risk.dailyMaxLoss);
real.on("adaptiveShiftChanged", (state) => {
  setAdaptiveShiftState(state);
  console.log(`[adaptive-shift] state: ${real.describeAdaptiveShift()}`);
});

// Binance Futures crypto engine — runs alongside Deriv. Starts only when:
//   - Creds present, AND user explicitly enabled it via UI (binanceEnabled flag).
const binanceClient = new BinanceClient();
const binanceEngine = new BinanceEngine(binanceClient);
binanceEngine.load(getBinanceState());
binanceEngine.configure({ assets: [...BINANCE_ASSETS], stake: 15, leverage: 30, dailyMaxLoss: 100, perTradeMaxStake: 30 });
binanceEngine.on("stateChanged", () => {
  setBinanceState(binanceEngine.state());
});
binanceEngine.on("error", (err) => console.error("[binance]", err.message));
binanceEngine.on("opened", (t) => console.log(`[binance] opened ${t.asset} ${t.pattern} ${t.side} @ ${t.entryPrice}`));
binanceEngine.on("closed", (t) => console.log(`[binance] closed ${t.asset} ${t.pattern} ${t.side} pnl=${t.pnl?.toFixed(2)}`));

function configureBinanceClient() {
  const apiKey = getBinanceKey();
  const apiSecret = getBinanceSecret();
  binanceClient.configure(apiKey && apiSecret ? { apiKey, apiSecret } : null, { testnet: getBinanceTestnet() });
}
configureBinanceClient();

/**
 * Multi-symbol bot subscriptions.
 *
 * The UI watcher tracks ONE active symbol for charting. When real mode is on
 * with auto-trade-on-signal, the bot ALSO needs candles flowing for every
 * registered strategy's (symbol, granularity) so signals can fire concurrently.
 *
 * `botSubs` is the set of (symbol|gr) pairs the bot has subscribed to ON TOP of
 * the UI watcher. When real mode disables, we forget these to save bandwidth.
 */
const botSubs = new Set<string>();
const botSubKey = (symbol: SymbolCode, gr: number) => `${symbol}|${gr}`;
let botSubscribed = false;

let activeSymbol: SymbolCode = getSettings().activeSymbol;
let watching = false;
let activeBlocks = new Map<string, OrderBlock>();
let watcherTransition: Promise<void> | null = null;
let realModeEnabled = false;
let account: AccountInfo | null = null;
let lastTickPriceBySymbol = new Map<SymbolCode, number>();
let symbolMetaCache = new Map<SymbolCode, SymbolMeta>();

function status(): WatcherStatus {
  return {
    wsConnected: deriv.isOpen(),
    activeSymbol,
    watching,
    tokenConfigured: hasToken(),
    realModeEnabled,
    account,
  };
}

function evaluateRealGate(): RealModeGate {
  const reasons: string[] = [];
  const s = getSettings();
  if (!hasToken()) reasons.push("Add a Deriv API token in Settings");
  if (!deriv.isOpen()) reasons.push("Deriv WebSocket not connected");
  if (!account) reasons.push("Account not authorized yet");
  if (s.risk.perTradeMaxStake <= 0) reasons.push("Set a per-trade max stake > 0");
  if (s.risk.dailyMaxLoss <= 0) reasons.push("Set a daily max loss > 0");
  if (!s.risk.realModeConfirmed) reasons.push("Flip the 'I understand this uses real money' switch");
  return { canEnable: reasons.length === 0, reasons };
}

function broadcastReal() {
  const state = real.state();
  setRealState({ open: state.open, closed: state.closed, daily: state.daily });
  broadcast({ type: "real", state });
}

async function enableRealMode(): Promise<{ ok: boolean; reasons?: string[]; error?: string }> {
  const gate = evaluateRealGate();
  if (!gate.canEnable) {
    // If the only missing piece is authorize and we have a token, try now.
    const hasTokenOnly =
      gate.reasons.length === 1 && gate.reasons[0] === "Account not authorized yet";
    if (!hasTokenOnly) return { ok: false, reasons: gate.reasons };
  }

  try {
    const token = getDerivToken();
    if (!token) return { ok: false, reasons: ["No token"] };
    const info = await deriv.authorize(token);
    account = {
      loginid: info.loginid ?? "",
      currency: info.currency ?? "USD",
      balance: info.balance ?? 0,
      isVirtual: info.is_virtual === 1,
      fullname: info.fullname,
      email: info.email,
    };
    real.setAccount(account);
    await deriv.subscribeBalance().catch(() => undefined);

    const s = getSettings();
    real.setCaps(s.risk.perTradeMaxStake, s.risk.dailyMaxLoss);

    realModeEnabled = true;
    // Subscribe candles for every registered strategy's (symbol, granularity) so signals fire across all assets.
    startBotSubscriptions().catch((e) => console.error("[bot-subs]", e));
    broadcastStatus();
    broadcastReal();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function disableRealMode(reason?: string) {
  realModeEnabled = false;
  stopBotSubscriptions().catch(() => undefined);
  broadcastStatus();
  if (reason) broadcast({ type: "realError", message: reason });
}

function priceFor(symbol: SymbolCode): number | null {
  return lastTickPriceBySymbol.get(symbol) ?? null;
}

function broadcast(ev: MainEvent) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(CH.event, ev);
}

function broadcastStatus() {
  broadcast({ type: "status", status: status() });
}

function broadcastPaper() {
  const state = paper.state();
  setPaperState(state.open, state.closed);
  broadcast({ type: "paper", state });
}

async function startWatcher(symbol: SymbolCode) {
  // Coalesce concurrent calls (React StrictMode double-invokes effects in dev).
  if (watcherTransition) {
    await watcherTransition;
    if (watching && symbol === activeSymbol) return;
  }
  if (watching && symbol === activeSymbol) return;

  watcherTransition = (async () => {
    if (watching) {
      await deriv.forgetAll("candles").catch(() => undefined);
      await deriv.forgetAll("ticks").catch(() => undefined);
      activeBlocks.clear();
      watching = false;
    }

    activeSymbol = symbol;
    setSettings({ activeSymbol: symbol });

    const granularity = getSettings().granularity;
    const history = await deriv.subscribeCandles(symbol, granularity, 1000);
    engine.seed(symbol, history);
    await deriv.subscribeTicks(symbol);
    watching = true;
    broadcastStatus();
    const r = engine.regimeFor(symbol);
    if (r) broadcast({ type: "regime", regime: r });
  })();
  try {
    await watcherTransition;
  } finally {
    watcherTransition = null;
  }
}

async function stopWatcher() {
  if (!watching) return;
  await deriv.forgetAll("candles").catch(() => undefined);
  await deriv.forgetAll("ticks").catch(() => undefined);
  watching = false;
  activeBlocks.clear();
  broadcastStatus();
  // Bot subs are cleared because forgetAll wipes everything — re-subscribe if real mode still on.
  botSubs.clear();
  botSubscribed = false;
  if (realModeEnabled) startBotSubscriptions().catch((e) => console.error("[bot-subs]", e));
}

/**
 * Subscribe to candles + ticks for every distinct (symbol, granularity) used by
 * a registered strategy. Idempotent — safe to call multiple times. The UI's
 * activeSymbol stream is preserved (already covered by startWatcher).
 */
async function startBotSubscriptions() {
  if (botSubscribed) return;
  const pairs = new Set<string>();
  for (const s of STRATEGIES) {
    for (const sym of s.symbols) pairs.add(botSubKey(sym as SymbolCode, s.granularity));
  }
  for (const key of pairs) {
    if (botSubs.has(key)) continue;
    const [sym, grStr] = key.split("|");
    const gr = Number(grStr);
    try {
      const history = await deriv.subscribeCandles(sym as SymbolCode, gr as any, 1000);
      engine.seed(sym as SymbolCode, history);
      await deriv.subscribeTicks(sym as SymbolCode);
      botSubs.add(key);
      console.log(`[bot-subs] subscribed ${sym} @ ${gr}s (${history.length} bars seeded)`);
    } catch (e) {
      console.error(`[bot-subs] failed ${sym} @ ${gr}s:`, e);
    }
  }
  botSubscribed = true;
}

async function stopBotSubscriptions() {
  // Deriv API doesn't easily forget individual streams without affecting others.
  // Conservative: leave streams open until next startWatcher cycle clears them.
  botSubscribed = false;
}

/**
 * Run paper + (optionally) real fills for a single signal. Returns true if
 * paper state changed (caller should broadcast).
 */
function executeSignal(sig: Signal, candle: Candle): boolean {
  const settings = getSettings();
  const autoTrade = realModeEnabled && settings.realTrading.autoTradeOnSignal;
  const rt = settings.realTrading;

  const res = paper.onSignal(sig, candle.close);
  const dirty = !!(res.opened || res.closed);

  if (autoTrade) {
    const gate = real.canOpen();
    if (!gate.ok) {
      broadcast({ type: "realError", message: `Skipped auto-trade: ${gate.reason}` });
    } else {
      real
        .placeTrade({
          symbol: sig.symbol,
          side: sig.action,
          family: rt.contractFamily,
          durationTicks: rt.durationTicks,
          multiplier: rt.multiplier,
          tpSlMode: rt.tpSlMode,
          takeProfitPct: rt.takeProfitPct,
          stopLossPct: rt.stopLossPct,
          atrTpMult: rt.atrTpMult,
          atrSlMult: rt.atrSlMult,
          atr: engine.atrFor(sig.symbol),
          entryPriceHint: engine.lastCloseFor(sig.symbol) ?? undefined,
          detector: sig.detector,
        })
        .catch((e) => broadcast({ type: "realError", message: `Auto-trade failed: ${(e as Error).message}` }));
    }
  }
  return dirty;
}

function wireDeriv() {
  deriv.on("open", () => {
    broadcastStatus();
    const token = getDerivToken();
    if (token) deriv.setToken(token);
    // Fetch symbol metadata so charts can use Deriv's authoritative pip_size.
    deriv.fetchActiveSymbols()
      .then((syms) => {
        for (const s of syms) {
          const pipSize = s.pip_size ?? s.pip ?? 0.0001;
          const decimals = s.display_decimals ?? Math.max(0, -Math.log10(pipSize));
          symbolMetaCache.set(s.symbol, {
            code: s.symbol,
            displayName: s.display_name,
            market: s.market,
            submarket: s.submarket,
            pipSize,
            displayDecimals: Math.round(decimals),
            exchangeOpen: s.exchange_is_open === 1,
          });
        }
      })
      .catch((e) => console.error("[active_symbols]", e));
    // Auto-start watching the persisted active symbol once WS is up.
    if (!watching) startWatcher(activeSymbol).catch((e) => console.error("[auto-start]", e));
  });
  deriv.on("close", () => {
    // If the connection drops while in real mode, fail safe.
    if (realModeEnabled) disableRealMode("WebSocket disconnected — real mode turned off");
    broadcastStatus();
  });
  deriv.on("error", (err) => {
    console.error("[deriv]", err);
    const msg = err.message ?? String(err);
    if (/author|token/i.test(msg)) {
      broadcast({ type: "realError", message: `Deriv auth: ${msg}` });
    }
  });

  deriv.on("balance", (b) => {
    if (account) {
      account = { ...account, balance: b.balance, currency: b.currency, loginid: b.loginid ?? account.loginid };
      broadcastStatus();
    }
  });

  deriv.on("authorized", (info) => {
    account = {
      loginid: info.loginid ?? "",
      currency: info.currency ?? "USD",
      balance: info.balance ?? 0,
      isVirtual: info.is_virtual === 1,
      fullname: info.fullname,
      email: info.email,
    };
    real.setAccount(account);
    broadcastStatus();
  });

  deriv.on("tick", (tick) => {
    lastTickPriceBySymbol.set(tick.symbol, tick.quote);
    broadcast({ type: "tick", tick });
    const closed = paper.onTick(tick);
    if (closed.length > 0) broadcastPaper();
  });

  real.on("opened", (trade) => broadcast({ type: "realTradeOpened", trade }));
  real.on("settled", (trade) => broadcast({ type: "realTradeSettled", trade }));
  real.on("stateChanged", () => broadcastReal());
  real.on("capHit", (loss, cap) => {
    broadcast({ type: "realCapHit", dailyLoss: loss, cap });
    disableRealMode(`Daily loss cap hit (${loss.toFixed(2)} / ${cap.toFixed(2)}). Real mode paused.`);
  });
  real.on("error", (err) => {
    console.error("[real]", err);
    broadcast({ type: "realError", message: err.message });
  });

  deriv.on("candle", (symbol, candle, isNew) => {
    broadcast({ type: "candle", symbol, candle, isNew });
    // Process candles for any symbol the engine has seeded (UI watcher OR bot subscription).
    const isUiSymbol = symbol === activeSymbol;
    const isBotSymbol = STRATEGIES.some((s) => s.symbols.includes(symbol));
    if (!isUiSymbol && !isBotSymbol) return;

    const {
      signals, orderBlocks, mitigatedBlockIds, structureMarks,
      liquidityPools, liquidityPoolsSwept, liquidityPoolsRemoved,
      diagnostics, regime,
    } = engine.onCandle(symbol, candle, isNew);

    // Only broadcast UI events for the active (charted) symbol — avoids flooding the renderer.
    if (isUiSymbol) {
      if (isNew && regime) broadcast({ type: "regime", regime });
      for (const mark of structureMarks) broadcast({ type: "structureMark", mark });
      for (const pool of liquidityPools) broadcast({ type: "liquidityPool", pool });
      for (const s of liquidityPoolsSwept) broadcast({ type: "liquidityPoolSwept", id: s.id, sweptEpoch: s.sweptEpoch });
      for (const id of liquidityPoolsRemoved) broadcast({ type: "liquidityPoolRemoved", id });
      for (const d of diagnostics) broadcast({ type: "detectorDiagnostics", diagnostics: d });
      for (const b of orderBlocks) {
        activeBlocks.set(b.id, b);
        broadcast({ type: "orderBlock", block: b });
      }
      for (const id of mitigatedBlockIds) {
        activeBlocks.delete(id);
        broadcast({ type: "orderBlockMitigated", id });
      }
    }

    const settings = getSettings();
    const source = settings.signalSource;
    let paperDirty = false;

    // Surface signals + execute. Bot symbols can fire trades even when not the UI symbol.
    for (const sig of signals) {
      broadcast({ type: "signal", signal: sig });
      if (source === "detectors") {
        if (executeSignal(sig, candle)) paperDirty = true;
      }
    }

    // DeepSeek path — runs once per *new* bar close, async, never blocks.
    if (isNew && (source === "deepseek" || source === "consensus")) {
      const apiKey = getDeepseekKey();
      if (apiKey) {
        const candles = engine.candlesFor(symbol);
        const obs = Array.from(activeBlocks.values()).filter((b) => b.symbol === symbol);
        maybeAdvise({
          symbol,
          candles,
          activeOrderBlocks: obs,
          apiKey,
          minConfidence: settings.deepseekMinConfidence,
        }).then((sig) => {
          const adv = getLastAdvice();
          if (adv && adv.symbol === symbol) {
            broadcast({
              type: "deepseekAdvice",
              symbol,
              action: adv.advice.action,
              confidence: adv.advice.confidence,
              reason: adv.advice.reason,
              tsMs: adv.tsMs,
            });
          }
          if (!sig) return;
          broadcast({ type: "signal", signal: sig });
          // Consensus: require a same-direction detector signal in this bar.
          if (source === "consensus") {
            const agrees = signals.some((s) => s.action === sig.action);
            if (!agrees) return;
          }
          if (executeSignal(sig, candle)) broadcastPaper();
        }).catch((e) => console.error("[deepseek] post-advise", e));
      }
    }

    if (paperDirty) broadcastPaper();
  });
}

function registerIpc() {
  ipcMain.handle(CH.getStatus, () => status());
  ipcMain.handle(CH.getSettings, () => getSettings());
  ipcMain.handle(CH.setSettings, async (_e, patch: Partial<Settings>) => {
    const prev = getSettings();
    setSettings(patch);
    if (patch.detectors) engine.setDetectorConfigs(patch.detectors);
    if (patch.strategy) engine.setStrategyConfig(patch.strategy);
    if (patch.risk) real.setCaps(patch.risk.perTradeMaxStake, patch.risk.dailyMaxLoss);
    // Changing the granularity while watching requires a re-seed + re-subscribe.
    if (patch.granularity && patch.granularity !== prev.granularity && watching) {
      await deriv.forgetAll("candles").catch(() => undefined);
      await deriv.forgetAll("ticks").catch(() => undefined);
      activeBlocks.clear();
      watching = false;
      await startWatcher(activeSymbol);
    }
    return getSettings();
  });
  ipcMain.handle(CH.setSymbol, async (_e, symbol: SymbolCode) => {
    if (watching) await startWatcher(symbol);
    else {
      activeSymbol = symbol;
      setSettings({ activeSymbol: symbol });
      broadcastStatus();
    }
    return status();
  });
  ipcMain.handle(CH.startWatcher, async (_e, symbol?: SymbolCode) => {
    await startWatcher(symbol ?? activeSymbol);
    return status();
  });
  ipcMain.handle(CH.stopWatcher, async () => {
    await stopWatcher();
    return status();
  });
  ipcMain.handle(CH.getCandles, async (_e, symbol: SymbolCode, granularity: number, count: number) => {
    if (!deriv.isOpen()) return [] as Candle[];
    return deriv.fetchHistory(symbol, granularity as 60, count, "latest");
  });
  ipcMain.handle(CH.getHistory, async (_e, symbol: SymbolCode, granularity: number, count: number, end: number | "latest") => {
    if (!deriv.isOpen()) return [] as Candle[];
    return deriv.fetchHistory(symbol, granularity as 60, count, end);
  });

  ipcMain.handle(CH.getSymbolMeta, (_e, symbol: SymbolCode) => symbolMetaCache.get(symbol) ?? null);
  ipcMain.handle(CH.getAllSymbols, () => Array.from(symbolMetaCache.values()));

  ipcMain.handle(CH.getPaper, () => paper.state());
  ipcMain.handle(CH.resetPaper, () => {
    paper.reset();
    broadcastPaper();
    return paper.state();
  });
  ipcMain.handle(CH.closePaperPosition, (_e, id: string, price: number) => {
    paper.closeById(id, price, Date.now());
    broadcastPaper();
    return paper.state();
  });

  ipcMain.handle(CH.runBacktest, async (_e, req: BacktestRequest) => {
    if (!deriv.isOpen()) throw new Error("Deriv WS not connected");
    const candles = await deriv.fetchHistory(req.symbol, req.granularity, req.count, req.endEpoch ?? "latest");

    let signaler: AiSignaler | undefined;
    if (req.aiMode && req.aiMode !== "off") {
      const apiKey = getDeepseekKey();
      if (!apiKey) throw new Error("DeepSeek key not configured — paste it in Settings");
      const minConf = req.aiMinConfidence ?? 0.55;
      signaler = async (_barIdx, sliced, blocks) => {
        const advice = await inferAdvice({
          symbol: req.symbol,
          candles: sliced,
          activeOrderBlocks: blocks,
          apiKey,
          minConfidence: minConf,
        });
        if (!advice) return null;
        if (advice.action === "HOLD") return null;
        if (advice.confidence < minConf) return null;
        const last = sliced[sliced.length - 1];
        return {
          id: randomUUID(),
          ts: last.epoch * 1000,
          symbol: req.symbol,
          detector: "deepseek",
          action: advice.action,
          confidence: advice.confidence,
          reason: `DeepSeek: ${advice.reason}`,
          price: last.close,
        };
      };
    }
    return runBacktest(req, candles, signaler);
  });

  ipcMain.handle(CH.getReal, () => real.state());
  ipcMain.handle(CH.getRealGate, () => evaluateRealGate());
  ipcMain.handle(CH.enableRealMode, () => enableRealMode());
  ipcMain.handle(CH.disableRealMode, () => {
    disableRealMode();
    return { ok: true };
  });
  ipcMain.handle(CH.placeManualTrade, async (_e, symbol: SymbolCode, side: RealTradeSide) => {
    if (!realModeEnabled) throw new Error("Real mode is off — enable it in Settings first");
    const rt = getSettings().realTrading;
    return real.placeTrade({
      symbol,
      side,
      family: rt.contractFamily,
      durationTicks: rt.durationTicks,
      multiplier: rt.multiplier,
      tpSlMode: rt.tpSlMode,
      takeProfitPct: rt.takeProfitPct,
      stopLossPct: rt.stopLossPct,
      atrTpMult: rt.atrTpMult,
      atrSlMult: rt.atrSlMult,
      atr: engine.atrFor(symbol),
      entryPriceHint: engine.lastCloseFor(symbol) ?? undefined,
      detector: "manual",
    });
  });
  ipcMain.handle(CH.closeRealPosition, async (_e, id: string) => {
    await real.closeContract(id);
    return real.state();
  });
  ipcMain.handle(CH.resetDailyPnl, () => {
    real.resetDaily();
    broadcastReal();
    return real.state();
  });

  ipcMain.handle(CH.hasDeepseekKey, () => hasDeepseekKey());
  ipcMain.handle(CH.setDeepseekKey, (_e, key: string) => {
    setDeepseekKey(key);
    clearAdvisorCooldown();
    return true;
  });
  ipcMain.handle(CH.clearDeepseekKey, () => {
    setDeepseekKey(null);
    clearAdvisorCooldown();
    return true;
  });

  ipcMain.handle(CH.hasBinanceCreds, () => hasBinanceCreds());
  ipcMain.handle(CH.setBinanceCreds, (_e, apiKey: string, apiSecret: string) => {
    setBinanceCreds(apiKey, apiSecret);
    configureBinanceClient();
    return true;
  });
  ipcMain.handle(CH.clearBinanceCreds, () => {
    setBinanceCreds(null, null);
    configureBinanceClient();
    return true;
  });
  ipcMain.handle(CH.getBinanceTestnet, () => getBinanceTestnet());
  ipcMain.handle(CH.setBinanceTestnet, (_e, testnet: boolean) => {
    setBinanceTestnet(testnet);
    configureBinanceClient();
    return true;
  });

  // Smoke test — authenticated read-only call. Verifies key works without
  // placing any orders. Returns { ok: true, balanceUsdt } on success.
  ipcMain.handle(CH.testBinanceConnection, async () => {
    try {
      configureBinanceClient();
      await binanceClient.syncTime();
      const bals = await binanceClient.getBalances();
      const usdt = bals.find((b) => b.asset === "USDT");
      return { ok: true, balanceUsdt: usdt?.balance ?? 0, available: usdt?.availableBalance ?? 0, testnet: getBinanceTestnet() };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle(CH.startBinance, async () => {
    try {
      if (!hasBinanceCreds()) return { ok: false, error: "No Binance creds saved" };
      configureBinanceClient();
      setBinanceEnabled(true);
      await binanceEngine.start();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle(CH.stopBinance, async () => {
    setBinanceEnabled(false);
    await binanceEngine.stop();
    return { ok: true };
  });

  ipcMain.handle(CH.getBinanceState, () => ({
    state: binanceEngine.state(),
    enabled: getBinanceEnabled(),
    hasCreds: hasBinanceCreds(),
    testnet: getBinanceTestnet(),
  }));

  ipcMain.handle(CH.hasToken, () => hasToken());
  ipcMain.handle(CH.setToken, (_e, token: string) => {
    setDerivToken(token);
    deriv.setToken(token);
    broadcastStatus();
    return true;
  });
  ipcMain.handle(CH.clearToken, () => {
    setDerivToken(null);
    deriv.setToken(null);
    account = null;
    real.setAccount(null);
    if (realModeEnabled) disableRealMode("API token cleared");
    broadcastStatus();
    return true;
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: "#0b0f1a",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => mainWindow?.show());

  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  registerIpc();
  wireDeriv();
  deriv.connect();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  deriv.close();
  if (process.platform !== "darwin") app.quit();
});

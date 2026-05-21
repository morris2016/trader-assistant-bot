// HTTP server for the bot — health/state/trades API + static UI hosting.
// All API routes live under /api/*. The root path serves the React app from
// /app/web (built into the Docker image). /health is kept at root for Railway.

import http from "node:http";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BotState, Fast1Config, Fast2Config, Fast3Config, Fast4Config, RealConfig } from "./storage";
import type { Logger } from "./logger";
import type { Candle, Signal, RealTrade, AccountInfo, SymbolCode } from "@shared/types";
import type { PaperState } from "./paper-engine";
import { parseSessionCookie } from "./auth-store";

export type HealthSnapshot = {
  wsConnected: boolean;
  authorized: boolean;
  uptimeSec: number;
  /** Seconds since last heartbeat tick. > 180s + uptime > 120s indicates a hung event loop. */
  heartbeatAgeSec?: number;
  /** True if the watchdog has determined the bot is hung (used for /health 503). */
  hung?: boolean;
};

export type ManualControls = {
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  /** Reset adaptive shift state to clean. */
  resetAdaptiveShift: () => void;
  /** Reset daily P&L tracking. */
  resetDaily: () => void;
  /** Reset paper trading state to a fresh balance. */
  resetPaper: (balance?: number) => void;
  /** Reset fast-trade paper sandbox AND clear all per-strategy martingale ladders. */
  resetFastPaper: (balance?: number) => void;
  /** Patch Fast (sandbox 1) runtime config (tradeMultiplier, martingaleMultiplier, fees, etc.). */
  updateFast1Config: (patch: Partial<Fast1Config>) => void;
  /** Reset Fast2 sandbox AND clear all per-strategy martingale ladders. */
  resetFast2Paper: (balance?: number) => void;
  /** Patch Fast2 runtime config (tradeMultiplier, martingaleMultiplier, etc.). */
  updateFast2Config: (patch: Partial<Fast2Config>) => void;
  /** Patch a per-strategy override under fast2Config.perStrategy[strategyId].
   *  If `patch` is null, the override entry is removed (strategy falls back
   *  to the general config). */
  updateFast2StrategyConfig: (strategyId: string, patch: Partial<Fast2Config> | null) => void;
  /** Reset the Fast3 paper sandbox (balance + ladders). */
  resetFast3Paper: (balance?: number) => void;
  /** Patch Fast3 runtime config. */
  updateFast3Config: (patch: Partial<Fast3Config>) => void;
  /** Patch a per-strategy Fast3 override; null clears. */
  updateFast3StrategyConfig: (strategyId: string, patch: Partial<Fast3Config> | null) => void;
  /** Reset the Fast4 paper sandbox (balance + ladders + probe state). */
  resetFast4Paper: (balance?: number) => void;
  /** Patch Fast4 runtime config (includes probe knobs). */
  updateFast4Config: (patch: Partial<Fast4Config>) => void;
  /** Patch a per-strategy Fast4 override; null clears. */
  updateFast4StrategyConfig: (strategyId: string, patch: Partial<Fast4Config> | null) => void;
  /** Patch the Real-strategy book runtime config (paper/live toggle, etc.). */
  updateRealConfig: (patch: Partial<RealConfig>) => void;
  /** Read the current Real-strategy runtime config. */
  getRealConfig: () => RealConfig;
  /** Manually close an open Fast2 position. `id` is the paper position id
   *  or live trade id depending on mode. Throws if the position can't be
   *  found or close fails (Deriv sell error, etc.). */
  closeFast2Position: (id: string, mode: "paper" | "live") => Promise<void>;
  /** Force a fresh resubscribe — wipes local engine state, calls deriv.forgetAll, re-runs subscribeAll. */
  forceResubscribe: () => Promise<void>;
  /** Reconcile open Real contracts with Deriv: snapshot each, settle any that
   *  finalised during a WS gap, re-subscribe live streams for ones still open.
   *  Recovers trades that lost their contract subscription on a reconnect. */
  reconcileContracts: () => Promise<void>;
};

export type StrategyStats = {
  id: string;
  name: string;
  description: string;
  symbols: string[];
  granularity: number;
  validation: {
    expectancyR?: number;
    winRate?: number;
    pnlUsd?: number;
    trades?: number;
  };
  live: {
    signals: number;
    trades: number;
    wins: number;
    losses: number;
    pnlUsd: number;
    winRate: number;
    expectancyR: number;
    lastSignalAt: number | null;
    lastTradeAt: number | null;
    barsSeen: number;
    lastBarSeenAt: number | null;
  };
};

export type HttpServerHandle = {
  close(): Promise<void>;
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map":  "application/json",
};

export function startHttpServer(opts: {
  port: number;
  logger: Logger;
  webDir: string;                                              // path to static UI bundle (e.g., /app/web)
  getHealth: () => HealthSnapshot;
  getState: () => BotState;
  getAccount: () => AccountInfo | null;
  getRecentSignals: () => Signal[];
  /** Per-sandbox signal buffers — each only contains signals matched by that
   *  sandbox's strategy registry (sym + gr + detector). Lets the UI surface
   *  signals isolated per tab so an empty list = definitively no signal. */
  getRealRecentSignals: () => Signal[];
  getFastRecentSignals: () => Signal[];
  getFast2RecentSignals: () => Signal[];
  getAdaptiveShiftDescription: () => string;
  manualControls: ManualControls;
  /** Per-(symbol,granularity) candle history for chart rendering. */
  getCandles: (symbol: SymbolCode, granularity: number, limit: number) => Candle[];
  /** Enriched per-strategy stats (live signals + trades + WR). */
  getStrategyStats: () => StrategyStats[];
  /** Read-only view of effective bot config (no secrets). */
  getConfig: () => Record<string, unknown>;
  /** List of subscribed (symbol, granularity) pairs. */
  getSubscriptions: () => { symbol: string; granularity: number; bars: number }[];
  /** Paper trading state + stats. */
  getPaperState: () => PaperState;
  getPaperStats: () => Record<string, number>;
  /** Fast-trade sandbox paper state — own balance/trades/equity, isolated from
   *  real-asset paper. Stake comes from per-strategy martingale ladder rather
   *  than adaptive shift. */
  getFastPaperState: () => PaperState;
  getFastPaperStats: () => Record<string, number>;
  /** Per-strategy martingale ladder snapshot, keyed by strategy id. */
  getFastMartingale: () => Record<string, { level: number; wins: number; losses: number; circuitBreakers: number; lastCircuitBreakerAt: number; nextStake: number }>;
  /** Per-strategy live stats for fast-trade strategies. */
  getFastStrategyStats: () => StrategyStats[];
  /** Fast (sandbox 1) runtime config — leverage + martingale + fees. */
  getFast1Config: () => Fast1Config;
  /** Fast2 paper sandbox state — separate balance/trades/equity from fastPaper. */
  getFast2PaperState: () => PaperState;
  getFast2PaperStats: () => Record<string, number>;
  /** Per-strategy martingale ladder snapshot for Fast2, keyed by strategy id. */
  getFast2Martingale: () => Record<string, { level: number; wins: number; losses: number; circuitBreakers: number; lastCircuitBreakerAt: number; nextStake: number }>;
  /** Per-strategy live stats for Fast2 strategies. */
  getFast2StrategyStats: () => StrategyStats[];
  /** Fast2 runtime config — user-selectable trade leverage + martingale params. */
  getFast2Config: () => Fast2Config;
  /** Fast3 paper sandbox state — DIGITODD tick-level book. */
  getFast3PaperState: () => PaperState;
  getFast3PaperStats: () => Record<string, number>;
  getFast3Martingale: () => Record<string, { level: number; wins: number; losses: number; circuitBreakers: number; lastCircuitBreakerAt: number; nextStake: number }>;
  getFast3StrategyStats: () => StrategyStats[];
  getFast3Config: () => Fast3Config;
  /** Fast4 paper sandbox state — Fast3 + opposite-side probe circuit breaker. */
  getFast4PaperState: () => PaperState;
  getFast4PaperStats: () => Record<string, number>;
  getFast4Martingale: () => Record<string, { level: number; wins: number; losses: number; circuitBreakers: number; lastCircuitBreakerAt: number; nextStake: number }>;
  getFast4StrategyStats: () => StrategyStats[];
  getFast4Config: () => Fast4Config;
  /** Fast4 probe state for a single strategy — null if no state yet. */
  getFast4ProbeStateFor: (strategyId: string) => { baseLossStreak: number; probeRemaining: number; probesFired: number } | null;
  /** Per-engine diagnostic snapshot — used to debug why signals aren't firing. */
  getDiagnostics: () => Array<{ key: string; symbol: string; granularity: number; lastCandleAtMs: number | null; engine: ReturnType<import("../main/engine/runner").Engine["diagnose"]> }>;
  /** Most-recent close price for a symbol across any engine (used by the UI
   *  to compute live unrealized P&L on open trades). Returns null if the
   *  symbol has not been seeded yet. */
  getLastPriceFor: (symbol: string) => number | null;
  /** Recent in-memory log entries for the web UI's Logs panel. */
  getRecentLogs: (limit: number) => Array<import("./logger").LogEntry>;
  /** Single-admin auth — first-time setup via UI, then login required. */
  auth?: {
    hasAdmin: () => Promise<boolean>;
    setupAdmin: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
    login: (username: string, password: string) => Promise<{ ok: true; token: string } | { ok: false; error: string }>;
    validateSession: (token: string) => Promise<boolean>;
    logout: (token: string) => Promise<void>;
  };
  /** Binance Futures crypto trading engine — optional. When provided, exposes
   *  /api/binance/* endpoints. Keys persisted encrypted on disk via binance-store. */
  binance?: {
    hasCreds: () => boolean;
    isRunning: () => boolean;
    getState: () => any;
    getTestnet: () => boolean;
    setCreds: (apiKey: string, apiSecret: string, testnet: boolean) => Promise<void>;
    clearCreds: () => Promise<void>;
    testConnection: () => Promise<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string }>;
    start: () => Promise<{ ok: boolean; error?: string }>;
    stop: () => Promise<{ ok: boolean }>;
  };
}): HttpServerHandle {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path0 = url.pathname;

      // ───── Session-based auth gate ──────────────────────────────────
      // Bypassed for: /health, /ready (Railway probes), /api/auth/* (login flow),
      // and the static UI bundle (so the login screen itself loads).
      // Static assets are loaded by the React app AFTER auth is shown, but the
      // login screen IS the React app, so we let static files through.
      const isAuthRoute = path0.startsWith("/api/auth/");
      const isHealth = path0 === "/health" || path0 === "/ready";
      const isStatic = !path0.startsWith("/api/") && !isHealth;
      const requiresAuth = !isAuthRoute && !isHealth && !isStatic;
      if (requiresAuth && opts.auth) {
        let valid = false;
        try {
          const cookie = req.headers["cookie"] ?? "";
          const session = parseSessionCookie(cookie);
          if (session) valid = await opts.auth.validateSession(session);
        } catch (e) {
          opts.logger.error("auth middleware error", { err: (e as Error).message });
        }
        if (!valid) {
          json(res, 401, { ok: false, error: "Not authenticated" });
          return;
        }
      }

      // ───── Auth routes (no auth required here) ──────────────────────
      if (opts.auth && path0.startsWith("/api/auth/")) {
        const a = opts.auth;
        if (req.method === "GET" && path0 === "/api/auth/check") {
          const hasAdmin = await a.hasAdmin();
          const cookie = req.headers["cookie"] ?? "";
          const tok = parseSessionCookie(cookie);
          const authenticated = tok ? await a.validateSession(tok) : false;
          json(res, 200, { hasAdmin, authenticated });
          return;
        }
        if (req.method === "POST" && path0 === "/api/auth/setup") {
          const body = await readBody(req);
          try {
            const p = JSON.parse(body) as { username?: string; password?: string };
            if (await a.hasAdmin()) { json(res, 409, { ok: false, error: "Admin already exists" }); return; }
            const r = await a.setupAdmin(p.username ?? "", p.password ?? "");
            if (!r.ok) { json(res, 400, r); return; }
            // Auto-login the new admin
            const login = await a.login(p.username ?? "", p.password ?? "");
            if (login.ok) {
              res.writeHead(200, {
                "Set-Cookie": `bot_session=${login.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30*24*60*60}${req.headers["x-forwarded-proto"] === "https" || (req.socket as any).encrypted ? "; Secure" : ""}`,
                "Content-Type": "application/json; charset=utf-8",
              });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            json(res, 200, { ok: true });
          } catch (e: any) { json(res, 400, { ok: false, error: e?.message ?? "Bad body" }); }
          return;
        }
        if (req.method === "POST" && path0 === "/api/auth/login") {
          const body = await readBody(req);
          try {
            const p = JSON.parse(body) as { username?: string; password?: string };
            const r = await a.login(p.username ?? "", p.password ?? "");
            if (!r.ok) { json(res, 401, r); return; }
            res.writeHead(200, {
              "Set-Cookie": `bot_session=${r.token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30*24*60*60}${req.headers["x-forwarded-proto"] === "https" || (req.socket as any).encrypted ? "; Secure" : ""}`,
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(JSON.stringify({ ok: true }));
          } catch (e: any) { json(res, 400, { ok: false, error: e?.message ?? "Bad body" }); }
          return;
        }
        if (req.method === "POST" && path0 === "/api/auth/logout") {
          const cookie = req.headers["cookie"] ?? "";
          const tok = parseSessionCookie(cookie);
          if (tok) await a.logout(tok);
          res.writeHead(200, {
            "Set-Cookie": `bot_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
            "Content-Type": "application/json; charset=utf-8",
          });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      // ───── API routes ────────────────────────────────────────────────
      if (path0.startsWith("/api/") || path0 === "/health" || path0 === "/ready") {
        if (req.method === "POST" && (path0 === "/api/control/pause" || path0 === "/api/control/resume" || path0 === "/api/control/reset-adaptive" || path0 === "/api/control/reset-daily" || path0 === "/api/control/reset-paper" || path0 === "/api/control/reset-fast-paper" || path0 === "/api/control/update-fast1-config" || path0 === "/api/control/reset-fast2-paper" || path0 === "/api/control/update-fast2-config" || path0 === "/api/control/reset-fast3-paper" || path0 === "/api/control/update-fast3-config" || path0 === "/api/control/reset-fast4-paper" || path0 === "/api/control/update-fast4-config" || path0 === "/api/control/update-real-config" || path0 === "/api/control/close-fast2-position" || path0 === "/api/control/resubscribe" || path0 === "/api/control/reconcile-contracts")) {
          if (path0 === "/api/control/pause")            opts.manualControls.setPaused(true);
          else if (path0 === "/api/control/resume")      opts.manualControls.setPaused(false);
          else if (path0 === "/api/control/reset-adaptive") opts.manualControls.resetAdaptiveShift();
          else if (path0 === "/api/control/reset-daily") opts.manualControls.resetDaily();
          else if (path0 === "/api/control/reset-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetPaper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/reset-fast-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetFastPaper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/update-fast1-config") {
            const patch: Partial<Fast1Config> = {};
            const tm = url.searchParams.get("tradeMultiplier");
            if (tm) patch.tradeMultiplier = Number(tm);
            const mm = url.searchParams.get("martingaleMultiplier");
            if (mm) patch.martingaleMultiplier = Number(mm);
            const bs = url.searchParams.get("baseStake");
            if (bs) patch.baseStake = Number(bs);
            const ml = url.searchParams.get("maxLevels");
            if (ml) patch.maxLevels = Number(ml);
            const cap = url.searchParams.get("perTradeCap");
            if (cap) patch.perTradeCap = Number(cap);
            const cm = url.searchParams.get("commissionPct");
            if (cm) patch.commissionPct = Number(cm);
            const sp = url.searchParams.get("entrySpreadBps");
            if (sp) patch.entrySpreadBps = Number(sp);
            const slp = url.searchParams.get("slSlippageBps");
            if (slp) patch.slSlippageBps = Number(slp);
            const fm = url.searchParams.get("forceMartingale");
            if (fm != null) patch.forceMartingale = fm === "true" || fm === "1";
            const sf = url.searchParams.get("sideFilter");
            if (sf === "both" || sf === "BUY" || sf === "SELL") patch.sideFilter = sf;
            const mm2 = url.searchParams.get("martingaleMode");
            if (mm2 === "classic" || mm2 === "anti") patch.martingaleMode = mm2;
            const lt = url.searchParams.get("liveTradingEnabled");
            if (lt != null) patch.liveTradingEnabled = lt === "true" || lt === "1";
            opts.manualControls.updateFast1Config(patch);
          }
          else if (path0 === "/api/control/reset-fast2-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetFast2Paper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/update-fast2-config") {
            // All knobs are passed as query params — kept consistent with the other
            // POST controls. Only fields that arrive non-empty are forwarded.
            // If `strategyId` is present, the patch goes into perStrategy[id]
            // (per-asset override). If `clear=1` along with strategyId, the
            // override for that strategy is cleared (falls back to general).
            const strategyId = url.searchParams.get("strategyId") ?? undefined;
            const clear = url.searchParams.get("clear") === "1";
            const patch: Partial<Fast2Config> = {};
            const tm = url.searchParams.get("tradeMultiplier");
            if (tm) patch.tradeMultiplier = Number(tm);
            const mm = url.searchParams.get("martingaleMultiplier");
            if (mm) patch.martingaleMultiplier = Number(mm);
            const bs = url.searchParams.get("baseStake");
            if (bs) patch.baseStake = Number(bs);
            const ml = url.searchParams.get("maxLevels");
            if (ml) patch.maxLevels = Number(ml);
            const cap = url.searchParams.get("perTradeCap");
            if (cap) patch.perTradeCap = Number(cap);
            const cm = url.searchParams.get("commissionPct");
            if (cm) patch.commissionPct = Number(cm);
            const sp = url.searchParams.get("entrySpreadBps");
            if (sp) patch.entrySpreadBps = Number(sp);
            const slp = url.searchParams.get("slSlippageBps");
            if (slp) patch.slSlippageBps = Number(slp);
            const fm = url.searchParams.get("forceMartingale");
            if (fm != null) patch.forceMartingale = fm === "true" || fm === "1";
            const sf = url.searchParams.get("sideFilter");
            if (sf === "both" || sf === "BUY" || sf === "SELL") patch.sideFilter = sf;
            const mm2 = url.searchParams.get("martingaleMode");
            if (mm2 === "classic" || mm2 === "anti") patch.martingaleMode = mm2;
            const lt = url.searchParams.get("liveTradingEnabled");
            if (lt != null) patch.liveTradingEnabled = lt === "true" || lt === "1";
            const en = url.searchParams.get("enabled");
            if (en != null) patch.enabled = en === "true" || en === "1";
            if (strategyId) {
              opts.manualControls.updateFast2StrategyConfig(strategyId, clear ? null : patch);
            } else {
              opts.manualControls.updateFast2Config(patch);
            }
          }
          else if (path0 === "/api/control/reset-fast3-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetFast3Paper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/update-fast3-config") {
            const strategyId = url.searchParams.get("strategyId") ?? undefined;
            const clear = url.searchParams.get("clear") === "1";
            const patch: Partial<Fast3Config> = {};
            const mm = url.searchParams.get("martingaleMultiplier");
            if (mm) patch.martingaleMultiplier = Number(mm);
            const bs = url.searchParams.get("baseStake");
            if (bs) patch.baseStake = Number(bs);
            const ml = url.searchParams.get("maxLevels");
            if (ml) patch.maxLevels = Number(ml);
            const cap = url.searchParams.get("perTradeCap");
            if (cap) patch.perTradeCap = Number(cap);
            const fm = url.searchParams.get("forceMartingale");
            if (fm != null) patch.forceMartingale = fm === "true" || fm === "1";
            const sf = url.searchParams.get("sideFilter");
            if (sf === "both" || sf === "BUY" || sf === "SELL") patch.sideFilter = sf;
            const mm2 = url.searchParams.get("martingaleMode");
            if (mm2 === "classic" || mm2 === "anti") patch.martingaleMode = mm2;
            const lt = url.searchParams.get("liveTradingEnabled");
            if (lt != null) patch.liveTradingEnabled = lt === "true" || lt === "1";
            const en = url.searchParams.get("enabled");
            if (en != null) patch.enabled = en === "true" || en === "1";
            const md = url.searchParams.get("martingaleDecay");
            if (md != null && md !== "") {
              const n = Number(md);
              if (Number.isFinite(n) && n > 0 && n <= 1) patch.martingaleDecay = n;
            }
            if (strategyId) {
              opts.manualControls.updateFast3StrategyConfig(strategyId, clear ? null : patch);
            } else {
              opts.manualControls.updateFast3Config(patch);
            }
          }
          else if (path0 === "/api/control/reset-fast4-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetFast4Paper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/update-fast4-config") {
            const strategyId = url.searchParams.get("strategyId") ?? undefined;
            const clear = url.searchParams.get("clear") === "1";
            const patch: Partial<Fast4Config> = {};
            const mm = url.searchParams.get("martingaleMultiplier");
            if (mm) patch.martingaleMultiplier = Number(mm);
            const bs = url.searchParams.get("baseStake");
            if (bs) patch.baseStake = Number(bs);
            const ml = url.searchParams.get("maxLevels");
            if (ml) patch.maxLevels = Number(ml);
            const cap = url.searchParams.get("perTradeCap");
            if (cap) patch.perTradeCap = Number(cap);
            const fm = url.searchParams.get("forceMartingale");
            if (fm != null) patch.forceMartingale = fm === "true" || fm === "1";
            const sf = url.searchParams.get("sideFilter");
            if (sf === "both" || sf === "BUY" || sf === "SELL") patch.sideFilter = sf;
            const mm2 = url.searchParams.get("martingaleMode");
            if (mm2 === "classic" || mm2 === "anti") patch.martingaleMode = mm2;
            const lt = url.searchParams.get("liveTradingEnabled");
            if (lt != null) patch.liveTradingEnabled = lt === "true" || lt === "1";
            const en = url.searchParams.get("enabled");
            if (en != null) patch.enabled = en === "true" || en === "1";
            const md = url.searchParams.get("martingaleDecay");
            if (md != null && md !== "") {
              const n = Number(md);
              if (Number.isFinite(n) && n > 0 && n <= 1) patch.martingaleDecay = n;
            }
            // Probe knobs.
            const pe = url.searchParams.get("probeEnabled");
            if (pe != null) patch.probeEnabled = pe === "true" || pe === "1";
            const lst = url.searchParams.get("lossStreakTrigger");
            if (lst != null && lst !== "") {
              const n = Number(lst);
              if (Number.isFinite(n) && n >= 1) patch.lossStreakTrigger = Math.round(n);
            }
            const pp = url.searchParams.get("probePattern");
            if (pp != null && pp !== "") patch.probePattern = pp;
            const hc = url.searchParams.get("hardCap");
            if (hc != null && hc !== "") {
              const n = Number(hc);
              if (Number.isFinite(n) && n >= 0) patch.hardCap = Math.round(n);
            }
            const cps = url.searchParams.get("customPatterns");
            if (cps != null && cps !== "") {
              try {
                const parsed = JSON.parse(cps);
                if (Array.isArray(parsed)) {
                  patch.customPatterns = parsed.filter((x: unknown): x is string => typeof x === "string");
                }
              } catch {
                // Bad JSON — ignore the field, server-side validator will keep current value.
              }
            }
            const tiu = url.searchParams.get("tradeIntervalUnit");
            if (tiu === "ticks" || tiu === "seconds") patch.tradeIntervalUnit = tiu;
            const ti = url.searchParams.get("tradeInterval");
            if (ti != null && ti !== "") {
              const n = Number(ti);
              if (Number.isFinite(n) && n >= 1) patch.tradeInterval = Math.round(n);
            }
            if (strategyId) {
              opts.manualControls.updateFast4StrategyConfig(strategyId, clear ? null : patch);
            } else {
              opts.manualControls.updateFast4Config(patch);
            }
          }
          else if (path0 === "/api/control/update-real-config") {
            const patch: Partial<RealConfig> = {};
            const lt = url.searchParams.get("liveTradingEnabled");
            if (lt != null) patch.liveTradingEnabled = lt === "true" || lt === "1";
            const bs = url.searchParams.get("baseStake");
            if (bs != null && Number.isFinite(Number(bs))) patch.baseStake = Number(bs);
            const m = url.searchParams.get("multiplier");
            if (m != null && Number.isFinite(Number(m))) patch.multiplier = Number(m);
            const dml = url.searchParams.get("dailyMaxLoss");
            if (dml != null && Number.isFinite(Number(dml))) patch.dailyMaxLoss = Number(dml);
            opts.manualControls.updateRealConfig(patch);
          }
          else if (path0 === "/api/control/close-fast2-position") {
            const id = url.searchParams.get("id");
            const modeQ = url.searchParams.get("mode");
            const mode: "paper" | "live" = modeQ === "live" ? "live" : "paper";
            if (!id) { json(res, 400, { error: "id required" }); return; }
            try {
              await opts.manualControls.closeFast2Position(id, mode);
              opts.logger.warn("fast2 position manually closed", { id, mode });
              json(res, 200, { ok: true });
            } catch (e) {
              opts.logger.error("manual close failed", { id, mode, err: (e as Error).message });
              json(res, 500, { error: (e as Error).message });
            }
            return;
          }
          else if (path0 === "/api/control/resubscribe") {
            opts.manualControls.forceResubscribe().catch((e) => opts.logger.error("forceResubscribe failed", { err: (e as Error).message }));
          }
          else if (path0 === "/api/control/reconcile-contracts") {
            opts.manualControls.reconcileContracts().catch((e) => opts.logger.error("reconcileContracts failed", { err: (e as Error).message }));
          }
          opts.logger.info("manual control invoked", { route: path0 });
          json(res, 200, { ok: true });
          return;
        }
        // ─── Binance Futures routes (mixed GET/POST — keep before GET-only gate) ──
        if (opts.binance && path0.startsWith("/api/binance/")) {
          const b = opts.binance;
          if (req.method === "GET" && path0 === "/api/binance/state") {
            json(res, 200, { hasCreds: b.hasCreds(), running: b.isRunning(), state: b.getState(), testnet: b.getTestnet() });
            return;
          }
          if (req.method === "POST" && path0 === "/api/binance/set-creds") {
            const body = await readBody(req);
            try {
              const parsed = JSON.parse(body) as { apiKey?: string; apiSecret?: string; testnet?: boolean };
              if (!parsed.apiKey || !parsed.apiSecret || parsed.apiKey.length < 32 || parsed.apiSecret.length < 32) {
                json(res, 400, { ok: false, error: "Invalid key/secret (must each be ≥32 chars)" });
                return;
              }
              await b.setCreds(parsed.apiKey, parsed.apiSecret, !!parsed.testnet);
              json(res, 200, { ok: true });
            } catch (e: any) {
              json(res, 400, { ok: false, error: e?.message ?? "Bad body" });
            }
            return;
          }
          if (req.method === "POST" && path0 === "/api/binance/clear-creds") {
            await b.clearCreds();
            json(res, 200, { ok: true });
            return;
          }
          if (req.method === "POST" && path0 === "/api/binance/test") {
            const r = await b.testConnection();
            json(res, r.ok ? 200 : 400, r);
            return;
          }
          if (req.method === "POST" && path0 === "/api/binance/start") {
            const r = await b.start();
            json(res, r.ok ? 200 : 400, r);
            return;
          }
          if (req.method === "POST" && path0 === "/api/binance/stop") {
            const r = await b.stop();
            json(res, 200, r);
            return;
          }
        }

        if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return; }

        if (path0 === "/health" || path0 === "/api/health") {
          // Liveness check used by Railway. 200 unless the bot is HUNG —
          // hung means: been alive >2min AND heartbeat stale >3min, indicating
          // the event loop is blocked. In that case 503 → Railway restarts.
          const h = opts.getHealth();
          res.statusCode = h.hung ? 503 : 200;
          res.end(JSON.stringify({ healthy: !h.hung, ...h, paused: opts.manualControls.isPaused() }));
          return;
        }
        if (path0 === "/ready" || path0 === "/api/ready") {
          const h = opts.getHealth();
          const ready = h.wsConnected && h.authorized;
          json(res, ready ? 200 : 503, { ready, ...h });
          return;
        }
        if (path0 === "/api/state") {
          const s = opts.getState();
          json(res, 200, {
            daily: s.daily,
            open: s.open,
            openCount: s.open.length,
            totalClosed: s.closed.length,
            adaptiveShift: s.adaptiveShift,
            adaptiveShiftDescription: opts.getAdaptiveShiftDescription(),
            paused: opts.manualControls.isPaused(),
            account: opts.getAccount(),
            health: opts.getHealth(),
          });
          return;
        }
        if (path0 === "/api/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
          const sandbox = url.searchParams.get("sandbox") ?? "";
          const s = opts.getState();
          // Include open trades alongside closed — open ones have closedAt=null
          // so callers (Fast2 Open Positions, Trades panel) can filter by that.
          // Without this, real open Deriv contracts were invisible to the UI.
          // Optional ?sandbox=fast2|fast3|fast4|real|fast filter is applied SERVER-SIDE
          // so the client doesn't pull 500 unrelated trades just to filter them
          // out — Fast2/Fast3 panels were 5× slower without this.
          let combined = [...s.open, ...s.closed];
          if (sandbox === "real") {
            // Real candle book only trades forex/metals (frx*). Synthetics
            // (R_*, 1HZ*, JD*, RDBEAR/RDBULL, BOOM*, CRASH*) belong to
            // fast/fast2/fast3 — including legacy "restored" rows that
            // pre-date the sandbox tag. Filter by symbol prefix to keep
            // those out regardless of sandbox value.
            combined = combined.filter((t) => t.symbol.startsWith("frx"));
          } else if (sandbox) {
            combined = combined.filter((t) => t.sandbox === sandbox);
          }
          const trades = combined.slice(0, limit);
          json(res, 200, { trades });
          return;
        }
        if (path0 === "/api/signals") {
          // Real-strategy signals only. Per-sandbox isolation: this route
          // returns ONLY signals that matched a real-strategy registry entry
          // (silver/gold/plat/pall/etc). Fast/fast2 each have their own
          // routes consulting their own buffers.
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
          const sigs = opts.getRealRecentSignals().slice(-limit).reverse();
          json(res, 200, { signals: sigs });
          return;
        }
        if (path0 === "/api/signals/all") {
          // Escape hatch: full unfiltered buffer for diagnostic use.
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
          const sigs = opts.getRecentSignals().slice(-limit).reverse();
          json(res, 200, { signals: sigs });
          return;
        }
        if (path0 === "/api/account") {
          json(res, 200, { account: opts.getAccount() });
          return;
        }
        if (path0 === "/api/strategies") {
          json(res, 200, { strategies: opts.getStrategyStats() });
          return;
        }
        if (path0 === "/api/config") {
          json(res, 200, { config: opts.getConfig() });
          return;
        }
        if (path0 === "/api/subscriptions") {
          json(res, 200, { subscriptions: opts.getSubscriptions() });
          return;
        }
        if (path0 === "/api/candles") {
          const sym = url.searchParams.get("symbol") ?? "";
          const gr = Number(url.searchParams.get("granularity") ?? 3600);
          const limit = clamp(Number(url.searchParams.get("limit") ?? 500), 50, 2000);
          if (!sym) { json(res, 400, { error: "symbol required" }); return; }
          const candles = opts.getCandles(sym as SymbolCode, gr, limit);
          json(res, 200, { symbol: sym, granularity: gr, candles });
          return;
        }
        if (path0 === "/api/paper") {
          const ps = opts.getPaperState();
          const stats = opts.getPaperStats();
          json(res, 200, {
            stats,
            startingBalance: ps.startingBalance,
            balance: ps.balance,
            daily: ps.daily,
            open: ps.open,
            adaptiveShift: ps.adaptiveShift,
          });
          return;
        }
        if (path0 === "/api/paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getPaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/paper/equity") {
          const ps = opts.getPaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        // ── Fast-trade sandbox endpoints ─────────────────────────────────
        if (path0 === "/api/fast-paper") {
          const ps = opts.getFastPaperState();
          const stats = opts.getFastPaperStats();
          // Snapshot of last-known prices for each symbol with an open
          // position — paper opens AND live fast opens — so the UI's Open
          // Positions table can compute live uPnL and SL/TP progress.
          const prices: Record<string, number> = {};
          const symbolsNeeded = new Set<string>();
          for (const p of ps.open) symbolsNeeded.add(p.symbol);
          for (const t of opts.getState().open) {
            if (t.sandbox === "fast") symbolsNeeded.add(t.symbol);
          }
          for (const sym of symbolsNeeded) {
            const px = opts.getLastPriceFor(sym);
            if (px != null) prices[sym] = px;
          }
          json(res, 200, {
            stats,
            startingBalance: ps.startingBalance,
            balance: ps.balance,
            daily: ps.daily,
            open: ps.open,
            martingale: opts.getFastMartingale(),
            config: opts.getFast1Config(),
            prices,
          });
          return;
        }
        if (path0 === "/api/fast-config") {
          json(res, 200, { config: opts.getFast1Config() });
          return;
        }
        if (path0 === "/api/fast-paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getFastPaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/fast-paper/equity") {
          const ps = opts.getFastPaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        if (path0 === "/api/fast-strategies") {
          json(res, 200, {
            strategies: opts.getFastStrategyStats(),
            martingale: opts.getFastMartingale(),
            config: opts.getFast1Config(),
          });
          return;
        }
        if (path0 === "/api/fast-signals") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
          const sigs = opts.getFastRecentSignals().slice(-limit).reverse();
          json(res, 200, { signals: sigs });
          return;
        }
        // ── Fast2 sandbox endpoints (3-strategy stack with user-config) ──
        if (path0 === "/api/fast2-paper") {
          const ps = opts.getFast2PaperState();
          const stats = opts.getFast2PaperStats();
          // Snapshot of last-known prices for each symbol with an open position.
          // The UI uses this to render live unrealized P&L per row + a SL/TP
          // progress bar so the operator can intervene before the bot does.
          // Include BOTH paper opens AND live fast2 opens so the Open Positions
          // table works whether liveTradingEnabled is on or off.
          const prices: Record<string, number> = {};
          const symbolsNeeded = new Set<string>();
          for (const p of ps.open) symbolsNeeded.add(p.symbol);
          for (const t of opts.getState().open) {
            if (t.sandbox === "fast2") symbolsNeeded.add(t.symbol);
          }
          for (const sym of symbolsNeeded) {
            const px = opts.getLastPriceFor(sym);
            if (px != null) prices[sym] = px;
          }
          json(res, 200, {
            stats,
            startingBalance: ps.startingBalance,
            balance: ps.balance,
            daily: ps.daily,
            open: ps.open,
            martingale: opts.getFast2Martingale(),
            config: opts.getFast2Config(),
            prices,
          });
          return;
        }
        if (path0 === "/api/fast2-paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getFast2PaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/fast2-paper/equity") {
          const ps = opts.getFast2PaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        if (path0 === "/api/fast2-strategies") {
          json(res, 200, {
            strategies: opts.getFast2StrategyStats(),
            martingale: opts.getFast2Martingale(),
            config: opts.getFast2Config(),
          });
          return;
        }
        if (path0 === "/api/fast2-signals") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 500);
          const sigs = opts.getFast2RecentSignals().slice(-limit).reverse();
          json(res, 200, { signals: sigs });
          return;
        }
        if (path0 === "/api/fast2-config") {
          json(res, 200, { config: opts.getFast2Config() });
          return;
        }
        // ── Fast3 endpoints ──
        if (path0 === "/api/fast3-paper") {
          const ps = opts.getFast3PaperState();
          const stats = opts.getFast3PaperStats();
          json(res, 200, {
            stats,
            startingBalance: ps.startingBalance,
            balance: ps.balance,
            daily: ps.daily,
            open: ps.open,
            martingale: opts.getFast3Martingale(),
            config: opts.getFast3Config(),
          });
          return;
        }
        if (path0 === "/api/fast3-paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getFast3PaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/fast3-paper/equity") {
          const ps = opts.getFast3PaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        if (path0 === "/api/fast3-strategies") {
          json(res, 200, {
            strategies: opts.getFast3StrategyStats(),
            martingale: opts.getFast3Martingale(),
            config: opts.getFast3Config(),
          });
          return;
        }
        if (path0 === "/api/fast3-config") {
          json(res, 200, { config: opts.getFast3Config() });
          return;
        }
        // ── Fast4 endpoints ──
        if (path0 === "/api/fast4-paper") {
          const ps = opts.getFast4PaperState();
          const stats = opts.getFast4PaperStats();
          // Surface probe state per strategy so the panel can show the
          // baseLossStreak counter and probeRemaining indicator.
          const probeState: Record<string, { baseLossStreak: number; probeRemaining: number; probesFired: number }> = {};
          for (const s of opts.getFast4StrategyStats()) {
            const ps0 = opts.getFast4ProbeStateFor(s.id);
            if (ps0) probeState[s.id] = ps0;
          }
          json(res, 200, {
            stats,
            startingBalance: ps.startingBalance,
            balance: ps.balance,
            daily: ps.daily,
            open: ps.open,
            martingale: opts.getFast4Martingale(),
            config: opts.getFast4Config(),
            probeState,
          });
          return;
        }
        if (path0 === "/api/fast4-paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getFast4PaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/fast4-paper/equity") {
          const ps = opts.getFast4PaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        if (path0 === "/api/fast4-strategies") {
          json(res, 200, {
            strategies: opts.getFast4StrategyStats(),
            martingale: opts.getFast4Martingale(),
            config: opts.getFast4Config(),
          });
          return;
        }
        if (path0 === "/api/fast4-config") {
          json(res, 200, { config: opts.getFast4Config() });
          return;
        }
        if (path0 === "/api/real-config") {
          json(res, 200, { config: opts.manualControls.getRealConfig() });
          return;
        }
        if (path0 === "/api/logs") {
          // Returns the most recent log entries in chronological order (oldest
          // first). Optional filters: level (min level to include), q (substring
          // match against the JSON-stringified entry), limit (cap on returned
          // count). Buffer is sized via LOG_BUFFER_SIZE env (default 50_000).
          const LOG_FETCH_CAP = 50_000;
          const limit = clamp(Number(url.searchParams.get("limit") ?? 500), 1, LOG_FETCH_CAP);
          const minLevel = url.searchParams.get("level") ?? "";
          const q = (url.searchParams.get("q") ?? "").toLowerCase();
          const order: Record<string, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
          const all = opts.getRecentLogs(LOG_FETCH_CAP);
          let entries = all;
          if (minLevel && order[minLevel] != null) {
            const min = order[minLevel];
            entries = entries.filter((e) => (order[e.level] ?? 0) >= min);
          }
          if (q) {
            entries = entries.filter((e) => JSON.stringify(e).toLowerCase().includes(q));
          }
          if (entries.length > limit) entries = entries.slice(-limit);
          json(res, 200, { logs: entries, totalBuffered: all.length });
          return;
        }
        if (path0 === "/api/diag") {
          json(res, 200, { diagnostics: opts.getDiagnostics() });
          return;
        }
        json(res, 404, { error: "not found" });
        return;
      }

      // ───── Static UI ──────────────────────────────────────────────────
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      const safe = path0 === "/" ? "/index.html" : path0;
      const file = path.join(opts.webDir, safe);
      // Prevent path traversal
      if (!file.startsWith(opts.webDir)) { json(res, 400, { error: "bad path" }); return; }
      try {
        const stat = await fs.stat(file);
        if (stat.isDirectory()) {
          // Fall back to index for SPA routing
          await sendFile(res, path.join(opts.webDir, "index.html"));
          return;
        }
        await sendFile(res, file);
        return;
      } catch {
        // SPA fallback: any unknown route → index.html (so React Router works)
        const indexPath = path.join(opts.webDir, "index.html");
        if (existsSync(indexPath)) {
          await sendFile(res, indexPath);
          return;
        }
        // No web bundle — return a friendly placeholder
        json(res, 404, { error: "UI not built. Bot API is live at /api/*; visit /api/state for status." });
      }
    } catch (e) {
      opts.logger.error("request error", { err: (e as Error).message });
      try { json(res, 500, { error: "internal" }); } catch {}
    }
  });

  server.listen(opts.port, "0.0.0.0", () => {
    opts.logger.info("http server listening", { port: opts.port, host: "0.0.0.0", webDir: opts.webDir });
  });
  server.on("error", (err) => {
    opts.logger.error("http server error", { err: (err as Error).message });
  });
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      // Cap at 64KB to defend against silly bodies; creds are <1KB.
      if (chunks.reduce((s, x) => s + x.length, 0) > 65536) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

async function sendFile(res: http.ServerResponse, file: string) {
  const ext = path.extname(file).toLowerCase();
  const mime = MIME[ext] ?? "application/octet-stream";
  const data = await fs.readFile(file);
  res.statusCode = 200;
  res.setHeader("Content-Type", mime);
  // Hash-suffixed assets can cache forever; index.html should not.
  if (file.endsWith("index.html")) res.setHeader("Cache-Control", "no-store");
  else res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.end(data);
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

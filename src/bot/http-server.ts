// HTTP server for the bot — health/state/trades API + static UI hosting.
// All API routes live under /api/*. The root path serves the React app from
// /app/web (built into the Docker image). /health is kept at root for Railway.

import http from "node:http";
import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BotState } from "./storage";
import type { Logger } from "./logger";
import type { Candle, Signal, RealTrade, AccountInfo, SymbolCode } from "@shared/types";
import type { PaperState } from "./paper-engine";

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
  /** Reset SYNTH paper trading state (separate sandbox). */
  resetSynthPaper: (balance?: number) => void;
  /** Force a fresh resubscribe — wipes local engine state, calls deriv.forgetAll, re-runs subscribeAll. */
  forceResubscribe: () => Promise<void>;
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
  /** Synth paper trading state + stats (separate sandbox). */
  getSynthPaperState: () => PaperState;
  getSynthPaperStats: () => Record<string, number>;
  /** Per-strategy live stats for synth strategies. */
  getSynthStrategyStats: () => StrategyStats[];
}): HttpServerHandle {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path0 = url.pathname;

      // ───── API routes ────────────────────────────────────────────────
      if (path0.startsWith("/api/") || path0 === "/health" || path0 === "/ready") {
        if (req.method === "POST" && (path0 === "/api/control/pause" || path0 === "/api/control/resume" || path0 === "/api/control/reset-adaptive" || path0 === "/api/control/reset-daily" || path0 === "/api/control/reset-paper" || path0 === "/api/control/reset-synth-paper" || path0 === "/api/control/resubscribe")) {
          if (path0 === "/api/control/pause")            opts.manualControls.setPaused(true);
          else if (path0 === "/api/control/resume")      opts.manualControls.setPaused(false);
          else if (path0 === "/api/control/reset-adaptive") opts.manualControls.resetAdaptiveShift();
          else if (path0 === "/api/control/reset-daily") opts.manualControls.resetDaily();
          else if (path0 === "/api/control/reset-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetPaper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/reset-synth-paper") {
            const balance = url.searchParams.get("balance");
            opts.manualControls.resetSynthPaper(balance ? Number(balance) : undefined);
          }
          else if (path0 === "/api/control/resubscribe") {
            opts.manualControls.forceResubscribe().catch((e) => opts.logger.error("forceResubscribe failed", { err: (e as Error).message }));
          }
          opts.logger.info("manual control invoked", { route: path0 });
          json(res, 200, { ok: true });
          return;
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
          const s = opts.getState();
          json(res, 200, { trades: s.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/signals") {
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
        // ── Synth paper sandbox endpoints (RDBULL / JD100 / BOOM300N) ────
        if (path0 === "/api/synth-paper") {
          const ps = opts.getSynthPaperState();
          const stats = opts.getSynthPaperStats();
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
        if (path0 === "/api/synth-paper/trades") {
          const limit = clamp(Number(url.searchParams.get("limit") ?? 100), 1, 1000);
          const ps = opts.getSynthPaperState();
          json(res, 200, { trades: ps.closed.slice(0, limit) });
          return;
        }
        if (path0 === "/api/synth-paper/equity") {
          const ps = opts.getSynthPaperState();
          json(res, 200, { equity: ps.equity, startingBalance: ps.startingBalance });
          return;
        }
        if (path0 === "/api/synth-strategies") {
          json(res, 200, { strategies: opts.getSynthStrategyStats() });
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

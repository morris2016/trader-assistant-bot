// Minimal HTTP server for health + observability. No deps — Node http only.
// Routes:
//   GET /health   — 200 if WS connected + auth ok, 503 otherwise
//   GET /state    — JSON: adaptive shift, daily P&L, open trades count
//   GET /trades   — JSON: closed trades (?limit=N, default 100)

import http from "node:http";
import type { BotState } from "./storage";
import type { Logger } from "./logger";

export type HealthSnapshot = {
  wsConnected: boolean;
  authorized: boolean;
  uptimeSec: number;
};

export type HealthServerHandle = {
  close(): Promise<void>;
};

export function startHealthServer(opts: {
  port: number;
  logger: Logger;
  getHealth: () => HealthSnapshot;
  getState: () => BotState;
  getAdaptiveShiftDescription: () => string;
}): HealthServerHandle {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("Content-Type", "application/json");
    if (req.method !== "GET") {
      res.statusCode = 405;
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    if (url.pathname === "/health") {
      const h = opts.getHealth();
      const healthy = h.wsConnected && h.authorized;
      res.statusCode = healthy ? 200 : 503;
      res.end(JSON.stringify({ healthy, ...h }));
      return;
    }
    if (url.pathname === "/state") {
      const s = opts.getState();
      res.statusCode = 200;
      res.end(JSON.stringify({
        daily: s.daily,
        openTrades: s.open.length,
        totalClosed: s.closed.length,
        adaptiveShift: s.adaptiveShift,
        adaptiveShiftDescription: opts.getAdaptiveShiftDescription(),
      }));
      return;
    }
    if (url.pathname === "/trades") {
      const limit = Number(url.searchParams.get("limit") ?? 100);
      const s = opts.getState();
      res.statusCode = 200;
      res.end(JSON.stringify({ trades: s.closed.slice(0, Math.max(1, Math.min(limit, 500))) }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  server.listen(opts.port, () => {
    opts.logger.info("health server listening", { port: opts.port });
  });
  server.on("error", (err) => {
    opts.logger.error("health server error", { err: (err as Error).message });
  });
  return {
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

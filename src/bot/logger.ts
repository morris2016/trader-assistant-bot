// Structured logger for the bot. JSON-line format suitable for Railway logs.
// Avoids pino dep to keep bundle slim — hand-rolled but covers the essentials.
//
// In addition to writing every entry to stdout/stderr, the logger keeps the
// most recent entries in an in-memory ring buffer so the web UI can read them
// via /api/logs without scraping Railway's log stream.

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
};

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

// In-memory ring buffer size. At ~10-20 lines/sec under fast3 the old 2000
// cap was filling in ~2-3 minutes — too small to retrace a real-strategy
// signal that fired hours earlier. 50_000 entries ≈ 25-50 min at peak fast3
// load and many hours during quiet metals-only periods, while staying
// comfortably under Railway's per-process memory ceiling (each entry is a
// short JSON object, ~200 bytes → ~10 MB total).
const MAX_BUFFER = Number(process.env.LOG_BUFFER_SIZE ?? 50_000);

export class Logger {
  private readonly buffer: LogEntry[] = [];

  constructor(private readonly minLevel: LogLevel = "info") {}

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta ?? {}),
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + "\n");
  }

  trace(msg: string, meta?: Record<string, unknown>) { this.write("trace", msg, meta); }
  debug(msg: string, meta?: Record<string, unknown>) { this.write("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.write("error", msg, meta); }

  /** Return the most recent log entries in chronological order (oldest first). */
  tail(limit = 500): LogEntry[] {
    if (limit >= this.buffer.length) return this.buffer.slice();
    return this.buffer.slice(-limit);
  }
}

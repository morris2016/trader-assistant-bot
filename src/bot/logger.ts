// Structured logger for the bot. JSON-line format suitable for Railway logs.
// Avoids pino dep to keep bundle slim — hand-rolled but covers the essentials.

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

export class Logger {
  constructor(private readonly minLevel: LogLevel = "info") {}

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta ?? {}),
    };
    const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + "\n");
  }

  trace(msg: string, meta?: Record<string, unknown>) { this.write("trace", msg, meta); }
  debug(msg: string, meta?: Record<string, unknown>) { this.write("debug", msg, meta); }
  info(msg: string, meta?: Record<string, unknown>) { this.write("info", msg, meta); }
  warn(msg: string, meta?: Record<string, unknown>) { this.write("warn", msg, meta); }
  error(msg: string, meta?: Record<string, unknown>) { this.write("error", msg, meta); }
}

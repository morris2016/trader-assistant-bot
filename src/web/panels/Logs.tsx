import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type LogEntry } from "../api";

const REFRESH_MS = 2000;
const MAX_LIMIT = 2000;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };
const LEVELS: { value: string; label: string }[] = [
  { value: "trace", label: "All (trace+)" },
  { value: "debug", label: "Debug+" },
  { value: "info",  label: "Info+" },
  { value: "warn",  label: "Warnings+" },
  { value: "error", label: "Errors only" },
];

function formatEntry(e: LogEntry): string {
  // Render as one line: `HH:MM:SS LEVEL msg key=value key2=value2`
  const { ts, level, msg, ...meta } = e;
  const t = ts.length >= 19 ? ts.slice(11, 19) : ts;
  const metaStr = Object.entries(meta)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${t} ${level.toUpperCase().padEnd(5)} ${msg}${metaStr ? "  " + metaStr : ""}`;
}

export function LogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [totalBuffered, setTotalBuffered] = useState(0);
  const [level, setLevel] = useState<string>("info");
  const [search, setSearch] = useState<string>("");
  const [paused, setPaused] = useState(false);
  const [tail, setTail] = useState(true);
  const [copyOk, setCopyOk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Fetch loop. We always pull min level + search server-side so the buffer
  // delivered to the client is already filtered — easier to copy "exactly
  // what I see".
  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const load = () => {
      api.logs({ level, q: search || undefined, limit: MAX_LIMIT })
        .then((r) => {
          if (cancelled) return;
          setLogs(r.logs);
          setTotalBuffered(r.totalBuffered);
          setError(null);
        })
        .catch((e) => { if (!cancelled) setError((e as Error).message); });
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); };
  }, [level, search, paused]);

  // Auto-scroll to bottom on update when tail mode is on.
  useEffect(() => {
    if (!tail) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs, tail]);

  const lines = useMemo(() => logs.map(formatEntry), [logs]);

  const onCopy = async () => {
    try {
      const txt = lines.join("\n");
      await navigator.clipboard.writeText(txt);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch (e) {
      alert(`Clipboard write failed: ${(e as Error).message}`);
    }
  };

  const onCopyJson = async () => {
    try {
      const txt = logs.map((l) => JSON.stringify(l)).join("\n");
      await navigator.clipboard.writeText(txt);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1200);
    } catch (e) {
      alert(`Clipboard write failed: ${(e as Error).message}`);
    }
  };

  const onDownload = () => {
    const blob = new Blob([logs.map((l) => JSON.stringify(l)).join("\n") + "\n"], { type: "application/x-ndjson" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    a.href = url;
    a.download = `trader-bot-logs-${stamp}.ndjson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card table-card">
      <div className="filters" style={{ flexWrap: "wrap", gap: 8 }}>
        <select className="filter-select" value={level} onChange={(e) => setLevel(e.target.value)} title="Minimum log level">
          {LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
        <input
          className="filter-input"
          type="text"
          placeholder="Search (substring)"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ flex: "1 1 200px", minWidth: 180 }}
        />
        <button className={`btn btn-sm ${tail ? "btn-primary" : ""}`} onClick={() => setTail((v) => !v)} title="Auto-scroll to newest">
          {tail ? "● Tail" : "○ Tail"}
        </button>
        <button className={`btn btn-sm ${paused ? "btn-warn" : ""}`} onClick={() => setPaused((v) => !v)} title="Pause auto-refresh">
          {paused ? "▶ Resume" : "⏸ Pause"}
        </button>
        <button className="btn btn-sm" onClick={onCopy} title="Copy formatted lines to clipboard">
          {copyOk ? "✓ Copied" : "Copy text"}
        </button>
        <button className="btn btn-sm" onClick={onCopyJson} title="Copy raw JSON-line entries">
          Copy JSON
        </button>
        <button className="btn btn-sm" onClick={onDownload} title="Download as .ndjson file">
          Download
        </button>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          {logs.length} shown · {totalBuffered} buffered (max {MAX_LIMIT})
        </span>
      </div>
      {error && (
        <div className="empty" style={{ color: "var(--red, #e05f8a)" }}>⚠ {error}</div>
      )}
      {!error && logs.length === 0 ? (
        <div className="empty"><span className="empty-emoji">📋</span>No log entries match the filter</div>
      ) : (
        <div
          ref={scrollRef}
          style={{
            height: "calc(100vh - 280px)",
            minHeight: 360,
            overflowY: "auto",
            background: "#0a0d14",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.5,
            padding: "8px 12px",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {lines.map((line, i) => {
            const lvl = logs[i].level;
            const color =
              lvl === "error" ? "#ff7a8c" :
              lvl === "warn"  ? "#f3c969" :
              lvl === "info"  ? "#9bd1ff" :
              lvl === "debug" ? "#9aa3b8" :
                                "#6b7390";
            return (
              <div key={`${logs[i].ts}-${i}`} style={{ color }}>
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

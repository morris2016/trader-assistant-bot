// Binance-filtered logs view. Reuses the bot's /api/logs endpoint with
// a pre-applied "binance" search filter so the operator sees only events
// from the BinanceEngine: opened/closed trades, errors, config updates.

import React, { useEffect, useRef, useState } from "react";
import { api, type LogEntry, isoToEatHms } from "../../api";

function formatEntry(e: LogEntry): string {
  const { ts, level, msg, ...meta } = e;
  const t = isoToEatHms(ts);
  const metaStr = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  return `${t} ${level.toUpperCase().padEnd(5)} ${msg}${metaStr ? "  " + metaStr : ""}`;
}

export function BinanceLogsPanel() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [tail, setTail] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (paused) return;
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const r = await api.logs({ limit: 500, q: "binance" });
        if (!cancelled) {
          setLogs(r.logs);
          setError(null);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? "fetch failed");
      }
    };
    fetchLogs();
    const id = setInterval(fetchLogs, 2500);
    return () => { cancelled = true; clearInterval(id); };
  }, [paused]);

  useEffect(() => {
    if (tail && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs, tail]);

  return (
    <div className="section">
      <div className="section-header">
        <div className="section-title">Binance logs</div>
        <div className="section-sub">Live events from the Binance engine: opened/closed trades, errors, config changes. {error && <span style={{ color: "#d4655f" }}>⚠ {error}</span>}</div>
      </div>
      <div className="card card-padded">
        <div className="row" style={{ marginBottom: 8 }}>
          <button className="btn" onClick={() => setPaused(!paused)}>{paused ? "▶ Resume" : "⏸ Pause"}</button>
          <label style={{ fontSize: 13, alignSelf: "center" }}>
            <input type="checkbox" checked={tail} onChange={(e) => setTail(e.target.checked)} style={{ marginRight: 6 }} />
            Auto-scroll to bottom
          </label>
          <span className="muted" style={{ alignSelf: "center", fontSize: 12 }}>{logs.length} entries</span>
        </div>
        <div
          ref={scrollRef}
          style={{
            background: "#06080f", border: "1px solid #1e2842", borderRadius: 6,
            padding: 10, maxHeight: 600, overflowY: "auto",
            fontFamily: "monospace", fontSize: 11.5, color: "#a8b3d5", whiteSpace: "pre-wrap",
          }}
        >
          {logs.length === 0 ? (
            <div className="muted">No binance log entries yet. Start the engine to see activity.</div>
          ) : (
            logs.map((e, i) => {
              const color = e.level === "error" ? "#d4655f" : e.level === "warn" ? "#d4a35f" : e.level === "info" ? "#a8b3d5" : "#6b7896";
              return <div key={i} style={{ color }}>{formatEntry(e)}</div>;
            })
          )}
        </div>
      </div>
    </div>
  );
}

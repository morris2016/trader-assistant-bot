import { useState } from "react";
import { useStore } from "../../store";

type Tab = "all" | "paper" | "real";

type Row =
  | { kind: "paper"; ts: number; symbol: string; side: "BUY" | "SELL"; detector: string; entry: number; exit: number; pnl: number; pnlPct: number; unit: "%"; reason: string }
  | { kind: "real"; ts: number; symbol: string; side: "BUY" | "SELL"; detector: string; entry: number | null; exit: number | null; pnl: number; pnlPct: number; unit: string; reason: string };

export default function HistoryRoute() {
  const paper = useStore((s) => s.paper);
  const real = useStore((s) => s.real);
  const [tab, setTab] = useState<Tab>("all");

  const rows: Row[] = [];
  if ((tab === "all" || tab === "paper") && paper) {
    for (const c of paper.closed) {
      rows.push({
        kind: "paper",
        ts: c.closedAt,
        symbol: c.symbol,
        side: c.side,
        detector: c.detector,
        entry: c.entryPrice,
        exit: c.exitPrice,
        pnl: c.pnl,
        pnlPct: c.pnlPct,
        unit: "%",
        reason: c.exitReason,
      });
    }
  }
  if ((tab === "all" || tab === "real") && real) {
    for (const t of real.closed) {
      rows.push({
        kind: "real",
        ts: t.closedAt ?? 0,
        symbol: t.symbol,
        side: t.side,
        detector: t.detector,
        entry: t.entrySpot,
        exit: t.exitSpot,
        pnl: t.profit ?? 0,
        pnlPct: t.stake > 0 ? (t.profit ?? 0) / t.stake : 0,
        unit: t.currency,
        reason: t.status,
      });
    }
  }

  rows.sort((a, b) => b.ts - a.ts);

  const totalPaperPct = paper?.stats.totalPnlPct ?? 0;
  const totalRealProfit = real?.stats.totalProfit ?? 0;

  return (
    <div className="page">
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0, color: "#5fd4a4" }}>Trade History</h2>
        <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
          <TabBtn label="All" active={tab === "all"} onClick={() => setTab("all")} />
          <TabBtn label={`Paper (${paper?.closed.length ?? 0})`} active={tab === "paper"} onClick={() => setTab("paper")} />
          <TabBtn label={`Real (${real?.closed.length ?? 0})`} active={tab === "real"} onClick={() => setTab("real")} />
        </div>
      </div>

      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">Paper total</div>
          <div className={`stat-value ${totalPaperPct >= 0 ? "ok" : "bad"}`}>
            {(totalPaperPct * 100).toFixed(2)}%
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Real total</div>
          <div className={`stat-value ${totalRealProfit >= 0 ? "ok" : "bad"}`}>
            {totalRealProfit >= 0 ? "+" : ""}{totalRealProfit.toFixed(2)} {real?.stats.currency ?? ""}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Real win rate</div>
          <div className={`stat-value ${(real?.stats.winRate ?? 0) >= 0.5 ? "ok" : "bad"}`}>
            {((real?.stats.winRate ?? 0) * 100).toFixed(0)}%
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Real trades today</div>
          <div className="stat-value neutral">{real?.daily.tradesOpened ?? 0}</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card empty-state">No closed trades yet.</div>
      ) : (
        <div className="card">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: "#8a95b8", textAlign: "left", borderBottom: "1px solid #1e2842" }}>
                <th style={cell}>Closed</th>
                <th style={cell}>Source</th>
                <th style={cell}>Symbol</th>
                <th style={cell}>Side</th>
                <th style={cell}>Detector</th>
                <th style={cell}>Entry → Exit</th>
                <th style={cell}>Reason</th>
                <th style={{ ...cell, textAlign: "right" }}>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #1a2240" }}>
                  <td style={cell}>{r.ts > 0 ? new Date(r.ts).toLocaleString() : "—"}</td>
                  <td style={cell}>
                    <span style={{
                      padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700,
                      background: r.kind === "real" ? "#4a1e2e" : "#1e4a38",
                      color: r.kind === "real" ? "#e05f8a" : "#5fd4a4",
                    }}>
                      {r.kind.toUpperCase()}
                    </span>
                  </td>
                  <td style={cell}>{r.symbol}</td>
                  <td style={cell}>
                    <span className={`pill ${r.side === "BUY" ? "pill-buy" : "pill-sell"}`}>{r.side}</span>
                  </td>
                  <td style={cell}>{r.detector}</td>
                  <td style={cell}>
                    {r.entry != null ? r.entry.toFixed(3) : "—"} → {r.exit != null ? r.exit.toFixed(3) : "—"}
                  </td>
                  <td style={{ ...cell, color: "#6b7390" }}>{r.reason}</td>
                  <td style={{ ...cell, textAlign: "right", color: r.pnl >= 0 ? "#5fd4a4" : "#e05f8a", fontWeight: 700 }}>
                    {r.kind === "paper"
                      ? `${(r.pnlPct * 100).toFixed(2)}%`
                      : `${r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)} ${r.unit}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TabBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="btn"
      style={{
        background: active ? "#1e4a38" : "#12182a",
        color: active ? "#5fd4a4" : "#8a95b8",
        borderColor: active ? "#5fd4a4" : "#1e2842",
      }}
    >
      {label}
    </button>
  );
}

const cell: React.CSSProperties = { padding: "10px 8px" };

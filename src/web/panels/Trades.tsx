import React, { useEffect, useState } from "react";
import { api, fmtTime, type RealTrade } from "../api";

type UnifiedTrade = {
  id: string;
  closedAt: number | null;
  openedAt: number;
  symbol: string;
  side: "BUY" | "SELL";
  detector: string;
  stake: number;
  pnl: number | null;
  status: string; // "won" / "lost" / "open" / etc.
  raw: RealTrade;
};

function normaliseReal(t: RealTrade): UnifiedTrade {
  return {
    id: t.id,
    closedAt: t.closedAt,
    openedAt: t.openedAt,
    symbol: t.symbol,
    side: t.side,
    detector: t.detector,
    stake: t.stake,
    pnl: t.profit,
    status: t.status,
    raw: t,
  };
}

export function TradesPanel() {
  const [trades, setTrades] = useState<UnifiedTrade[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterStatus, setFilterStatus] = useState<"ALL" | "won" | "lost">("ALL");

  useEffect(() => {
    const load = async () => {
      try {
        const r = await api.trades(200);
        const merged = r.trades.map(normaliseReal).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
        setTrades(merged);
      } catch {
        // swallow — header banner shows server health
      }
    };
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const symbols = Array.from(new Set(trades.map((t) => t.symbol))).sort();

  const filtered = trades.filter((t) =>
    (filterSymbol === "ALL" || t.symbol === filterSymbol) &&
    (filterStatus === "ALL" || t.status === filterStatus),
  );

  const wins = filtered.filter((t) => (t.pnl ?? 0) > 0).length;
  const totalPnl = filtered.reduce((acc, t) => acc + (t.pnl ?? 0), 0);
  const wr = filtered.length > 0 ? wins / filtered.length : 0;

  return (
    <>
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-title">Filtered Trades</div>
          <div className="card-value">{filtered.length}</div>
          <div className="card-sub">of {trades.length} total</div>
        </div>
        <div className="card">
          <div className="card-title">Win Rate</div>
          <div className="card-value">{filtered.length > 0 ? `${(wr * 100).toFixed(0)}%` : "—"}</div>
          <div className="card-sub">{wins} W / {filtered.length - wins} L</div>
        </div>
        <div className="card">
          <div className="card-title">Net P&amp;L</div>
          <div className={`card-value ${totalPnl > 0 ? "pos" : totalPnl < 0 ? "neg" : "muted"}`}>
            {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
          </div>
        </div>
        <div className="card">
          <div className="card-title">Avg Stake</div>
          <div className="card-value">
            ${filtered.length > 0 ? (filtered.reduce((a, t) => a + t.stake, 0) / filtered.length).toFixed(2) : "0.00"}
          </div>
        </div>
      </div>

      <div className="card table-card">
        <div className="filters">
          <select className="filter-select" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)}>
            <option value="ALL">All symbols</option>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="filter-select" value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as "ALL" | "won" | "lost")}>
            <option value="ALL">Won + Lost</option>
            <option value="won">Won only</option>
            <option value="lost">Lost only</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <div className="empty"><span className="empty-emoji">$</span>No trades match the filter</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th><th>Closed</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>Profit</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <React.Fragment key={t.id}>
                  <tr onClick={() => setExpanded(expanded === t.id ? null : t.id)} style={{ cursor: "pointer" }}>
                    <td className="faint">{expanded === t.id ? "▼" : "▶"}</td>
                    <td className="mono faint">{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                    <td className="mono">{t.symbol}</td>
                    <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td><span className="strat-chip">{t.detector}</span></td>
                    <td className="mono">${t.stake.toFixed(2)}</td>
                    <td className={`mono ${(t.pnl ?? 0) > 0 ? "pos" : (t.pnl ?? 0) < 0 ? "neg" : "muted"}`}>
                      {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)}` : "—"}
                    </td>
                    <td>
                      <span className={`pill ${t.status === "won" ? "pill-green" : t.status === "lost" ? "pill-red" : "pill-blue"}`}>{t.status}</span>
                    </td>
                  </tr>
                  {expanded === t.id && (
                    <tr className="row-expand">
                      <td colSpan={8} style={{ padding: 0 }}>
                        <RealDetails t={t.raw} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function RealDetails({ t }: { t: RealTrade }) {
  return (
    <div className="detail-grid">
      <div><div className="detail-key">Contract ID</div><div className="detail-val mono">{t.contractId}</div></div>
      <div><div className="detail-key">Family</div><div className="detail-val">{t.family} · {t.contractType}</div></div>
      <div><div className="detail-key">Multiplier</div><div className="detail-val mono">{t.multiplier ?? "—"}×</div></div>
      <div><div className="detail-key">Buy Price</div><div className="detail-val mono">${t.buyPrice.toFixed(2)}</div></div>
      <div><div className="detail-key">Entry Spot</div><div className="detail-val mono">{t.entrySpot?.toFixed(5) ?? "—"}</div></div>
      <div><div className="detail-key">Exit Spot</div><div className="detail-val mono">{t.exitSpot?.toFixed(5) ?? "—"}</div></div>
      <div><div className="detail-key">Take Profit</div><div className="detail-val mono">{t.takeProfit != null ? `$${t.takeProfit.toFixed(2)}` : "—"}</div></div>
      <div><div className="detail-key">Stop Loss</div><div className="detail-val mono">{t.stopLoss != null ? `$${t.stopLoss.toFixed(2)}` : "—"}</div></div>
      <div><div className="detail-key">Opened At</div><div className="detail-val mono">{fmtTime(t.openedAt)}</div></div>
      <div><div className="detail-key">Closed At</div><div className="detail-val mono">{t.closedAt ? fmtTime(t.closedAt) : "—"}</div></div>
      <div><div className="detail-key">Currency</div><div className="detail-val">{t.currency}</div></div>
      <div><div className="detail-key">Trade ID</div><div className="detail-val mono">{t.id.slice(0, 8)}…</div></div>
    </div>
  );
}


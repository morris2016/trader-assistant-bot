// Closed trade history — most recent at top, filterable by asset.

import React, { useEffect, useState } from "react";
import { api } from "../../api";

function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

export function BinanceTradesPanel() {
  const [bs, setBs] = useState<any>(null);
  const [filter, setFilter] = useState<string>("");
  useEffect(() => {
    const refresh = async () => { try { setBs(await api.binanceState()); } catch {} };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const closed = (bs.state?.closed ?? []).slice().sort((a: any, b: any) => (b.closeEpoch ?? 0) - (a.closeEpoch ?? 0));
  const filtered = filter ? closed.filter((c: any) => c.asset === filter) : closed;
  const testnet = !!bs.testnet;

  const totalPnl = filtered.reduce((s: number, c: any) => s + (c.pnl ?? 0), 0);
  const wins = filtered.filter((c: any) => (c.pnl ?? 0) > 0).length;
  const losses = filtered.length - wins;
  const wr = filtered.length > 0 ? (wins / filtered.length) * 100 : 0;

  const assets = Array.from(new Set(closed.map((c: any) => c.asset))).sort() as string[];

  return (
    <>
      <div className="grid grid-4">
        <div className="card card-padded">
          <div className="card-title">Total trades</div>
          <div className="card-value">{filtered.length}</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Win rate</div>
          <div className="card-value">{wr.toFixed(1)}%</div>
          <div className="card-sub">{wins}W / {losses}L</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Total P&amp;L</div>
          <div className="card-value" style={{ color: totalPnl >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
          </div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Filter</div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "100%", background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "8px", borderRadius: 6 }}
          >
            <option value="">All assets ({closed.length})</option>
            {assets.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      <div className="section">
        <div className="section-header"><div className="section-title">Trade history</div></div>
        <div className="card card-padded">
          {filtered.length === 0 ? (
            <div className="muted">No closed trades yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Closed</th><th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Entry</th><th>Exit</th><th>Stake</th><th>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((t: any) => (
                  <tr key={t.id}>
                    <td className="muted">{t.closeEpoch ? new Date(t.closeEpoch * 1000).toISOString().slice(5, 16).replace("T", " ") : "—"}</td>
                    <td className="mono">
                      <a
                        href={binanceUrl(t.asset, testnet)}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={`Open ${t.asset} on Binance Futures`}
                        style={{ color: "#7fb3ff", textDecoration: "none" }}
                      >
                        {t.asset} ↗
                      </a>
                    </td>
                    <td>{t.pattern}</td>
                    <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                    <td className="mono">${(+(t.closePrice ?? 0)).toFixed(5)}</td>
                    <td className="mono">${(+t.stake).toFixed(2)}</td>
                    <td className="mono" style={{ color: (t.pnl ?? 0) >= 0 ? "#5fd4a4" : "#d4655f" }}>
                      {(t.pnl ?? 0) >= 0 ? "+" : ""}${(+t.pnl).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

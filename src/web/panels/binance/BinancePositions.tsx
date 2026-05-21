// Open positions table — currently-held Binance trades with live peak,
// armed status, and unrealized P&L.

import React, { useEffect, useState } from "react";
import { api } from "../../api";

export function BinancePositionsPanel() {
  const [bs, setBs] = useState<any>(null);
  useEffect(() => {
    const refresh = async () => { try { setBs(await api.binanceState()); } catch {} };
    refresh();
    const id = setInterval(refresh, 3000);
    return () => clearInterval(id);
  }, []);

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const open = bs.state?.open ?? [];

  return (
    <div className="section">
      <div className="section-header">
        <div className="section-title">Open positions ({open.length})</div>
        <div className="section-sub">Real-time peak tracking. Trail-arm fires after +1×ATR; exits at peak − 0.3×ATR via MARKET reduce-only.</div>
      </div>
      <div className="card card-padded">
        {open.length === 0 ? (
          <div className="muted">No open positions.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Asset</th><th>Pattern</th><th>Side</th>
                <th>Stake</th><th>Lev</th>
                <th>Entry</th><th>Peak</th><th>Δ%</th>
                <th>Armed</th><th>Opened</th>
              </tr>
            </thead>
            <tbody>
              {open.map((t: any) => {
                const pct = ((+t.peakFav - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                return (
                  <tr key={t.id}>
                    <td className="mono">{t.asset}</td>
                    <td>{t.pattern}</td>
                    <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td className="mono">${(+t.stake).toFixed(2)}</td>
                    <td className="mono">{t.leverage}×</td>
                    <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                    <td className="mono">${(+t.peakFav).toFixed(5)}</td>
                    <td className="mono" style={{ color: pct >= 0 ? "#5fd4a4" : "#d4655f" }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</td>
                    <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                    <td className="muted">{new Date(t.entryEpoch * 1000).toISOString().slice(11, 16)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

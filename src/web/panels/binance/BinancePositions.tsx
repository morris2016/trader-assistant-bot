// Open positions table — currently-held Binance trades with live peak,
// armed status, and unrealized P&L.

import React, { useEffect, useState } from "react";
import { api, fmtEatTime } from "../../api";

function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

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
  const testnet = !!bs.testnet;

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
                <th>Entry</th><th>Mark</th><th>Peak</th>
                <th title="Live % from entry to current mark, signed by side">Δ%</th>
                <th title="Unrealized $ P&L on this position">uPnL</th>
                <th>Armed</th><th>Opened (EAT)</th>
              </tr>
            </thead>
            <tbody>
              {open.map((t: any) => {
                const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
                const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                const peakPct = ((+t.peakFav - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                const uPnl = (+t.stake) * (+t.leverage) * (livePct / 100);
                return (
                  <tr key={t.id}>
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
                    <td className="mono">${(+t.stake).toFixed(2)}</td>
                    <td className="mono">{t.leverage}×</td>
                    <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                    <td className="mono" title="Live mark price">${mark.toFixed(5)}</td>
                    <td className="mono muted" title={`Peak favorable: ${peakPct >= 0 ? "+" : ""}${peakPct.toFixed(2)}%`}>${(+t.peakFav).toFixed(5)}</td>
                    <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%</td>
                    <td className="mono" style={{ color: uPnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</td>
                    <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                    <td className="muted">{fmtEatTime(t.entryEpoch)}</td>
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

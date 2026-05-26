// Closed 1h SMC trade history — most recent at top, filterable by asset.
// HF (15m BB_*) trades are excluded — see the HF tab for those.
//
// P&L source: prefers EXCHANGE-TRUTH (realizedPnlExchange − commissions)
// when the user-data stream has populated it; falls back to the bot's local
// estimate (stake × leverage × pctMove, NO fees). Rows fed by local estimate
// are tagged "est" so it's clear when the displayed value isn't broker-verified.

import React, { useEffect, useState } from "react";
import { api, fmtEatTime, fmtEatDateTime } from "../../api";

// Live + legacy HF pattern names (legacy BB_* kept so old closed trades still
// classify as HF in the trades log).
const HF_PATTERNS = new Set(["M1", "M2", "M3", "M4", "M5", "BB_UP_SHORT", "BB_LOW_LONG"]);
function isHf(p: string): boolean { return HF_PATTERNS.has(p); }

function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

/** Resolve a closed trade's P&L. Prefers exchange-truth when available. */
function resolvePnl(t: any): { value: number; source: "broker" | "est" } {
  if (typeof t.realizedPnlExchange === "number") {
    const ec = t.commissionEntry ?? 0;
    const xc = t.commissionExit ?? 0;
    return { value: t.realizedPnlExchange - ec - xc, source: "broker" };
  }
  return { value: t.pnl ?? 0, source: "est" };
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

  // Filter to 1h SMC patterns only — HF (BB_*) goes on the HF tab
  const closedAll = ((bs.state?.closed ?? []) as any[]).filter((c) => !isHf(c.pattern));
  const closed = closedAll.slice().sort((a: any, b: any) => (b.closeEpoch ?? 0) - (a.closeEpoch ?? 0));
  const filtered = filter ? closed.filter((c: any) => c.asset === filter) : closed;
  const testnet = !!bs.testnet;

  const pnls = filtered.map(resolvePnl);
  const totalPnl = pnls.reduce((s, p) => s + p.value, 0);
  const brokerCount = pnls.filter(p => p.source === "broker").length;
  const wins = pnls.filter(p => p.value > 0).length;
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
          <div className="card-sub">{brokerCount}/{filtered.length} broker-verified</div>
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
                  <th>Closed (EAT)</th><th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Entry</th><th>Exit</th><th>Stake</th>
                  <th title="Exchange-verified P&L (realized − commissions). Rows tagged 'est' use the bot's local estimate (fees not included) because the user-data stream hasn't reported real fill yet.">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((t: any) => {
                  const p = resolvePnl(t);
                  return (
                    <tr key={t.id}>
                      <td className="muted">{t.closeEpoch ? fmtEatDateTime(t.closeEpoch) : "—"}</td>
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
                      <td className="mono" style={{ color: p.value >= 0 ? "#5fd4a4" : "#d4655f" }}>
                        {p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}
                        {p.source === "est" && <span title="Local estimate — fees not deducted, no broker confirmation yet" style={{ marginLeft: 6, color: "#d4a35f", fontSize: 10, fontWeight: 500 }}>est</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

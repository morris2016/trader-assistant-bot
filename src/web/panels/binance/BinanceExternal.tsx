// External positions tab — positions held on Binance Futures that the
// bot is NOT tracking in its local open[]. Sources: manual trades placed
// directly on Binance, zombies left from older bot versions / past bugs,
// or trades whose local state file was lost.
//
// Display + Cancel only. The bot does not try to manage these (no trail,
// no auto-close). Cancel issues a reduce-only MARKET for the un-tracked
// portion.

import React, { useEffect, useState } from "react";
import { api, fmtEatDateTime } from "../../api";

type ExternalPosition = {
  symbol: string; positionSide: "LONG" | "SHORT";
  qty: number; entryPrice: number; markPrice: number;
  unRealizedProfit: number; leverage: number;
  liquidationPrice: number; updateTime: number;
  botQty: number; externalQty: number;
};

function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

export function BinanceExternalPanel() {
  const [bs, setBs] = useState<any>(null);
  const [positions, setPositions] = useState<ExternalPosition[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [closeMsg, setCloseMsg] = useState<string | null>(null);

  async function refresh() {
    try { setBs(await api.binanceState()); } catch {}
    try {
      const r = await api.binanceExternalPositions();
      setPositions(r.positions);
      setErr(null);
    } catch (e: any) {
      setErr(e?.message ?? "fetch failed");
    }
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const testnet = !!bs.testnet;
  const totalUnPnl = positions.reduce((s, p) => s + p.unRealizedProfit, 0);

  async function doClose(p: ExternalPosition) {
    const key = `${p.symbol}:${p.positionSide}`;
    setBusy((b) => ({ ...b, [key]: true }));
    setCloseMsg(null);
    try {
      const r = await api.binanceCloseExternal(p.symbol, p.positionSide, p.externalQty);
      setCloseMsg(r.ok ? `Closed ${p.symbol} ${p.positionSide} ${p.externalQty}` : `Close failed: ${r.error}`);
      if (r.ok) refresh();
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n; });
      setTimeout(() => setCloseMsg(null), 5000);
    }
  }

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">External Binance positions ({positions.length})</div>
          <div className="section-sub">
            Positions on Binance Futures that the bot is NOT actively trailing.
            Sources: manual trades you placed directly on Binance, or untracked
            portions of bot positions (e.g., from older bot versions). The bot
            won't auto-close these — use Cancel to issue a reduce-only MARKET
            on the un-tracked qty.
          </div>
        </div>
        {err && <div className="banner banner-warn" style={{ marginBottom: 8 }}>⚠ {err}</div>}
        {closeMsg && <div className="banner banner-info" style={{ marginBottom: 8 }}>{closeMsg}</div>}
        <div className="grid grid-2" style={{ marginBottom: 12 }}>
          <div className="card card-padded">
            <div className="card-title">External count</div>
            <div className="card-value">{positions.length}</div>
            <div className="card-sub">Sum of all symbols × sides with un-tracked qty</div>
          </div>
          <div className="card card-padded">
            <div className="card-title">Total unrealized P&amp;L (external)</div>
            <div className="card-value" style={{ color: totalUnPnl >= 0 ? "#5fd4a4" : "#d4655f" }}>
              {totalUnPnl >= 0 ? "+" : ""}${totalUnPnl.toFixed(2)}
            </div>
            <div className="card-sub">Live from /fapi/v2/positionRisk</div>
          </div>
        </div>
        <div className="card card-padded">
          {positions.length === 0 ? (
            <div className="muted">No external positions detected. Every Binance position is fully tracked by the bot.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th><th>Side</th>
                  <th>Total qty</th><th>Bot tracks</th><th>External</th>
                  <th>Lev</th>
                  <th>Entry</th><th>Mark</th><th>Liq</th>
                  <th>uPnL</th>
                  <th>Last updated (EAT)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => {
                  const key = `${p.symbol}:${p.positionSide}`;
                  const livePct = ((p.markPrice - p.entryPrice) / p.entryPrice) * 100 * (p.positionSide === "LONG" ? 1 : -1);
                  const distToLiq = p.liquidationPrice > 0
                    ? Math.abs((p.markPrice - p.liquidationPrice) / p.markPrice) * 100
                    : null;
                  const liqColor = distToLiq == null ? "#888"
                    : distToLiq < 1 ? "#d4655f"
                    : distToLiq < 3 ? "#d4a35f"
                    : "#5fd4a4";
                  return (
                    <tr key={key}>
                      <td className="mono">
                        <a href={binanceUrl(p.symbol, testnet)} target="_blank" rel="noopener noreferrer"
                           style={{ color: "#7fb3ff", textDecoration: "none" }}>
                          {p.symbol} ↗
                        </a>
                      </td>
                      <td><span className={`pill ${p.positionSide === "LONG" ? "pill-green" : "pill-red"}`}>{p.positionSide}</span></td>
                      <td className="mono">{p.qty.toFixed(4)}</td>
                      <td className="mono muted">{p.botQty.toFixed(4)}</td>
                      <td className="mono" style={{ fontWeight: 600 }}>{p.externalQty.toFixed(4)}</td>
                      <td className="mono">{p.leverage}×</td>
                      <td className="mono">${p.entryPrice.toFixed(5)}</td>
                      <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f" }}>
                        ${p.markPrice.toFixed(5)} <span style={{ fontSize: 11 }}>({livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%)</span>
                      </td>
                      <td className="mono" style={{ color: liqColor }} title={distToLiq != null ? `${distToLiq.toFixed(2)}% to liq` : ""}>
                        {p.liquidationPrice > 0 ? `$${p.liquidationPrice.toFixed(5)}` : "—"}
                      </td>
                      <td className="mono" style={{ color: p.unRealizedProfit >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
                        {p.unRealizedProfit >= 0 ? "+" : ""}${p.unRealizedProfit.toFixed(4)}
                      </td>
                      <td className="muted">{fmtEatDateTime(Math.floor(p.updateTime / 1000))}</td>
                      <td>
                        <button
                          className="btn btn-warn"
                          disabled={!!busy[key]}
                          onClick={() => doClose(p)}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                          title={`MARKET ${p.positionSide === "LONG" ? "SELL" : "BUY"} ${p.externalQty.toFixed(4)} reduce-only`}
                        >
                          {busy[key] ? "…" : "Cancel"}
                        </button>
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

// Binance Overview — quick-glance dashboard for the crypto engine.
//   - USDT balance + available
//   - Engine state (creds/running/testnet)
//   - Daily P&L + trade counts
//   - Top performing assets today

import React, { useEffect, useState } from "react";
import { api, eatToday, eatDateOf } from "../../api";

export function BinanceOverviewPanel() {
  const [bs, setBs] = useState<any>(null);
  const [test, setTest] = useState<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string } | null>(null);
  useEffect(() => {
    const refresh = async () => { try { setBs(await api.binanceState()); } catch {} };
    refresh();
    const id = setInterval(refresh, 4000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    // Read balance on mount (separate from state poll so it doesn't spam Binance)
    const fetchBal = async () => { try { setTest(await api.binanceTest()); } catch {} };
    if (bs?.hasCreds) {
      fetchBal();
      const id = setInterval(fetchBal, 30_000);
      return () => clearInterval(id);
    }
  }, [bs?.hasCreds]);

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) {
    return (
      <div className="banner banner-warn">
        No Binance credentials configured. Go to <b>Settings</b> to set up.
      </div>
    );
  }

  const state = bs.state ?? {};
  const today = eatToday();
  const closedToday = (state.closed ?? []).filter((c: any) => c.closeEpoch && eatDateOf(c.closeEpoch) === today);
  const winsToday = closedToday.filter((c: any) => (c.pnl ?? 0) > 0).length;
  const lossesToday = closedToday.filter((c: any) => (c.pnl ?? 0) <= 0).length;
  const dailyProfit = closedToday.reduce((s: number, c: any) => s + (c.pnl ?? 0), 0);

  // Top assets today by realized P&L
  const byAsset = new Map<string, { n: number; pnl: number }>();
  for (const c of closedToday) {
    const e = byAsset.get(c.asset) ?? { n: 0, pnl: 0 };
    e.n++;
    e.pnl += c.pnl ?? 0;
    byAsset.set(c.asset, e);
  }
  const topAssets = Array.from(byAsset.entries()).sort((a, b) => b[1].pnl - a[1].pnl);

  return (
    <>
      <div className="grid grid-4">
        <div className="card card-padded">
          <div className="card-title">USDT Balance</div>
          <div className="card-value">${(test?.balanceUsdt ?? 0).toFixed(2)}</div>
          <div className="card-sub">Available ${(test?.available ?? 0).toFixed(2)}</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Today's P&amp;L</div>
          <div className="card-value" style={{ color: dailyProfit >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {dailyProfit >= 0 ? "+" : ""}${dailyProfit.toFixed(2)}
          </div>
          <div className="card-sub">{winsToday}W / {lossesToday}L</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Open Positions</div>
          <div className="card-value">{state.open?.length ?? 0}</div>
          <div className="card-sub">{state.daily?.tradesOpened ?? 0} opened today</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Engine</div>
          <div className="card-value" style={{ fontSize: 18, color: bs.running ? "#5fd4a4" : "#8a95b8" }}>
            {bs.running ? "● Running" : "○ Stopped"}
          </div>
          <div className="card-sub">{bs.testnet ? "TESTNET" : "LIVE"}</div>
        </div>
      </div>

      {topAssets.length > 0 && (
        <div className="section">
          <div className="section-header"><div className="section-title">Today's leaders</div></div>
          <div className="card card-padded">
            <table className="table">
              <thead><tr><th>Asset</th><th>Trades</th><th>P&amp;L</th></tr></thead>
              <tbody>
                {topAssets.slice(0, 10).map(([asset, r]) => (
                  <tr key={asset}>
                    <td className="mono">{asset}</td>
                    <td className="mono">{r.n}</td>
                    <td className="mono" style={{ color: r.pnl >= 0 ? "#5fd4a4" : "#d4655f" }}>{r.pnl >= 0 ? "+" : ""}${r.pnl.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

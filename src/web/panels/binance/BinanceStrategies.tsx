// Per-(asset, pattern) stats matrix. Each cell shows trades + WR + PnL.
// Helps spot underperforming pairs at a glance.

import React, { useEffect, useState } from "react";
import { api, type BinanceConfig } from "../../api";

const ASSETS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
  "UNIUSDT", "AAVEUSDT", "LINKUSDT", "DOGEUSDT", "AVAXUSDT",
  "LDOUSDT", "ADAUSDT", "DOTUSDT", "BCHUSDT", "POLUSDT",
];
const PATTERNS = ["OB_BULL", "OB_BEAR", "BOS_UP"] as const;

export function BinanceStrategiesPanel() {
  const [bs, setBs] = useState<any>(null);
  const [config, setConfig] = useState<BinanceConfig | null>(null);
  useEffect(() => {
    const refresh = async () => {
      try { setBs(await api.binanceState()); } catch {}
      try { const c = await api.binanceConfig(); setConfig(c.config); } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function toggleAsset(asset: string, enabled: boolean) {
    if (!config) return;
    const next = { ...config.perAssetEnabled, [asset]: enabled };
    await api.binanceUpdateConfig({ perAssetEnabled: next });
    setConfig({ ...config, perAssetEnabled: next });
  }
  async function togglePattern(pattern: "OB_BULL" | "OB_BEAR" | "BOS_UP", enabled: boolean) {
    if (!config) return;
    const next = { ...config.perPatternEnabled, [pattern]: enabled };
    await api.binanceUpdateConfig({ perPatternEnabled: next });
    setConfig({ ...config, perPatternEnabled: next });
  }

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const closed = (bs.state?.closed ?? []) as any[];
  // Group by (asset, pattern)
  const matrix = new Map<string, { n: number; w: number; pnl: number }>();
  for (const t of closed) {
    const k = `${t.asset}|${t.pattern}`;
    const e = matrix.get(k) ?? { n: 0, w: 0, pnl: 0 };
    e.n++;
    if ((t.pnl ?? 0) > 0) e.w++;
    e.pnl += t.pnl ?? 0;
    matrix.set(k, e);
  }

  // Per-asset totals
  const byAsset = new Map<string, { n: number; w: number; pnl: number }>();
  for (const t of closed) {
    const e = byAsset.get(t.asset) ?? { n: 0, w: 0, pnl: 0 };
    e.n++;
    if ((t.pnl ?? 0) > 0) e.w++;
    e.pnl += t.pnl ?? 0;
    byAsset.set(t.asset, e);
  }

  // Per-pattern totals
  const byPattern = new Map<string, { n: number; w: number; pnl: number }>();
  for (const t of closed) {
    const e = byPattern.get(t.pattern) ?? { n: 0, w: 0, pnl: 0 };
    e.n++;
    if ((t.pnl ?? 0) > 0) e.w++;
    e.pnl += t.pnl ?? 0;
    byPattern.set(t.pattern, e);
  }

  const cellStyle = (n: number, pnl: number): React.CSSProperties => {
    if (n === 0) return { color: "#3a4660", fontSize: 11 };
    return { color: pnl >= 0 ? "#5fd4a4" : "#d4655f", fontSize: 11 };
  };

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">Per-asset performance</div>
          <div className="section-sub">Total trades, WR, P&amp;L for each of 15 crypto symbols since engine started.</div>
        </div>
        <div className="card card-padded">
          <table className="table">
            <thead><tr><th>On</th><th>Asset</th><th>OB_BULL</th><th>OB_BEAR</th><th>BOS_UP</th><th>Total trades</th><th>Total P&amp;L</th></tr></thead>
            <tbody>
              {ASSETS.map((asset) => {
                const totals = byAsset.get(asset);
                const enabled = config?.perAssetEnabled[asset] !== false;
                return (
                  <tr key={asset} style={{ opacity: enabled ? 1 : 0.4 }}>
                    <td>
                      <input
                        type="checkbox"
                        checked={enabled}
                        onChange={(e) => toggleAsset(asset, e.target.checked)}
                      />
                    </td>
                    <td className="mono">{asset}</td>
                    {PATTERNS.map((p) => {
                      const c = matrix.get(`${asset}|${p}`);
                      if (!c || c.n === 0) return <td key={p} className="muted" style={{ fontSize: 11 }}>—</td>;
                      const wr = (c.w / c.n) * 100;
                      return (
                        <td key={p} className="mono" style={cellStyle(c.n, c.pnl)}>
                          {c.n}t · {wr.toFixed(0)}% · {c.pnl >= 0 ? "+" : ""}${c.pnl.toFixed(1)}
                        </td>
                      );
                    })}
                    <td className="mono">{totals?.n ?? 0}</td>
                    <td className="mono" style={cellStyle(totals?.n ?? 0, totals?.pnl ?? 0)}>
                      {totals ? `${totals.pnl >= 0 ? "+" : ""}$${totals.pnl.toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: "2px solid #1e2842", fontSize: 11 }}>
                <td></td>
                <td className="muted">Pattern on/off →</td>
                {PATTERNS.map((p) => (
                  <td key={p}>
                    <input
                      type="checkbox"
                      checked={config?.perPatternEnabled[p] !== false}
                      onChange={(e) => togglePattern(p, e.target.checked)}
                    />
                    <span style={{ marginLeft: 6 }}>{config?.perPatternEnabled[p] !== false ? "on" : "off"}</span>
                  </td>
                ))}
                <td></td><td></td>
              </tr>
              <tr style={{ borderTop: "2px solid #1e2842", fontWeight: 600 }}>
                <td></td>
                <td>Pattern total</td>
                {PATTERNS.map((p) => {
                  const c = byPattern.get(p);
                  if (!c) return <td key={p} className="muted">—</td>;
                  return (
                    <td key={p} className="mono" style={cellStyle(c.n, c.pnl)}>
                      {c.n}t · {((c.w / c.n) * 100).toFixed(0)}% · {c.pnl >= 0 ? "+" : ""}${c.pnl.toFixed(0)}
                    </td>
                  );
                })}
                <td className="mono">{closed.length}</td>
                <td className="mono" style={{ color: closed.reduce((s: number, c: any) => s + (c.pnl ?? 0), 0) >= 0 ? "#5fd4a4" : "#d4655f" }}>
                  {closed.reduce((s: number, c: any) => s + (c.pnl ?? 0), 0) >= 0 ? "+" : ""}${closed.reduce((s: number, c: any) => s + (c.pnl ?? 0), 0).toFixed(2)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Strategy reference</div>
        </div>
        <div className="card card-padded">
          <div className="kv-list">
            <div className="kv-row"><div className="kv-key">OB_BULL</div><div className="kv-val">Bullish Order Block. Bearish candle precedes ≥1×ATR up-displacement; entry on retrace into OB zone.</div></div>
            <div className="kv-row"><div className="kv-key">OB_BEAR</div><div className="kv-val">Bearish Order Block. Bullish candle precedes ≥1×ATR down-displacement; entry on retrace.</div></div>
            <div className="kv-row"><div className="kv-key">BOS_UP</div><div className="kv-val">Break of Structure up. Close above most recent confirmed swing high (5-bar swings).</div></div>
            <div className="kv-row"><div className="kv-key">Direction rule</div><div className="kv-val">Trained: bullish patterns LONG if 50-bar SMA up/flat else SHORT (failed move); OB_BEAR mirrored.</div></div>
            <div className="kv-row"><div className="kv-key">Exit</div><div className="kv-val">Trail-armed at +1×ATR favorable; MARKET reduce-only when price retraces to peak − 0.3×ATR.</div></div>
            <div className="kv-row"><div className="kv-key">Risk</div><div className="kv-val">Flat $15 stake, 30× leverage, no martingale, hedge mode (separate LONG/SHORT per asset).</div></div>
          </div>
        </div>
      </div>
    </>
  );
}

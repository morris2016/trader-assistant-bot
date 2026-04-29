// Control-experiment panel. Shows the no-trade signal stream from
// CONTROL_ASSETS (currently 1HZ100V on 1m + 15m with loose detector params).
// Purpose: verify the signal pipeline is alive without affecting any account.

import React, { useEffect, useState } from "react";
import { api, fmtTime, type Signal } from "../api";

type ControlAsset = { symbol: string; granularity: number; label: string };
type DiagRow = {
  key: string;
  symbol: string;
  granularity: number;
  lastCandleAtMs: number | null;
  engine: {
    bars: number;
    lastEpoch: number | null;
    barIndex: number;
    atr: number;
    detectors: Record<string, { enabled: boolean; activeCount: number; unmitigatedCount: number }>;
  };
};

export function ControlPanel() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [assets, setAssets] = useState<ControlAsset[]>([]);
  const [diag, setDiag] = useState<DiagRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [c, d] = await Promise.all([api.controlSignals(200), api.diag()]);
        setSignals(c.signals);
        setAssets(c.controlAssets);
        setDiag(d.diagnostics);
        setError(null);
      } catch (e) { setError((e as Error).message); }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  if (error && signals.length === 0) return <div className="banner banner-danger">⚠ {error}</div>;

  const controlSyms = new Set(assets.map((a) => a.symbol));
  const controlDiag = diag.filter((d) => controlSyms.has(d.symbol));

  return (
    <>
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Control Experiment</strong> — these assets generate signals only.
        They do NOT open paper or real positions. Loose detector params
        (FVG minGap=0.03, OB displacement=0.3, sweep eqTol=0.30) maximize
        signal frequency so we can verify the engine pipeline end-to-end.
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Subscribed Control Assets ({assets.length})</div>
        </div>
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Asset</th><th>TF</th><th>Bars</th><th>Last bar</th><th>Last candle arr.</th><th>ATR</th><th>Active OB</th><th>Active FVG</th><th>Active Sweep</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const d = controlDiag.find((x) => x.symbol === a.symbol && x.granularity === a.granularity);
                if (!d) return (
                  <tr key={`${a.symbol}|${a.granularity}`}>
                    <td><strong>{a.label}</strong><div className="card-sub" style={{ marginTop: 2 }}>{a.symbol}</div></td>
                    <td className="mono">{a.granularity / 60}m</td>
                    <td colSpan={7} className="muted">Not yet subscribed…</td>
                  </tr>
                );
                const ob = d.engine.detectors.orderBlock;
                const fvg = d.engine.detectors.fvg;
                const sw = d.engine.detectors.liquiditySweep;
                return (
                  <tr key={d.key}>
                    <td><strong>{a.label}</strong><div className="card-sub" style={{ marginTop: 2 }}>{a.symbol}</div></td>
                    <td className="mono">{a.granularity / 60}m</td>
                    <td className="mono">{d.engine.bars}</td>
                    <td className="mono faint">{d.engine.lastEpoch ? fmtTime(d.engine.lastEpoch * 1000) : "—"}</td>
                    <td className="mono faint">{d.lastCandleAtMs ? fmtTime(d.lastCandleAtMs) : "—"}</td>
                    <td className="mono">{d.engine.atr.toFixed(4)}</td>
                    <td className="mono">{ob.enabled ? `${ob.unmitigatedCount}/${ob.activeCount}` : "—"}</td>
                    <td className="mono">{fvg.enabled ? `${fvg.unmitigatedCount}/${fvg.activeCount}` : "—"}</td>
                    <td className="mono">{sw.enabled ? `${sw.unmitigatedCount}/${sw.activeCount}` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="card-sub" style={{ padding: "8px 16px" }}>
            "Active OB/FVG/Sweep" shows <em>unmitigated/total</em> — only unmitigated zones can fire signals on retest.
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Control Signals ({signals.length})</div>
          <div className="section-sub">Most recent first · no trades placed</div>
        </div>
        <div className="card table-card">
          {signals.length === 0 ? (
            <div className="empty">
              <span className="empty-emoji">⚡</span>
              No control signals yet. Pipeline test in progress — wait for the next bar boundary on 1m/15m.
            </div>
          ) : (
            <table>
              <thead>
                <tr><th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Confidence</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {signals.slice(0, 200).map((s) => (
                  <tr key={s.id}>
                    <td className="mono faint">{fmtTime(s.emittedAt)}</td>
                    <td className="mono">{s.symbol}</td>
                    <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
                    <td><span className="strat-chip">{s.detector}</span></td>
                    <td className="mono">{(s.confidence * 100).toFixed(0)}%</td>
                    <td className="mono faint">{s.reason ?? ""}</td>
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

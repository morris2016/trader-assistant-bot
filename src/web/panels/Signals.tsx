import React, { useEffect, useState } from "react";
import { api, fmtTime, type Signal } from "../api";

export function SignalsPanel() {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [filterSymbol, setFilterSymbol] = useState<string>("ALL");
  const [filterSide, setFilterSide] = useState<"ALL" | "BUY" | "SELL">("ALL");
  const [filterDetector, setFilterDetector] = useState<string>("ALL");

  useEffect(() => {
    const load = () => api.signals(200).then((r) => setSignals(r.signals)).catch(() => {});
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  const symbols = Array.from(new Set(signals.map((s) => s.symbol))).sort();
  const detectors = Array.from(new Set(signals.map((s) => s.detector))).sort();

  const filtered = signals.filter((s) =>
    (filterSymbol === "ALL" || s.symbol === filterSymbol) &&
    (filterSide === "ALL" || s.action === filterSide) &&
    (filterDetector === "ALL" || s.detector === filterDetector)
  );

  return (
    <div className="card table-card">
      <div className="filters">
        <select className="filter-select" value={filterSymbol} onChange={(e) => setFilterSymbol(e.target.value)}>
          <option value="ALL">All symbols</option>
          {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="filter-select" value={filterSide} onChange={(e) => setFilterSide(e.target.value as any)}>
          <option value="ALL">Both sides</option>
          <option value="BUY">BUY only</option>
          <option value="SELL">SELL only</option>
        </select>
        <select className="filter-select" value={filterDetector} onChange={(e) => setFilterDetector(e.target.value)}>
          <option value="ALL">All detectors</option>
          {detectors.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <span className="muted" style={{ marginLeft: "auto", fontSize: 11 }}>
          {filtered.length} of {signals.length} signals
        </span>
      </div>
      {filtered.length === 0 ? (
        <div className="empty"><span className="empty-emoji">⚡</span>No signals match the filter</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Conf.</th><th>Reason</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => (
              <tr key={s.id}>
                <td className="mono faint">{fmtTime(s.emittedAt)}</td>
                <td className="mono">{s.symbol}</td>
                <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
                <td><span className="strat-chip">{s.detector}</span></td>
                <td className="mono">{(s.confidence * 100).toFixed(0)}%</td>
                <td className="muted">{s.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

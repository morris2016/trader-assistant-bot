import React from "react";
import { fmtAgo, fmtGranularity, type StrategyStats } from "../api";

export function StrategiesPanel({ strategies }: { strategies: StrategyStats[] }) {
  return (
    <div className="card table-card">
      <table>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Symbol(s)</th>
            <th>TF</th>
            <th>Validated</th>
            <th>Live signals</th>
            <th>Live trades</th>
            <th>Live WR</th>
            <th>Live P&amp;L</th>
            <th>Last signal</th>
            <th>Last trade</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => (
            <tr key={s.id}>
              <td>
                <div className="bold">{s.id}</div>
                <div className="faint" style={{ fontSize: 11, marginTop: 2 }}>{s.name}</div>
              </td>
              <td className="mono">{s.symbols.join(", ")}</td>
              <td><span className="strat-chip">{fmtGranularity(s.granularity)}</span></td>
              <td className="muted">
                {s.validation.expectancyR != null && <>{s.validation.expectancyR.toFixed(2)}R · </>}
                {s.validation.winRate != null && <>{(s.validation.winRate * 100).toFixed(0)}% · </>}
                {s.validation.pnlUsd != null && <>${s.validation.pnlUsd.toFixed(0)}</>}
              </td>
              <td className="mono">{s.live.signals}</td>
              <td className="mono">{s.live.trades}</td>
              <td className="mono">{s.live.trades > 0 ? `${(s.live.winRate * 100).toFixed(0)}%` : "—"}</td>
              <td className={`mono ${s.live.pnlUsd > 0 ? "pos" : s.live.pnlUsd < 0 ? "neg" : "muted"}`}>
                {s.live.pnlUsd >= 0 ? "+" : ""}${s.live.pnlUsd.toFixed(2)}
              </td>
              <td className="faint">{fmtAgo(s.live.lastSignalAt)}</td>
              <td className="faint">{fmtAgo(s.live.lastTradeAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

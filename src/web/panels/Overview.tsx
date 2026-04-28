import React from "react";
import { api, fmtUptime, fmtAgo, type StateResp, type StrategyStats } from "../api";

export function OverviewPanel({ state, strategies, doAction, pending }: {
  state: StateResp;
  strategies: StrategyStats[];
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const balance = state.account?.balance ?? 0;
  const dailyPnl = state.daily.profit;
  const dailyClass = dailyPnl > 0 ? "pos" : dailyPnl < 0 ? "neg" : "muted";
  const adaptive = state.adaptiveShiftDescription;
  const adaptiveOk = adaptive === "normal";

  // Aggregate live stats across all strategies
  const totalLive = strategies.reduce(
    (acc, s) => ({
      signals: acc.signals + s.live.signals,
      trades: acc.trades + s.live.trades,
      wins: acc.wins + s.live.wins,
      pnl: acc.pnl + s.live.pnlUsd,
    }),
    { signals: 0, trades: 0, wins: 0, pnl: 0 },
  );
  const liveWR = totalLive.trades > 0 ? totalLive.wins / totalLive.trades : 0;

  return (
    <>
      {/* Top stat grid */}
      <div className="grid grid-4">
        <div className="card">
          <div className="card-title">Balance</div>
          <div className="card-value">${balance.toFixed(2)}</div>
          <div className="card-sub">{state.account?.currency ?? "—"}</div>
        </div>
        <div className="card">
          <div className="card-title">Daily P&amp;L</div>
          <div className={`card-value ${dailyClass}`}>{dailyPnl >= 0 ? "+" : ""}${dailyPnl.toFixed(2)}</div>
          <div className="card-sub">{state.daily.tradesOpened} opened today {state.daily.capHit && "· CAP HIT"}</div>
        </div>
        <div className="card">
          <div className="card-title">Open / Closed</div>
          <div className="card-value">{state.openCount} <span className="faint">/ {state.totalClosed}</span></div>
          <div className="card-sub">{totalLive.signals} signals total · WR {(liveWR * 100).toFixed(0)}%</div>
        </div>
        <div className="card">
          <div className="card-title">Adaptive Shift</div>
          <div className="card-value" style={{ fontSize: 16 }}>
            {adaptiveOk ? <span className="pos">normal</span> : <span className="amber">{adaptive}</span>}
          </div>
          <div className="card-sub">
            {state.adaptiveShift.consecLosses > 0 ? `${state.adaptiveShift.consecLosses}L streak` : "no streak"} · uptime {fmtUptime(state.health.uptimeSec)}
          </div>
        </div>
      </div>

      {/* Strategy strip */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Strategy Activity</div>
          <div className="section-sub">{strategies.length} registered strategies</div>
        </div>
        <div className="grid grid-3">
          {strategies.map((s) => (
            <div className="card" key={s.id}>
              <div className="row">
                <span className="strat-chip">{s.id}</span>
                <span className="spacer" />
                <span className={`pill ${s.live.pnlUsd > 0 ? "pill-green" : s.live.pnlUsd < 0 ? "pill-red" : "pill-blue"}`}>
                  {s.live.pnlUsd >= 0 ? "+" : ""}${s.live.pnlUsd.toFixed(2)}
                </span>
              </div>
              <div style={{ marginTop: 10 }}>
                <div className="row" style={{ gap: 18 }}>
                  <div>
                    <div className="card-title" style={{ marginBottom: 2 }}>signals</div>
                    <div className="bold">{s.live.signals}</div>
                  </div>
                  <div>
                    <div className="card-title" style={{ marginBottom: 2 }}>trades</div>
                    <div className="bold">{s.live.trades}</div>
                  </div>
                  <div>
                    <div className="card-title" style={{ marginBottom: 2 }}>WR</div>
                    <div className="bold">{s.live.trades > 0 ? `${(s.live.winRate * 100).toFixed(0)}%` : "—"}</div>
                  </div>
                </div>
                <div className="card-sub" style={{ marginTop: 10 }}>
                  last signal {fmtAgo(s.live.lastSignalAt)} · last trade {fmtAgo(s.live.lastTradeAt)}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick controls */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Quick Controls</div>
        </div>
        <div className="card">
          <div className="row">
            {state.paused ? (
              <button className="btn btn-primary" disabled={pending !== null} onClick={() => doAction("Resume trading", () => api.resume())}>
                ▶ Resume Trading
              </button>
            ) : (
              <button className="btn btn-warn" disabled={pending !== null} onClick={() => doAction("Pause trading", () => api.pause())}>
                ⏸ Pause Trading
              </button>
            )}
            <button className="btn" disabled={pending !== null} onClick={() => doAction("Reset adaptive shift state to clean", () => api.resetAdaptive())}>
              Reset Adaptive Shift
            </button>
            <button className="btn" disabled={pending !== null} onClick={() => doAction("Reset daily P&L tracking", () => api.resetDaily())}>
              Reset Daily P&amp;L
            </button>
            {pending && <span className="muted" style={{ marginLeft: "auto" }}>working: {pending}</span>}
          </div>
        </div>
      </div>
    </>
  );
}

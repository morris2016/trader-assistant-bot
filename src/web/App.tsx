import React, { useEffect, useState, useCallback } from "react";
import { api, type StateResp, type RealTrade, type Signal } from "./api";

const REFRESH_MS = 3000;

export function App() {
  const [state, setState] = useState<StateResp | null>(null);
  const [trades, setTrades] = useState<RealTrade[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, t, sg] = await Promise.all([api.state(), api.trades(100), api.signals(100)]);
      setState(s);
      setTrades(t.trades);
      setSignals(sg.signals);
      setLastFetch(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const doAction = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    if (!confirm(`${label}?`)) return;
    setActionPending(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    } finally {
      setActionPending(null);
    }
  }, [refresh]);

  const stale = Date.now() - lastFetch > REFRESH_MS * 2;

  return (
    <div className="app">
      <Header state={state} stale={stale} error={error} />

      {state && (
        <>
          <SummaryGrid state={state} />
          <Controls state={state} pending={actionPending} doAction={doAction} />
          <SignalsFeed signals={signals} />
          <TradesTable trades={trades} />
        </>
      )}
      {!state && !error && <SkeletonGrid />}
      {!state && error && <div className="card empty">⚠️ {error}</div>}

      <Footer state={state} />
    </div>
  );
}

function Header({ state, stale, error }: { state: StateResp | null; stale: boolean; error: string | null }) {
  const live = state?.health.wsConnected && state?.health.authorized;
  const status = error ? "dead" : stale ? "stale" : live ? "live" : "stale";
  const account = state?.account;
  return (
    <div className="header">
      <div>
        <div className="title"><span className="title-emoji">📈</span>Trader Bot</div>
        <div className="subtitle">
          {account ? (
            <>
              {account.loginid} · {account.currency} · {account.isVirtual ? "DEMO" : "LIVE"} · ${account.balance.toFixed(2)}
            </>
          ) : (
            "no account"
          )}
        </div>
      </div>
      <div className="row">
        {state && (
          <>
            <span className={`pill ${state.paused ? "pill-amber" : "pill-green"}`}>
              <span className="pill-dot" />
              {state.paused ? "PAUSED" : "ACTIVE"}
            </span>
            <span className={`refresh ${status}`}>{status === "live" ? "live" : status === "stale" ? "stale" : "down"}</span>
          </>
        )}
      </div>
    </div>
  );
}

function SummaryGrid({ state }: { state: StateResp }) {
  const balance = state.account?.balance ?? 0;
  const dailyPnl = state.daily.profit;
  const dailyClass = dailyPnl > 0 ? "pos" : dailyPnl < 0 ? "neg" : "muted";
  const adaptive = state.adaptiveShiftDescription;
  const adaptiveOk = adaptive === "normal";

  return (
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
        <div className="card-title">Open Positions</div>
        <div className="card-value">{state.openCount}</div>
        <div className="card-sub">{state.totalClosed} closed total</div>
      </div>
      <div className="card">
        <div className="card-title">Adaptive Shift</div>
        <div className={`card-value`} style={{ fontSize: 18 }}>
          {adaptiveOk ? <span className="pos">normal</span> : <span className="neg">{adaptive}</span>}
        </div>
        <div className="card-sub">
          {state.adaptiveShift.consecLosses > 0 ? `${state.adaptiveShift.consecLosses}L streak` : "no streak"}
          {" · "}
          uptime {fmtUptime(state.health.uptimeSec)}
        </div>
      </div>
    </div>
  );
}

function Controls({ state, pending, doAction }: { state: StateResp; pending: string | null; doAction: (l: string, fn: () => Promise<unknown>) => void }) {
  return (
    <div className="section">
      <div className="section-title">Manual Controls</div>
      <div className="card">
        <div className="row">
          {state.paused ? (
            <button className="btn btn-primary" disabled={pending !== null} onClick={() => doAction("Resume trading", () => api.resume())}>
              ▶ Resume
            </button>
          ) : (
            <button className="btn btn-warn" disabled={pending !== null} onClick={() => doAction("Pause trading", () => api.pause())}>
              ⏸ Pause
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
  );
}

function SignalsFeed({ signals }: { signals: Signal[] }) {
  return (
    <div className="section">
      <div className="section-title">Recent Signals ({signals.length})</div>
      <div className="card table-card">
        {signals.length === 0 ? (
          <div className="empty">No signals yet — bot is waiting for setups</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Confidence</th><th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {signals.slice(0, 50).map((s) => (
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
    </div>
  );
}

function TradesTable({ trades }: { trades: RealTrade[] }) {
  return (
    <div className="section">
      <div className="section-title">Closed Trades ({trades.length})</div>
      <div className="card table-card">
        {trades.length === 0 ? (
          <div className="empty">No trades closed yet</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Closed</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>Profit</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 50).map((t) => (
                <tr key={t.id}>
                  <td className="mono faint">{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                  <td className="mono">{t.symbol}</td>
                  <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                  <td><span className="strat-chip">{t.detector}</span></td>
                  <td className="mono">${t.stake.toFixed(2)}</td>
                  <td className={`mono ${(t.profit ?? 0) > 0 ? "pos" : (t.profit ?? 0) < 0 ? "neg" : "muted"}`}>
                    {t.profit != null ? `${t.profit >= 0 ? "+" : ""}$${t.profit.toFixed(2)}` : "—"}
                  </td>
                  <td>
                    <span className={`pill ${t.status === "won" ? "pill-green" : t.status === "lost" ? "pill-red" : "pill-blue"}`}>
                      {t.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-4">
      {[0, 1, 2, 3].map((i) => (
        <div className="card" key={i}>
          <div className="skel" style={{ height: 14, width: "60%", marginBottom: 12 }} />
          <div className="skel" style={{ height: 28, width: "80%" }} />
        </div>
      ))}
    </div>
  );
}

function Footer({ state }: { state: StateResp | null }) {
  return (
    <div className="footer">
      bot.proxaslab.com · auto-refresh every {REFRESH_MS / 1000}s
      {state && <> · {state.health.wsConnected ? "WS up" : "WS down"} · {state.health.authorized ? "authorized" : "not authorized"}</>}
    </div>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function fmtUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

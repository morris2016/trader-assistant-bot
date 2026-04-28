import React, { useEffect, useState } from "react";
import { api, type StateResp } from "../api";

export function SettingsPanel({ state, doAction, pending }: {
  state: StateResp;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    api.config().then((r) => setConfig(r.config)).catch(() => {});
  }, []);

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">Account</div>
        </div>
        <div className="card card-padded">
          {state.account ? (
            <div className="kv-list">
              <div className="kv-row"><div className="kv-key">Login ID</div><div className="kv-val mono">{state.account.loginid}</div></div>
              <div className="kv-row"><div className="kv-key">Currency</div><div className="kv-val">{state.account.currency}</div></div>
              <div className="kv-row"><div className="kv-key">Balance</div><div className="kv-val mono">${state.account.balance.toFixed(2)}</div></div>
              <div className="kv-row"><div className="kv-key">Account Type</div><div className="kv-val">
                <span className={`pill ${state.account.isVirtual ? "pill-cyan" : "pill-red"}`}>
                  <span className="pill-dot" />{state.account.isVirtual ? "DEMO" : "REAL"}
                </span>
              </div></div>
              {state.account.fullname && <div className="kv-row"><div className="kv-key">Name</div><div className="kv-val">{state.account.fullname}</div></div>}
              {state.account.email && <div className="kv-row"><div className="kv-key">Email</div><div className="kv-val">{state.account.email}</div></div>}
            </div>
          ) : (
            <div className="muted">Not authorized</div>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Bot Configuration</div>
          <div className="section-sub">Read-only — change values via Railway dashboard env vars and redeploy</div>
        </div>
        <div className="card card-padded">
          {config ? (
            <div className="kv-list">
              {Object.entries(config).map(([k, v]) => (
                <div className="kv-row" key={k}>
                  <div className="kv-key">{k}</div>
                  <div className="kv-val mono">{String(v)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="muted">Loading config…</div>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Manual Controls</div>
          <div className="section-sub">Override automatic behavior temporarily — confirms before each action</div>
        </div>
        <div className="grid grid-2">
          <div className="card card-padded">
            <div className="card-title">Trading State</div>
            <div className="card-value" style={{ fontSize: 16, marginBottom: 12 }}>
              {state.paused ? <span className="amber">⏸ Paused</span> : <span className="pos">▶ Active</span>}
            </div>
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
            </div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              Pause halts new trade entries. In-flight orders continue (Deriv server-side TP/SL).
            </div>
          </div>
          <div className="card card-padded">
            <div className="card-title">State Resets</div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" disabled={pending !== null} onClick={() => doAction("Reset adaptive shift state to clean", () => api.resetAdaptive())}>
                Reset Adaptive Shift
              </button>
              <button className="btn" disabled={pending !== null} onClick={() => doAction("Reset daily P&L tracking", () => api.resetDaily())}>
                Reset Daily P&amp;L
              </button>
            </div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              Adaptive reset clears loss streak + side bias + metals throttle. Daily reset clears today's P&amp;L counter.
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Health Check</div>
        </div>
        <div className="card card-padded">
          <div className="kv-list">
            <div className="kv-row"><div className="kv-key">WebSocket</div><div className="kv-val">
              <span className={`pill ${state.health.wsConnected ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />{state.health.wsConnected ? "connected" : "disconnected"}
              </span>
            </div></div>
            <div className="kv-row"><div className="kv-key">Authorized</div><div className="kv-val">
              <span className={`pill ${state.health.authorized ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />{state.health.authorized ? "yes" : "no"}
              </span>
            </div></div>
            <div className="kv-row"><div className="kv-key">Uptime</div><div className="kv-val mono">{state.health.uptimeSec}s</div></div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">API Reference</div>
          <div className="section-sub">Use these endpoints to integrate or monitor externally</div>
        </div>
        <div className="card card-padded">
          <div className="kv-list">
            <div className="kv-row"><div className="kv-key">GET /api/health</div><div className="kv-val muted">liveness check</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/ready</div><div className="kv-val muted">strict readiness (WS+auth)</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/state</div><div className="kv-val muted">full bot state</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/strategies</div><div className="kv-val muted">enriched per-strategy stats</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/signals?limit=N</div><div className="kv-val muted">recent detector signals</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/trades?limit=N</div><div className="kv-val muted">closed trade history</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/candles?symbol=...&amp;granularity=...</div><div className="kv-val muted">candle history for charts</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/subscriptions</div><div className="kv-val muted">live (symbol, granularity) subs</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/account</div><div className="kv-val muted">Deriv account info</div></div>
            <div className="kv-row"><div className="kv-key">GET /api/config</div><div className="kv-val muted">read-only effective config</div></div>
            <div className="kv-row"><div className="kv-key">POST /api/control/pause</div><div className="kv-val muted">manually halt trading</div></div>
            <div className="kv-row"><div className="kv-key">POST /api/control/resume</div><div className="kv-val muted">resume trading</div></div>
            <div className="kv-row"><div className="kv-key">POST /api/control/reset-adaptive</div><div className="kv-val muted">reset adaptive shift</div></div>
            <div className="kv-row"><div className="kv-key">POST /api/control/reset-daily</div><div className="kv-val muted">reset daily P&amp;L</div></div>
          </div>
        </div>
      </div>
    </>
  );
}

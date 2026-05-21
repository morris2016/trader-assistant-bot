import React, { useEffect, useState } from "react";
import { api, type StateResp } from "../api";

export function SettingsPanel({ state, doAction, pending }: {
  state: StateResp;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  // Binance state
  const [bHasCreds, setBHasCreds] = useState(false);
  const [bRunning, setBRunning] = useState(false);
  const [bTestnet, setBTestnet] = useState(false);
  const [bState, setBState] = useState<any>(null);
  const [bKey, setBKey] = useState("");
  const [bSecret, setBSecret] = useState("");
  const [bUseTestnet, setBUseTestnet] = useState(false);
  const [bErr, setBErr] = useState<string | null>(null);
  const [bTestResult, setBTestResult] = useState<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string } | null>(null);

  async function refreshBinance() {
    try {
      const r = await api.binanceState();
      setBHasCreds(r.hasCreds); setBRunning(r.running); setBTestnet(r.testnet); setBState(r.state);
    } catch {}
  }
  useEffect(() => {
    api.config().then((r) => setConfig(r.config)).catch(() => {});
    refreshBinance();
    const id = setInterval(refreshBinance, 5000);
    return () => clearInterval(id);
  }, []);

  async function saveBinanceCreds() {
    setBErr(null);
    const k = bKey.trim(), s = bSecret.trim();
    if (!k || !s) { setBErr("Key and secret required"); return; }
    if (k.length < 32 || s.length < 32) { setBErr("Key/secret look too short (Binance keys are 64 chars)"); return; }
    const r = await api.binanceSetCreds(k, s, bUseTestnet);
    if (!r.ok) { setBErr(r.error ?? "Save failed"); return; }
    setBKey(""); setBSecret("");
    await refreshBinance();
  }
  async function clearBinanceCreds() {
    if (!confirm("Clear Binance API key + secret? Bot will stop trading.")) return;
    await api.binanceClearCreds();
    setBTestResult(null);
    await refreshBinance();
  }
  async function testBinance() {
    setBTestResult(null);
    const r = await api.binanceTest();
    setBTestResult(r);
  }
  async function startBinance() {
    setBTestResult(null);
    const r = await api.binanceStart();
    if (!r.ok) setBTestResult({ ok: false, error: r.error });
    await refreshBinance();
  }
  async function stopBinance() {
    await api.binanceStop();
    await refreshBinance();
  }

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
              <div className="kv-row"><div className="kv-key">Balance</div><div className="kv-val mono">${(state.account.balance ?? 0).toFixed(2)}</div></div>
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
          <div className="section-title">Binance Futures (crypto trading)</div>
          <div className="section-sub">15 crypto assets, trained SMC strategy (OB_BULL / OB_BEAR / BOS_UP). Validated +85% WR / +$5,400 over 6 months on $300 / $15 stake.</div>
        </div>
        <div className="card card-padded">
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
              <span className={`pill ${bHasCreds ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />{bHasCreds ? "Creds saved" : "No creds"}
              </span>
              {bHasCreds && (
                <span className={`pill ${bRunning ? "pill-green" : "pill-amber"}`}>
                  <span className="pill-dot" />{bRunning ? "Engine running" : "Stopped"}
                </span>
              )}
              {bHasCreds && (
                <span className={`pill ${bTestnet ? "pill-cyan" : "pill-red"}`}>
                  <span className="pill-dot" />{bTestnet ? "TESTNET" : "LIVE"}
                </span>
              )}
            </div>

            {!bHasCreds ? (
              <>
                <div className="card-sub">
                  Enter API Key + Secret. Get a <b>live</b> key at <code>binance.com → API Management</code> (Enable Futures, recommend IP whitelist).
                  Get a <b>testnet</b> key at <code>testnet.binancefuture.com → API Management</code>. Stored encrypted at rest (AES-256-GCM keyed by BOT_SECRET env).
                </div>
                <input type="password" placeholder="API Key (64 chars)" value={bKey} onChange={(e) => { setBKey(e.target.value); setBErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <input type="password" placeholder="API Secret (64 chars)" value={bSecret} onChange={(e) => { setBSecret(e.target.value); setBErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <label style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={bUseTestnet} onChange={(e) => setBUseTestnet(e.target.checked)} style={{ marginRight: 6 }} />
                  Testnet (paper trading — recommended first)
                </label>
                <div className="row">
                  <button className="btn btn-primary" onClick={saveBinanceCreds} disabled={pending !== null}>Save</button>
                </div>
                {bErr && <div style={{ color: "#d4a35f", fontSize: 12 }}>{bErr}</div>}
              </>
            ) : (
              <>
                <div className="row">
                  <button className="btn" onClick={testBinance} disabled={pending !== null}>Test connection</button>
                  {!bRunning ? (
                    <button className="btn btn-primary" onClick={startBinance} disabled={pending !== null}>Start trading</button>
                  ) : (
                    <button className="btn btn-warn" onClick={stopBinance} disabled={pending !== null}>Stop trading</button>
                  )}
                  <button className="btn btn-danger" onClick={clearBinanceCreds} disabled={pending !== null}>Clear keys</button>
                </div>
                {bTestResult && (
                  bTestResult.ok ? (
                    <div style={{ color: "#5fd4a4", fontSize: 13 }}>
                      ✓ Connected ({bTestResult.testnet ? "TESTNET" : "LIVE"}) — USDT balance: ${bTestResult.balanceUsdt?.toFixed(2)} (available: ${bTestResult.available?.toFixed(2)})
                    </div>
                  ) : (
                    <div style={{ color: "#d4a35f", fontSize: 13 }}>✗ {bTestResult.error}</div>
                  )
                )}
                {bState && (
                  <div className="kv-list">
                    <div className="kv-row"><div className="kv-key">Open positions</div><div className="kv-val mono">{bState.open?.length ?? 0}</div></div>
                    <div className="kv-row"><div className="kv-key">Closed today</div><div className="kv-val mono">{bState.closed?.filter((c: any) => c.closeEpoch && new Date(c.closeEpoch * 1000).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)).length ?? 0}</div></div>
                    <div className="kv-row"><div className="kv-key">Daily P&L</div><div className="kv-val mono">${(bState.daily?.profit ?? 0).toFixed(2)}</div></div>
                    <div className="kv-row"><div className="kv-key">Trades opened today</div><div className="kv-val mono">{bState.daily?.tradesOpened ?? 0}</div></div>
                  </div>
                )}
              </>
            )}
          </div>
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

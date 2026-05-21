// Binance Futures Settings — credential entry + engine controls. One of
// 5 panels in the dedicated Binance mode (Overview / Positions / Trades /
// Strategies / Settings).

import React, { useEffect, useState } from "react";
import { api } from "../../api";

export function BinanceSettingsPanel({ pending }: { pending: string | null }) {
  const [hasCreds, setHasCreds] = useState(false);
  const [running, setRunning] = useState(false);
  const [testnet, setTestnet] = useState(false);
  const [state, setState] = useState<any>(null);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [useTestnet, setUseTestnet] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string } | null>(null);

  async function refresh() {
    try {
      const r = await api.binanceState();
      setHasCreds(r.hasCreds);
      setRunning(r.running);
      setTestnet(r.testnet);
      setState(r.state);
    } catch {}
  }
  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  async function saveCreds() {
    setErr(null);
    const k = key.trim(), s = secret.trim();
    if (!k || !s) { setErr("Key and secret required"); return; }
    if (k.length < 32 || s.length < 32) { setErr("Key/secret look too short (Binance keys are 64 chars)"); return; }
    const r = await api.binanceSetCreds(k, s, useTestnet);
    if (!r.ok) { setErr(r.error ?? "Save failed"); return; }
    setKey(""); setSecret("");
    await refresh();
  }
  async function clearCreds() {
    if (!confirm("Clear Binance API key + secret? Bot will stop trading.")) return;
    await api.binanceClearCreds();
    setTestResult(null);
    await refresh();
  }
  async function testConnection() {
    setTestResult(null);
    const r = await api.binanceTest();
    setTestResult(r);
  }
  async function start() {
    setTestResult(null);
    const r = await api.binanceStart();
    if (!r.ok) setTestResult({ ok: false, error: r.error });
    await refresh();
  }
  async function stop() {
    await api.binanceStop();
    await refresh();
  }

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">Binance Futures (crypto)</div>
          <div className="section-sub">
            15-asset trained SMC strategy (OB_BULL / OB_BEAR / BOS_UP) — validated 85% WR / +$5,400 over 6 months on $300 / $15 stake.
          </div>
        </div>
        <div className="card card-padded">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
              <span className={`pill ${hasCreds ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />{hasCreds ? "Creds saved" : "No creds"}
              </span>
              {hasCreds && (
                <span className={`pill ${running ? "pill-green" : "pill-amber"}`}>
                  <span className="pill-dot" />{running ? "Engine running" : "Stopped"}
                </span>
              )}
              {hasCreds && (
                <span className={`pill ${testnet ? "pill-cyan" : "pill-red"}`}>
                  <span className="pill-dot" />{testnet ? "TESTNET" : "LIVE"}
                </span>
              )}
            </div>

            {!hasCreds ? (
              <>
                <div className="card-sub">
                  Enter API Key + Secret. <b>Live</b> key: <code>binance.com → API Management</code> (Enable Futures, recommend IP whitelist).
                  {" "}<b>Testnet</b> key: <code>testnet.binancefuture.com → API Management</code>.
                  Stored encrypted at rest (AES-256-GCM, keyed by <code>BOT_SECRET</code> env).
                </div>
                <input type="password" placeholder="API Key (64 chars)" value={key} onChange={(e) => { setKey(e.target.value); setErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <input type="password" placeholder="API Secret (64 chars)" value={secret} onChange={(e) => { setSecret(e.target.value); setErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <label style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={useTestnet} onChange={(e) => setUseTestnet(e.target.checked)} style={{ marginRight: 6 }} />
                  Testnet (paper trading)
                </label>
                <div className="row">
                  <button className="btn btn-primary" onClick={saveCreds} disabled={pending !== null}>Save credentials</button>
                </div>
                {err && <div style={{ color: "#d4a35f", fontSize: 12 }}>{err}</div>}
              </>
            ) : (
              <>
                <div className="row">
                  <button className="btn" onClick={testConnection} disabled={pending !== null}>Test connection</button>
                  {!running ? (
                    <button className="btn btn-primary" onClick={start} disabled={pending !== null}>Start trading</button>
                  ) : (
                    <button className="btn btn-warn" onClick={stop} disabled={pending !== null}>Stop trading</button>
                  )}
                  <button className="btn btn-danger" onClick={clearCreds} disabled={pending !== null}>Clear keys</button>
                </div>
                {testResult && (
                  testResult.ok ? (
                    <div style={{ color: "#5fd4a4", fontSize: 13 }}>
                      ✓ Connected ({testResult.testnet ? "TESTNET" : "LIVE"}) — USDT balance: ${testResult.balanceUsdt?.toFixed(2)} (available: ${testResult.available?.toFixed(2)})
                    </div>
                  ) : (
                    <div style={{ color: "#d4a35f", fontSize: 13 }}>✗ {testResult.error}</div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {state && hasCreds && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">Status</div>
          </div>
          <div className="card card-padded">
            <div className="kv-list">
              <div className="kv-row"><div className="kv-key">Open positions</div><div className="kv-val mono">{state.open?.length ?? 0}</div></div>
              <div className="kv-row"><div className="kv-key">Closed today</div><div className="kv-val mono">{state.closed?.filter((c: any) => c.closeEpoch && new Date(c.closeEpoch * 1000).toISOString().slice(0, 10) === new Date().toISOString().slice(0, 10)).length ?? 0}</div></div>
              <div className="kv-row"><div className="kv-key">Daily P&amp;L</div><div className="kv-val mono">${(state.daily?.profit ?? 0).toFixed(2)}</div></div>
              <div className="kv-row"><div className="kv-key">Trades opened today</div><div className="kv-val mono">{state.daily?.tradesOpened ?? 0}</div></div>
            </div>
          </div>

          {state.open && state.open.length > 0 && (
            <div className="card card-padded" style={{ marginTop: 12 }}>
              <div className="card-title">Open positions</div>
              <table className="table" style={{ marginTop: 8 }}>
                <thead><tr><th>Asset</th><th>Pattern</th><th>Side</th><th>Entry</th><th>Peak</th><th>Armed</th></tr></thead>
                <tbody>
                  {state.open.map((t: any) => (
                    <tr key={t.id}>
                      <td>{t.asset}</td><td>{t.pattern}</td>
                      <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                      <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                      <td className="mono">${(+t.peakFav).toFixed(5)}</td>
                      <td>{t.armed ? "✓" : "·"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </>
  );
}

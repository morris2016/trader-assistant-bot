// Binance Settings — credential entry + engine controls + config knobs.

import React, { useEffect, useState } from "react";
import { api, type BinanceConfig } from "../../api";

export function BinanceSettingsPanel({ pending }: { pending: string | null }) {
  const [hasCreds, setHasCreds] = useState(false);
  const [running, setRunning] = useState(false);
  const [testnet, setTestnet] = useState(false);
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [useTestnet, setUseTestnet] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; balanceUsdt?: number; available?: number; testnet?: boolean; error?: string } | null>(null);
  const [config, setConfig] = useState<BinanceConfig | null>(null);
  const [diag, setDiag] = useState<any>(null);
  const [stake, setStake] = useState("15");
  const [leverage, setLeverage] = useState("30");
  const [dailyMaxLoss, setDailyMaxLoss] = useState("100");
  const [perTradeMaxStake, setPerTradeMaxStake] = useState("30");
  // SMC hard SL as % of stake (max-$-loss = stake × this/100; price-move = this/leverage)
  const [smcSlPct, setSmcSlPct] = useState("0");
  const [configMsg, setConfigMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [configBusy, setConfigBusy] = useState(false);
  // Sync local form inputs from server config only ONCE on first load —
  // otherwise the 5s refresh interval clobbers whatever the user is typing.
  const [configSynced, setConfigSynced] = useState(false);

  async function refresh() {
    try {
      const r = await api.binanceState();
      setHasCreds(r.hasCreds);
      setRunning(r.running);
      setTestnet(r.testnet);
    } catch {}
    try {
      const c = await api.binanceConfig();
      setConfig(c.config);
      // Form-field sync runs ONCE on first load. After that, user owns
      // these inputs until they click Save (which fires reset + re-sync).
      if (!configSynced) {
        setStake(String(c.config.stake));
        setLeverage(String(c.config.leverage));
        setDailyMaxLoss(String(c.config.dailyMaxLoss));
        setPerTradeMaxStake(String(c.config.perTradeMaxStake));
        setSmcSlPct(String((c.config as any).slPctSmc ?? 0));
        setConfigSynced(true);
      }
    } catch {}
    try { setDiag(await api.binanceDiag()); } catch {}
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 5000); return () => clearInterval(id); }, []);

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

  async function saveConfig() {
    setConfigMsg(null);
    const patch: Partial<BinanceConfig> = {
      stake: Number(stake), leverage: Number(leverage),
      dailyMaxLoss: Number(dailyMaxLoss), perTradeMaxStake: Number(perTradeMaxStake),
      slPctSmc: Number(smcSlPct) || 0,
    };
    if (!isFinite(patch.stake!) || patch.stake! <= 0) { setConfigMsg({ ok: false, text: "Stake must be > 0" }); return; }
    if (!isFinite(patch.leverage!) || patch.leverage! < 1 || patch.leverage! > 125) { setConfigMsg({ ok: false, text: "Leverage must be 1–125" }); return; }
    if (!isFinite(patch.dailyMaxLoss!) || patch.dailyMaxLoss! <= 0) { setConfigMsg({ ok: false, text: "Daily max loss must be > 0" }); return; }
    if (!isFinite(patch.perTradeMaxStake!) || patch.perTradeMaxStake! <= 0) { setConfigMsg({ ok: false, text: "Per-trade max stake must be > 0" }); return; }
    setConfigBusy(true);
    const r = await api.binanceUpdateConfig(patch);
    setConfigBusy(false);
    if (!r.ok) { setConfigMsg({ ok: false, text: r.error ?? "Save failed" }); return; }
    setConfigMsg({ ok: true, text: "Config saved" });
    await refresh();
  }

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">Credentials</div>
        </div>
        <div className="card card-padded">
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span className={`pill ${hasCreds ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />{hasCreds ? "Creds saved" : "No creds"}
              </span>
              {hasCreds && <span className={`pill ${running ? "pill-green" : "pill-amber"}`}><span className="pill-dot" />{running ? "Engine running" : "Stopped"}</span>}
              {hasCreds && <span className={`pill ${testnet ? "pill-cyan" : "pill-red"}`}><span className="pill-dot" />{testnet ? "TESTNET" : "LIVE"}</span>}
            </div>
            {!hasCreds ? (
              <>
                <div className="card-sub">
                  <b>Live</b>: <code>binance.com → API Management</code> (Enable Futures, IP whitelist recommended). <b>Testnet</b>: <code>testnet.binancefuture.com → API Management</code>. Stored AES-256-GCM encrypted, keyed by <code>BOT_SECRET</code> env.
                </div>
                <input type="password" placeholder="API Key (64 chars)" value={key} onChange={(e) => { setKey(e.target.value); setErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <input type="password" placeholder="API Secret (64 chars)" value={secret} onChange={(e) => { setSecret(e.target.value); setErr(null); }}
                  style={{ background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }} />
                <label style={{ fontSize: 13 }}>
                  <input type="checkbox" checked={useTestnet} onChange={(e) => setUseTestnet(e.target.checked)} style={{ marginRight: 6 }} />
                  Testnet
                </label>
                <div className="row"><button className="btn btn-primary" onClick={saveCreds} disabled={pending !== null}>Save credentials</button></div>
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
                {testResult && (testResult.ok
                  ? <div style={{ color: "#5fd4a4", fontSize: 13 }}>✓ Connected ({testResult.testnet ? "TESTNET" : "LIVE"}) — USDT ${testResult.balanceUsdt?.toFixed(2)} / available ${testResult.available?.toFixed(2)}</div>
                  : <div style={{ color: "#d4a35f", fontSize: 13 }}>✗ {testResult.error}</div>)}
              </>
            )}
          </div>
        </div>
      </div>

      {diag && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">Persistence diagnostic</div>
            <div className="section-sub">If your API keys keep resetting on each redeploy, the Railway volume isn't mounted. Check the file mtimes vs the bot's start time below.</div>
          </div>
          <div className="card card-padded">
            <div className="kv-list">
              <div className="kv-row"><div className="kv-key">State directory</div><div className="kv-val mono">{diag.stateDir}</div></div>
              <div className="kv-row"><div className="kv-key">Directory exists</div><div className="kv-val">{diag.stateDirExists ? "✓ yes" : "✗ no"}</div></div>
            </div>
            <table className="table" style={{ marginTop: 10 }}>
              <thead><tr><th>File</th><th>Exists</th><th>Size</th><th>Last modified (UTC)</th></tr></thead>
              <tbody>
                {diag.files.map((f: any) => (
                  <tr key={f.file}>
                    <td className="mono">{f.file}</td>
                    <td>{f.exists ? "✓" : <span className="muted">—</span>}</td>
                    <td className="mono">{f.exists ? `${f.sizeBytes}b` : ""}</td>
                    <td className="mono muted">{f.exists ? f.mtime?.slice(0, 19).replace("T", " ") : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-sub" style={{ marginTop: 10 }}>
              <b>Railway fix</b>: Service → Settings → Volumes → Add volume → mount path <code>{diag.stateDir}</code>.
              Any size will do (1GB is plenty). After attaching, the next deploy preserves all state across restarts.
            </div>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-header">
          <div className="section-title">Engine config</div>
          <div className="section-sub">Apply immediately to the running engine. Persisted to disk; survives restart.</div>
        </div>
        <div className="card card-padded">
          <div className="grid grid-2">
            <ConfigField label="Stake ($)" value={stake} onChange={setStake} hint="Base $ per trade. Validated default: 15." />
            <ConfigField label="Leverage (×)" value={leverage} onChange={setLeverage} hint="Position multiplier. Binance max 125 on some pairs." />
            <ConfigField label="Daily max loss ($)" value={dailyMaxLoss} onChange={setDailyMaxLoss} hint="Engine pauses for the day when realized loss crosses this." />
            <ConfigField label="Per-trade max stake ($)" value={perTradeMaxStake} onChange={setPerTradeMaxStake} hint="Hard ceiling on any single trade's stake." />
            <ConfigField
              label="SMC SL — % of stake"
              value={smcSlPct}
              onChange={setSmcSlPct}
              hint={`Hard SL as % of stake. Max $ loss = stake × this/100. Price move = this/leverage. 0 = disabled (trail-arm only). Current: max loss ≈ $${(Number(stake) * Number(smcSlPct) / 100 || 0).toFixed(2)} at ${Number(smcSlPct) > 0 && Number(leverage) > 0 ? `${(Number(smcSlPct) / Number(leverage)).toFixed(3)}%` : "—"} price move.`}
            />
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={saveConfig} disabled={configBusy}>{configBusy ? "Saving…" : "Save config"}</button>
            {configMsg && (
              <span style={{ color: configMsg.ok ? "#5fd4a4" : "#d4a35f", fontSize: 13 }}>
                {configMsg.ok ? "✓" : "✗"} {configMsg.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function ConfigField({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="card card-padded">
      <div className="card-title">{label}</div>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "8px 10px", borderRadius: 6, marginTop: 6, fontFamily: "monospace" }}
      />
      {hint && <div className="card-sub" style={{ marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

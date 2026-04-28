import { useEffect, useState } from "react";
import { useStore } from "../../store";
import type { DetectorConfig } from "@shared/types";

function humanizeParamKey(key: string): string {
  // Turn camelCase → "Camel Case", and acronym-preserve known abbreviations.
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced
    .split(" ")
    .map((w) => {
      const upper = w.toUpperCase();
      if (["ATR", "OB", "FVG", "ADX", "EMA", "RSI", "CE", "TP", "SL", "TF", "BOS", "SMC", "EQH", "EQL"].includes(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

export default function SettingsRoute() {
  const { settings, updateSettings, status, real, realGate, realErrors, enableReal, disableReal, refreshRealGate } = useStore();
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState<string | null>(null);
  const [dsKey, setDsKey] = useState("");
  const [hasDsKey, setHasDsKey] = useState(false);
  const [dsKeyError, setDsKeyError] = useState<string | null>(null);

  useEffect(() => {
    window.api.hasToken().then(setHasToken);
    window.api.hasDeepseekKey().then(setHasDsKey);
  }, []);

  const saveDsKey = async () => {
    setDsKeyError(null);
    const cleaned = dsKey.trim();
    if (!cleaned) { setDsKeyError("Empty key"); return; }
    if (!/^sk-[A-Za-z0-9]{20,}$/.test(cleaned)) {
      setDsKeyError("Expected DeepSeek key format: sk-… (20+ chars)");
      return;
    }
    await window.api.setDeepseekKey(cleaned);
    setDsKey("");
    setHasDsKey(true);
  };
  const clearDsKey = async () => {
    await window.api.clearDeepseekKey();
    setHasDsKey(false);
    setDsKeyError(null);
  };

  if (!settings) return <div className="page"><div className="empty-state">Loading…</div></div>;

  const saveToken = async () => {
    setTokenError(null);
    const raw = token;
    // Strip any non-alphanumeric to defeat invisible/unicode whitespace from paste.
    const cleaned = raw.replace(/[^A-Za-z0-9]/g, "");
    if (cleaned.length === 0) {
      setTokenError("Empty token");
      return;
    }
    if (cleaned.length < 8 || cleaned.length > 40) {
      setTokenError(`Token must be 8–40 alphanumeric chars (got ${cleaned.length})`);
      return;
    }
    if (cleaned !== raw.trim()) {
      setTokenError(
        `Paste contained non-alphanumeric characters — stripped ${raw.trim().length - cleaned.length} before saving. If auth still fails, re-copy the token from Deriv via a plain-text editor.`,
      );
    }
    await window.api.setToken(cleaned);
    setToken("");
    setHasToken(true);
    refreshRealGate();
  };

  const clearToken = async () => {
    await window.api.clearToken();
    setHasToken(false);
    setTokenError(null);
    refreshRealGate();
  };

  // Show the most recent Deriv auth-related error inline on this page.
  const authError = [...realErrors]
    .reverse()
    .find((e) => /deriv auth/i.test(e.message));

  const updateDetector = (id: string, patch: Partial<DetectorConfig>) => {
    const next = settings.detectors.map((d) => (d.id === id ? { ...d, ...patch } : d));
    updateSettings({ detectors: next });
  };

  const updateDetectorParam = (id: string, key: string, value: number) => {
    const det = settings.detectors.find((d) => d.id === id);
    if (!det) return;
    updateDetector(id, { params: { ...det.params, [key]: value } });
  };

  const handleEnable = async () => {
    setEnabling(true);
    setEnableError(null);
    try {
      const res = await enableReal();
      if (!res.ok) {
        setEnableError(res.error ?? (res.reasons?.join("; ") ?? "Could not enable real mode"));
      }
    } finally {
      setEnabling(false);
    }
  };

  const acct = status.account;

  return (
    <div className="page">
      <h2 style={{ marginTop: 0, color: "#5fd4a4" }}>Settings</h2>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Deriv API Token</h3>
        <p style={{ color: "#8a95b8", fontSize: 13, marginTop: 0 }}>
          Create at <code>app.deriv.com → API token</code>. Required scopes:
          <b> Read, Trade</b> (plus <b>Payments</b> if you want balance updates).
          Stored encrypted via OS keychain. Start with a <b>virtual (demo) account</b>
          token — test first, trade later.
        </p>
        {hasToken ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: acct ? "#5fd4a4" : authError ? "#e05f8a" : "#d4a35f" }}>
              ● Token stored{acct ? " — authorized" : authError ? " — rejected by Deriv" : " — authorizing…"}
            </span>
            <button className="btn btn-danger" onClick={clearToken}>Remove token</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <input
              type="password"
              placeholder="Paste Deriv API token"
              value={token}
              onChange={(e) => { setToken(e.target.value); setTokenError(null); }}
              style={{ flex: 1, background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }}
            />
            <button className="btn btn-primary" onClick={saveToken}>Save</button>
          </div>
        )}
        {tokenError && (
          <div style={{ color: "#d4a35f", marginTop: 8, fontSize: 12 }}>{tokenError}</div>
        )}
        {hasToken && !acct && authError && (
          <div style={{ marginTop: 10, padding: 10, background: "#4a1e2e", color: "#e05f8a", borderRadius: 6, border: "1px solid #e05f8a", fontSize: 12 }}>
            <b>Deriv rejected this token.</b>{" "}
            {authError.message.replace(/^deriv auth:\s*/i, "")}
            <div style={{ color: "#a57b98", marginTop: 4 }}>
              Remove the stored token, create a fresh one at <code>app.deriv.com → API token</code> (Read + Trade scopes, 15 alphanumeric chars), and paste again.
            </div>
          </div>
        )}
        {acct && (
          <div style={{ marginTop: 12, padding: 12, background: "#0e1528", borderRadius: 8, border: `1px solid ${acct.isVirtual ? "#4a3e1e" : "#4a1e2e"}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ color: "#8a95b8", fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Authorized as
                </div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{acct.loginid}</div>
                {acct.email && <div style={{ color: "#6b7390", fontSize: 12 }}>{acct.email}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ color: acct.isVirtual ? "#d4a35f" : "#e05f8a", fontWeight: 700, fontSize: 13 }}>
                  {acct.isVirtual ? "DEMO ACCOUNT" : "REAL ACCOUNT"}
                </div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {acct.balance.toFixed(2)} {acct.currency}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">DeepSeek (primary signal source)</h3>
        <p style={{ color: "#8a95b8", fontSize: 13, marginTop: 0 }}>
          DeepSeek receives the recent OHLC bars + active Order Blocks + ATR/ADX
          context on every new bar close (30s cooldown), and emits BUY/SELL/HOLD.
          When <b>Signal source</b> is set to <b>deepseek</b>, only DeepSeek's
          BUY/SELL above the confidence threshold trigger paper/real trades —
          rule-based detector signals still appear on the chart for context.
          Get a key at <code>platform.deepseek.com → API Keys</code>. Stored
          encrypted via OS keychain.
        </p>

        {hasDsKey ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: "#5fd4a4" }}>● DeepSeek key stored</span>
            <button className="btn btn-danger" onClick={clearDsKey}>Remove key</button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 10 }}>
            <input
              type="password"
              placeholder="sk-…"
              value={dsKey}
              onChange={(e) => { setDsKey(e.target.value); setDsKeyError(null); }}
              style={{ flex: 1, background: "#0e1528", color: "#e0e5f5", border: "1px solid #1e2842", padding: "10px 12px", borderRadius: 6 }}
            />
            <button className="btn btn-primary" onClick={saveDsKey}>Save</button>
          </div>
        )}
        {dsKeyError && (
          <div style={{ color: "#d4a35f", marginTop: 8, fontSize: 12 }}>{dsKeyError}</div>
        )}

        <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, alignItems: "center" }}>
          <label style={{ color: "#8a95b8", fontSize: 12 }}>Signal source</label>
          <select
            value={settings.signalSource}
            onChange={(e) => updateSettings({ signalSource: e.target.value as typeof settings.signalSource })}
            style={{ width: 240 }}
          >
            <option value="deepseek">DeepSeek (primary)</option>
            <option value="detectors">Detectors only (rule-based)</option>
            <option value="consensus">Consensus (DeepSeek + detector agree)</option>
          </select>
          <label style={{ color: "#8a95b8", fontSize: 12 }}>Min confidence</label>
          <input
            type="number"
            step={0.05}
            min={0}
            max={1}
            value={settings.deepseekMinConfidence}
            onChange={(e) => {
              const v = Math.max(0, Math.min(1, +e.target.value));
              updateSettings({ deepseekMinConfidence: v });
            }}
            style={{ width: 100 }}
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16, borderColor: status.realModeEnabled ? (acct?.isVirtual ? "#4a3e1e" : "#4a1e2e") : "#1e2842" }}>
        <h3 className="section-title">Real Trading</h3>

        <div className="toggle">
          <input
            type="checkbox"
            checked={settings.risk.realModeConfirmed}
            onChange={(e) => updateSettings({ risk: { ...settings.risk, realModeConfirmed: e.target.checked } })}
          />
          <span>I understand this places orders with real money and I accept the risk of loss.</span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 10 }}>
          <div className="field">
            <label>Per-trade max stake</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={settings.risk.perTradeMaxStake}
              onChange={(e) => updateSettings({ risk: { ...settings.risk, perTradeMaxStake: +e.target.value } })}
            />
          </div>
          <div className="field">
            <label>Daily max loss</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={settings.risk.dailyMaxLoss}
              onChange={(e) => updateSettings({ risk: { ...settings.risk, dailyMaxLoss: +e.target.value } })}
            />
          </div>
        </div>

        <div className="field" style={{ marginTop: 4 }}>
          <label>Contract family</label>
          <select
            value={settings.realTrading.contractFamily}
            onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, contractFamily: e.target.value as "CALL_PUT" | "MULTIPLIER" } })}
          >
            <option value="MULTIPLIER">Multiplier (recommended for real markets — leveraged, with SL/TP)</option>
            <option value="CALL_PUT">Rise / Fall (binary, fixed tick duration)</option>
          </select>
        </div>

        {settings.realTrading.contractFamily === "CALL_PUT" ? (
          <div className="field">
            <label>Duration (ticks)</label>
            <input
              type="number"
              min={1}
              max={10}
              step={1}
              value={settings.realTrading.durationTicks}
              onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, durationTicks: +e.target.value } })}
            />
          </div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div className="field">
                <label>Multiplier</label>
                <select
                  value={settings.realTrading.multiplier}
                  onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, multiplier: +e.target.value } })}
                >
                  {[10, 30, 50, 100, 200, 500, 1000].map((m) => (
                    <option key={m} value={m}>{m}×</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>TP / SL mode</label>
                <select
                  value={settings.realTrading.tpSlMode}
                  onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, tpSlMode: e.target.value as "percent" | "atr" } })}
                >
                  <option value="atr">ATR multiple (adapts to volatility — recommended)</option>
                  <option value="percent">Percent of stake (fixed)</option>
                </select>
              </div>
            </div>

            {settings.realTrading.tpSlMode === "atr" ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field">
                  <label>TP at N × ATR</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={settings.realTrading.atrTpMult}
                    onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, atrTpMult: +e.target.value } })}
                  />
                </div>
                <div className="field">
                  <label>SL at N × ATR</label>
                  <input
                    type="number"
                    min={0}
                    step={0.1}
                    value={settings.realTrading.atrSlMult}
                    onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, atrSlMult: +e.target.value } })}
                  />
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div className="field">
                  <label>Take profit (% of stake)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={settings.realTrading.takeProfitPct}
                    onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, takeProfitPct: +e.target.value } })}
                  />
                </div>
                <div className="field">
                  <label>Stop loss (% of stake)</label>
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={settings.realTrading.stopLossPct}
                    onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, stopLossPct: +e.target.value } })}
                  />
                </div>
              </div>
            )}
          </>
        )}

        <div className="toggle" style={{ marginTop: 4 }}>
          <input
            type="checkbox"
            checked={settings.realTrading.autoTradeOnSignal}
            onChange={(e) => updateSettings({ realTrading: { ...settings.realTrading, autoTradeOnSignal: e.target.checked } })}
          />
          <span>Auto-place a real trade whenever a detector fires a signal</span>
        </div>

        <div style={{ marginTop: 14, padding: 12, background: "#0e1528", borderRadius: 8 }}>
          {status.realModeEnabled ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: acct?.isVirtual ? "#d4a35f" : "#e05f8a", fontWeight: 700 }}>
                ● Real mode is ON {acct?.isVirtual ? "(demo)" : "(LIVE MONEY)"}
              </span>
              <button className="btn btn-danger" onClick={disableReal} style={{ marginLeft: "auto" }}>Turn off</button>
            </div>
          ) : realGate?.canEnable ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ color: "#5fd4a4" }}>All prerequisites met</span>
              <button
                className="btn btn-primary"
                onClick={handleEnable}
                disabled={enabling}
                style={{ marginLeft: "auto" }}
              >
                {enabling ? "Authorizing…" : "Enable real mode"}
              </button>
            </div>
          ) : (
            <>
              <div style={{ color: "#d4a35f", fontWeight: 600, marginBottom: 6 }}>
                Real mode disabled — resolve these first:
              </div>
              <ul style={{ margin: 0, paddingLeft: 20, color: "#8a95b8", fontSize: 13 }}>
                {realGate?.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </>
          )}
          {enableError && (
            <div style={{ color: "#e05f8a", marginTop: 8, fontSize: 13 }}>{enableError}</div>
          )}
        </div>

        {real && real.daily.tradesOpened > 0 && (
          <div style={{ marginTop: 14, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ color: "#8a95b8", fontSize: 12 }}>
              Today: <b>{real.daily.tradesOpened}</b> trades opened ·{" "}
              <b style={{ color: real.daily.profit >= 0 ? "#5fd4a4" : "#e05f8a" }}>
                {real.daily.profit >= 0 ? "+" : ""}{real.daily.profit.toFixed(2)} {real.stats.currency ?? ""}
              </b>
              {real.daily.capHit && <b style={{ color: "#e05f8a" }}> · CAP HIT</b>}
            </span>
            <button className="btn" onClick={() => useStore.getState().resetDailyReal()}>Reset day</button>
          </div>
        )}
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Strategy</h3>
        <p style={{ color: "#8a95b8", fontSize: 13, marginTop: 0 }}>
          Controls which detector signals actually become trades. <b>Raw</b> fires on every
          individual detector — noisy, use only when tuning a single detector. <b>Confluence</b>{" "}
          needs two different detectors to agree within a window. <b>Trend-confluence</b> adds an
          ADX regime gate so signals only fire when the market is actually trending (recommended).
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr", gap: 12 }}>
          <div className="field">
            <label>Mode</label>
            <select
              value={settings.strategy.mode}
              onChange={(e) => updateSettings({ strategy: { ...settings.strategy, mode: e.target.value as "raw" | "confluence" | "trend-confluence" } })}
            >
              <option value="trend-confluence">Trend-confluence (ADX + 2+ detectors agree)</option>
              <option value="confluence">Confluence (2+ detectors agree)</option>
              <option value="raw">Raw (every detector = trade — noisy)</option>
            </select>
          </div>
          <div className="field">
            <label>ADX threshold</label>
            <input
              type="number"
              min={0}
              max={100}
              step={1}
              value={settings.strategy.adxThreshold}
              onChange={(e) => updateSettings({ strategy: { ...settings.strategy, adxThreshold: +e.target.value } })}
            />
          </div>
          <div className="field">
            <label>Confluence window (bars)</label>
            <input
              type="number"
              min={1}
              max={20}
              step={1}
              value={settings.strategy.confluenceWindowBars}
              onChange={(e) => updateSettings({ strategy: { ...settings.strategy, confluenceWindowBars: +e.target.value } })}
            />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3 className="section-title">Detectors</h3>
        {settings.detectors.map((d) => (
          <div key={d.id} style={{ padding: "10px 0", borderBottom: "1px solid #1a2240" }}>
            <div className="toggle">
              <input
                type="checkbox"
                checked={d.enabled}
                onChange={(e) => updateDetector(d.id, { enabled: e.target.checked })}
              />
              <span style={{ fontWeight: 600 }}>{d.label}</span>
              <span style={{ color: "#6b7390", fontSize: 11, marginLeft: "auto" }}>{d.id}</span>
            </div>
            {d.enabled && Object.keys(d.params).length > 0 && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, marginLeft: 28 }}>
                {Object.entries(d.params).map(([k, v]) => (
                  <div key={k} className="field" style={{ marginBottom: 0 }}>
                    <label style={{ textTransform: "none", fontSize: 11, letterSpacing: 0 }}>
                      {humanizeParamKey(k)}
                    </label>
                    <input
                      type="number"
                      step="any"
                      value={v}
                      onChange={(e) => updateDetectorParam(d.id, k, +e.target.value)}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

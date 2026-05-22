// Binance HF (15m BB) — dedicated panel for the BB_UP_SHORT + BB_LOW_LONG
// stack. Shows open HF positions with per-row Cancel, config knobs,
// equity curve, and filtered HF-only logs.

import React, { useEffect, useMemo, useState } from "react";
import { api, type BinanceConfig } from "../../api";

const HF_PATTERNS = ["BB_UP_SHORT", "BB_LOW_LONG"] as const;
type HfPattern = (typeof HF_PATTERNS)[number];

function isHf(p: string): boolean { return p === "BB_UP_SHORT" || p === "BB_LOW_LONG"; }
function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}
function todayUtc(): string { return new Date().toISOString().slice(0, 10); }

export function BinanceHFPanel() {
  const [bs, setBs] = useState<any>(null);
  const [config, setConfig] = useState<BinanceConfig | null>(null);
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [cancelErr, setCancelErr] = useState<string | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Editable form fields (mirror config but as strings for type-friendliness)
  const [stake, setStake] = useState("1");
  const [leverage, setLeverage] = useState("30");
  const [enabled, setEnabled] = useState(false);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [perPattern, setPerPattern] = useState<{ BB_UP_SHORT: boolean; BB_LOW_LONG: boolean }>({ BB_UP_SHORT: true, BB_LOW_LONG: true });
  const [perAssetEnabled, setPerAssetEnabled] = useState<Record<string, boolean>>({});

  async function refresh() {
    try { setBs(await api.binanceState()); } catch {}
    try {
      const c = await api.binanceConfig();
      setConfig(c.config);
    } catch {}
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  // Sync form when config loads (only the first time, to avoid clobbering user edits)
  const [synced, setSynced] = useState(false);
  useEffect(() => {
    if (config && !synced) {
      setStake(String(config.hf.stake));
      setLeverage(String(config.hf.leverage));
      setEnabled(!!config.hf.enabled);
      setAllowMultiple(!!config.hf.allowMultiplePerKey);
      setPerPattern(config.hf.perPatternEnabled);
      setPerAssetEnabled(config.hf.perAssetEnabled);
      setSynced(true);
    }
  }, [config, synced]);

  if (!bs || !config) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const testnet = !!bs.testnet;
  const allOpen = (bs.state?.open ?? []) as any[];
  const allClosed = (bs.state?.closed ?? []) as any[];
  const hfOpen = allOpen.filter((t) => isHf(t.pattern));
  const hfClosedAll = allClosed.filter((t) => isHf(t.pattern));
  const today = todayUtc();
  const hfClosedToday = hfClosedAll.filter((t) => t.closeEpoch && new Date(t.closeEpoch * 1000).toISOString().slice(0, 10) === today);
  const todayPnl = hfClosedToday.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // ── Equity curve points (sorted by closeEpoch, cumulative PnL) ──
  const equityPoints = useMemo(() => {
    const sorted = hfClosedAll.slice().sort((a, b) => (a.closeEpoch ?? 0) - (b.closeEpoch ?? 0));
    let cum = 0;
    return sorted.map((t) => { cum += t.pnl ?? 0; return { ts: t.closeEpoch ?? 0, balance: cum }; });
  }, [hfClosedAll]);

  async function doCancel(id: string) {
    setCancelErr(null);
    setCancelBusy((p) => ({ ...p, [id]: true }));
    try {
      const r = await api.binanceCancelTrade(id);
      if (!r.ok) setCancelErr(r.error ?? "Cancel failed");
      else refresh();
    } finally {
      setCancelBusy((p) => { const next = { ...p }; delete next[id]; return next; });
    }
  }

  async function saveConfig() {
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await api.binanceUpdateConfig({
        hf: {
          enabled,
          stake: Number(stake) || 1,
          leverage: Number(leverage) || 30,
          allowMultiplePerKey: allowMultiple,
          perPatternEnabled: perPattern,
          perAssetEnabled,
        },
      });
      setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error ?? "Save failed" });
      if (r.ok) refresh();
    } catch (e: any) {
      setSaveMsg({ ok: false, text: e?.message ?? "Save failed" });
    } finally {
      setSaveBusy(false);
      setTimeout(() => setSaveMsg(null), 3000);
    }
  }

  return (
    <>
      {/* ── Header / stats ───────────────────────────────────────── */}
      <div className="grid grid-4">
        <div className="card card-padded">
          <div className="card-title">HF status</div>
          <div className="card-value" style={{ color: enabled && bs.running ? "#5fd4a4" : "#888" }}>
            {!bs.running ? "Engine off" : enabled ? "● ON" : "○ OFF"}
          </div>
          <div className="card-sub">{bs.running ? "Engine running" : "Engine stopped"}</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Today's HF P&amp;L</div>
          <div className="card-value" style={{ color: todayPnl >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}
          </div>
          <div className="card-sub">{hfClosedToday.length} closed today</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Open HF</div>
          <div className="card-value">{hfOpen.length}</div>
          <div className="card-sub">{hfOpen.filter((t) => t.armed).length} armed</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">All-time HF</div>
          <div className="card-value" style={{ color: equityPoints.length && equityPoints[equityPoints.length - 1].balance >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {equityPoints.length ? (equityPoints[equityPoints.length - 1].balance >= 0 ? "+" : "") + "$" + equityPoints[equityPoints.length - 1].balance.toFixed(2) : "$0.00"}
          </div>
          <div className="card-sub">{hfClosedAll.length} trades total</div>
        </div>
      </div>

      {/* ── Open HF positions ──────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Open HF positions ({hfOpen.length})</div>
          <div className="section-sub">
            15m BB stack. Trail-arm at +1×ATR, exit at peak − 0.3×ATR via MARKET reduce-only.
            Click Cancel to force-close any row immediately at market.
          </div>
        </div>
        {cancelErr && <div className="banner banner-warn" style={{ marginBottom: 8 }}>{cancelErr}</div>}
        <div className="card card-padded">
          {hfOpen.length === 0 ? (
            <div className="muted">No HF positions open.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Stake</th><th>Lev</th>
                  <th>Entry</th><th>Peak</th><th>Δ%</th>
                  <th>Armed</th><th>Opened</th><th></th>
                </tr>
              </thead>
              <tbody>
                {hfOpen.map((t: any) => {
                  const pct = ((+t.peakFav - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                  const busy = !!cancelBusy[t.id];
                  return (
                    <tr key={t.id}>
                      <td className="mono">
                        <a href={binanceUrl(t.asset, testnet)} target="_blank" rel="noopener noreferrer"
                           title={`Open ${t.asset} on Binance Futures`}
                           style={{ color: "#7fb3ff", textDecoration: "none" }}>
                          {t.asset} ↗
                        </a>
                      </td>
                      <td>{t.pattern}</td>
                      <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                      <td className="mono">${(+t.stake).toFixed(2)}</td>
                      <td className="mono">{t.leverage}×</td>
                      <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                      <td className="mono">${(+t.peakFav).toFixed(5)}</td>
                      <td className="mono" style={{ color: pct >= 0 ? "#5fd4a4" : "#d4655f" }}>
                        {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                      </td>
                      <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                      <td className="muted">{new Date(t.entryEpoch * 1000).toISOString().slice(11, 16)}</td>
                      <td>
                        <button
                          className="btn btn-warn"
                          disabled={busy}
                          onClick={() => doCancel(t.id)}
                          style={{ padding: "4px 10px", fontSize: 12 }}
                        >
                          {busy ? "…" : "Cancel"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Equity curve ─────────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">HF equity curve</div>
          <div className="section-sub">Cumulative net P&amp;L over all closed HF trades.</div>
        </div>
        <div className="card card-padded">
          {equityPoints.length < 2 ? (
            <div className="muted">Need at least 2 closed HF trades to draw a curve.</div>
          ) : (
            <EquitySvg points={equityPoints} />
          )}
        </div>
      </div>

      {/* ── Config ────────────────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">HF config</div>
          <div className="section-sub">Per-stack sizing + pattern + asset toggles. Save applies live.</div>
        </div>
        <div className="card card-padded">
          <div className="grid grid-3" style={{ gap: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              <span><strong>HF stack enabled</strong></span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
              <span>Allow multiple per (asset × pattern × side)</span>
            </label>
            <div></div>
          </div>
          <div className="grid grid-3" style={{ gap: 16, marginTop: 12 }}>
            <label>
              <div className="muted" style={{ marginBottom: 4 }}>Stake $</div>
              <input value={stake} onChange={(e) => setStake(e.target.value)} className="input" />
            </label>
            <label>
              <div className="muted" style={{ marginBottom: 4 }}>Leverage ×</div>
              <input value={leverage} onChange={(e) => setLeverage(e.target.value)} className="input" />
            </label>
            <div></div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Patterns</div>
            {HF_PATTERNS.map((p) => (
              <label key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input type="checkbox" checked={perPattern[p]} onChange={(e) => setPerPattern({ ...perPattern, [p]: e.target.checked })} />
                <span className="mono">{p}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Assets ({Object.values(perAssetEnabled).filter(Boolean).length} of {Object.keys(perAssetEnabled).length} enabled)</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
              {Object.keys(perAssetEnabled).sort().map((a) => (
                <label key={a} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    checked={!!perAssetEnabled[a]}
                    onChange={(e) => setPerAssetEnabled({ ...perAssetEnabled, [a]: e.target.checked })}
                  />
                  <span className="mono">{a.replace("USDT", "")}</span>
                </label>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 12 }}>
            <button className="btn btn-primary" disabled={saveBusy} onClick={saveConfig}>
              {saveBusy ? "Saving…" : "Save HF config"}
            </button>
            {saveMsg && (
              <span style={{ color: saveMsg.ok ? "#5fd4a4" : "#d4655f", fontSize: 13 }}>
                {saveMsg.text}
              </span>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Tiny SVG equity curve ────────────────────────────────────────────────
function EquitySvg({ points }: { points: Array<{ ts: number; balance: number }> }) {
  const w = 800, h = 200, padL = 50, padR = 20, padT = 12, padB = 22;
  const xs = points.map((p) => p.ts);
  const ys = points.map((p) => p.balance);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(0, ...ys), yMax = Math.max(0, ...ys);
  const xScale = (x: number) => padL + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - padL - padR);
  const yScale = (y: number) => padT + (1 - (y - yMin) / Math.max(1, yMax - yMin)) * (h - padT - padB);
  const zeroY = yScale(0);
  const lastY = ys[ys.length - 1];
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${xScale(p.ts).toFixed(1)},${yScale(p.balance).toFixed(1)}`).join(" ");
  const fmtDate = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 10);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: "#0e1528", borderRadius: 4 }}>
      <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} stroke="#1e2842" strokeDasharray="2,3" />
      <text x={padL - 6} y={zeroY + 4} fill="#888" fontSize="10" textAnchor="end">$0</text>
      <text x={padL - 6} y={yScale(yMax) + 4} fill="#888" fontSize="10" textAnchor="end">${yMax.toFixed(0)}</text>
      <text x={padL - 6} y={yScale(yMin) + 4} fill="#888" fontSize="10" textAnchor="end">${yMin.toFixed(0)}</text>
      <text x={padL} y={h - 6} fill="#888" fontSize="10">{fmtDate(xMin)}</text>
      <text x={w - padR} y={h - 6} fill="#888" fontSize="10" textAnchor="end">{fmtDate(xMax)}</text>
      <path d={path} fill="none" stroke={lastY >= 0 ? "#5fd4a4" : "#d4655f"} strokeWidth={2} />
    </svg>
  );
}

// Paper trading panel — runs the SAME signal detector and trade lifecycle as
// the live engine, but with no real exchange calls. Two sub-views: SMC (1h
// OB/BoS) and HF (15m BB). Independent stake / leverage / asset / pattern
// configuration, separate state, fictional starting wallet.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type BinanceConfig, fmtEatTime, fmtEatDateTime, eatToday, eatDateOf } from "../../api";

const SMC_PATTERNS = new Set(["OB_BULL", "OB_BEAR", "BOS_UP"]);
const HF_PATTERNS = new Set(["BB_UP_SHORT", "BB_LOW_LONG"]);
function isSmc(p: string): boolean { return SMC_PATTERNS.has(p); }
function isHf(p: string): boolean { return HF_PATTERNS.has(p); }

function binanceUrl(symbol: string): string {
  return `https://www.binance.com/en/futures/${symbol}`;
}

/** Paper trades store their P&L in `pnl` already net-of-simulated-fees, AND
 *  populate `realizedPnlExchange + commissionEntry + commissionExit` so the
 *  same broker-truth resolver used elsewhere returns the paper number with
 *  no "est" tag. Reuse the resolver here for consistency. */
function resolvePnl(t: any): { value: number; source: "broker" | "est" } {
  if (typeof t.realizedPnlExchange === "number") {
    const ec = t.commissionEntry ?? 0;
    const xc = t.commissionExit ?? 0;
    return { value: t.realizedPnlExchange - ec - xc, source: "broker" };
  }
  return { value: t.pnl ?? 0, source: "est" };
}

type PaperSubTab = "smc" | "hf" | "config";

export function BinancePaperPanel() {
  const [sub, setSub] = useState<PaperSubTab>("smc");
  const [paper, setPaper] = useState<{ running: boolean; state: any; paperWallet: number } | null>(null);
  const [config, setConfig] = useState<BinanceConfig | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const [startErr, setStartErr] = useState<string | null>(null);

  async function refresh() {
    try { setPaper(await api.binancePaperState()); } catch {}
    try { setConfig((await api.binancePaperConfig()).config); } catch {}
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  if (!paper || !config) return <div className="empty-state">Loading paper engine…</div>;

  async function doStart() {
    setStartBusy(true); setStartErr(null);
    try {
      const r = await api.binancePaperStart();
      if (!r.ok) setStartErr(r.error ?? "Start failed");
      else refresh();
    } finally { setStartBusy(false); }
  }
  async function doStop() {
    setStartBusy(true); setStartErr(null);
    try { await api.binancePaperStop(); refresh(); }
    finally { setStartBusy(false); }
  }

  const allOpen = (paper.state?.open ?? []) as any[];
  const allClosed = (paper.state?.closed ?? []) as any[];
  const wallet = paper.paperWallet;
  const allTimePnl = allClosed.reduce((s, t) => s + resolvePnl(t).value, 0);
  const today = eatToday();
  const closedToday = allClosed.filter((t) => t.closeEpoch && eatDateOf(t.closeEpoch) === today);
  const todayPnl = closedToday.reduce((s, t) => s + resolvePnl(t).value, 0);

  return (
    <>
      {/* ── Header / engine controls ── */}
      <div className="grid grid-4">
        <div className="card card-padded">
          <div className="card-title">Paper engine</div>
          <div className="card-value" style={{ color: paper.running ? "#5fd4a4" : "#888" }}>
            {paper.running ? "● ON" : "○ OFF"}
          </div>
          <div className="card-sub">
            <button
              className={paper.running ? "btn btn-warn" : "btn btn-primary"}
              disabled={startBusy}
              onClick={paper.running ? doStop : doStart}
              style={{ padding: "4px 10px", fontSize: 12, marginTop: 4 }}
            >
              {startBusy ? "…" : paper.running ? "Stop" : "Start"}
            </button>
          </div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Paper wallet</div>
          <div className="card-value" style={{ color: wallet >= 0 ? "#5fd4a4" : "#d4655f" }}>
            ${wallet.toFixed(2)}
          </div>
          <div className="card-sub">starting + realized</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Today's P&amp;L</div>
          <div className="card-value" style={{ color: todayPnl >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {todayPnl >= 0 ? "+" : ""}${todayPnl.toFixed(2)}
          </div>
          <div className="card-sub">{closedToday.length} closed today</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">All-time P&amp;L</div>
          <div className="card-value" style={{ color: allTimePnl >= 0 ? "#5fd4a4" : "#d4655f" }}>
            {allTimePnl >= 0 ? "+" : ""}${allTimePnl.toFixed(2)}
          </div>
          <div className="card-sub">{allClosed.length} trades total</div>
        </div>
      </div>

      {startErr && <div className="banner banner-warn" style={{ marginTop: 8 }}>{startErr}</div>}

      {/* ── Sub-tab nav ── */}
      <div style={{ display: "flex", gap: 8, marginTop: 16, marginBottom: 16, borderBottom: "1px solid #1e2842" }}>
        {([
          { id: "smc",    label: "Paper SMC (1h)",    icon: "▣" },
          { id: "hf",     label: "Paper HF (15m)",    icon: "⚡" },
          { id: "config", label: "Paper config",      icon: "⚙" },
        ] as { id: PaperSubTab; label: string; icon: string }[]).map((t) => (
          <button
            key={t.id}
            onClick={() => setSub(t.id)}
            style={{
              background: sub === t.id ? "#1e2842" : "transparent",
              color: sub === t.id ? "#e0e5f5" : "#7a8497",
              border: "none", borderBottom: sub === t.id ? "2px solid #fcd535" : "2px solid transparent",
              padding: "8px 14px", cursor: "pointer", fontSize: 13, fontWeight: 500,
            }}
          >
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {sub === "smc"    && <PaperSmcSection paper={paper} refresh={refresh} />}
      {sub === "hf"     && <PaperHfSection paper={paper} config={config} refresh={refresh} />}
      {sub === "config" && <PaperConfigSection config={config} paperWallet={wallet} refresh={refresh} />}
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Paper SMC sub-section
// ───────────────────────────────────────────────────────────────────────────

function PaperSmcSection({ paper, refresh }: { paper: any; refresh: () => Promise<void> }) {
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  const smcOpen = ((paper.state?.open ?? []) as any[]).filter((t) => isSmc(t.pattern));
  const smcClosed = ((paper.state?.closed ?? []) as any[]).filter((t) => isSmc(t.pattern))
    .slice().sort((a: any, b: any) => (b.closeEpoch ?? 0) - (a.closeEpoch ?? 0));
  const totalUpnl = smcOpen.reduce((s, t) => {
    const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
    const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
    return s + (+t.stake) * (+t.leverage) * (livePct / 100);
  }, 0);

  async function doCancel(id: string) {
    setCancelErr(null); setCancelBusy((p) => ({ ...p, [id]: true }));
    try {
      const r = await api.binancePaperCancelTrade(id);
      if (!r.ok) setCancelErr(r.error ?? "Cancel failed");
      else refresh();
    } finally { setCancelBusy((p) => { const next = { ...p }; delete next[id]; return next; }); }
  }

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">
            Paper SMC open ({smcOpen.length}) — uPnL{" "}
            <span style={{ color: totalUpnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
              {totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)}
            </span>
          </div>
          <div className="section-sub">1h OB_BULL · OB_BEAR · BOS_UP. Trail-arm fires at +1×ATR; exits at peak − 0.3×ATR via simulated MARKET reduce-only.</div>
        </div>
        {cancelErr && <div className="banner banner-warn" style={{ marginBottom: 8 }}>{cancelErr}</div>}
        <div className="card card-padded">
          {smcOpen.length === 0 ? (
            <div className="muted">No paper SMC positions open.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Stake</th><th>Lev</th>
                  <th>Entry</th><th>Mark</th><th>Peak</th>
                  <th>Δ%</th><th>uPnL</th><th>Armed</th><th>Opened (EAT)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {smcOpen.map((t: any) => {
                  const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
                  const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                  const peakPct = ((+t.peakFav - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                  const uPnl = (+t.stake) * (+t.leverage) * (livePct / 100);
                  const busy = !!cancelBusy[t.id];
                  return (
                    <tr key={t.id}>
                      <td className="mono">
                        <a href={binanceUrl(t.asset)} target="_blank" rel="noopener noreferrer"
                           style={{ color: "#7fb3ff", textDecoration: "none" }}>{t.asset} ↗</a>
                      </td>
                      <td>{t.pattern}</td>
                      <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                      <td className="mono">${(+t.stake).toFixed(2)}</td>
                      <td className="mono">{t.leverage}×</td>
                      <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                      <td className="mono">${mark.toFixed(5)}</td>
                      <td className="mono muted" title={`Peak: ${peakPct >= 0 ? "+" : ""}${peakPct.toFixed(2)}%`}>${(+t.peakFav).toFixed(5)}</td>
                      <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%</td>
                      <td className="mono" style={{ color: uPnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</td>
                      <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                      <td className="muted">{fmtEatTime(t.entryEpoch)}</td>
                      <td>
                        <button className="btn btn-warn" disabled={busy} onClick={() => doCancel(t.id)} style={{ padding: "4px 10px", fontSize: 12 }}>
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

      <ClosedTradesTable title="Paper SMC closed trades" trades={smcClosed} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Paper HF sub-section
// ───────────────────────────────────────────────────────────────────────────

function PaperHfSection({ paper, config, refresh }: { paper: any; config: BinanceConfig; refresh: () => Promise<void> }) {
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  const hfOpen = ((paper.state?.open ?? []) as any[]).filter((t) => isHf(t.pattern));
  const hfClosed = ((paper.state?.closed ?? []) as any[]).filter((t) => isHf(t.pattern))
    .slice().sort((a: any, b: any) => (b.closeEpoch ?? 0) - (a.closeEpoch ?? 0));
  const totalUpnl = hfOpen.reduce((s, t) => {
    const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
    const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
    return s + (+t.stake) * (+t.leverage) * (livePct / 100);
  }, 0);

  async function doCancel(id: string) {
    setCancelErr(null); setCancelBusy((p) => ({ ...p, [id]: true }));
    try {
      const r = await api.binancePaperCancelTrade(id);
      if (!r.ok) setCancelErr(r.error ?? "Cancel failed");
      else refresh();
    } finally { setCancelBusy((p) => { const next = { ...p }; delete next[id]; return next; }); }
  }

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">
            Paper HF open ({hfOpen.length}) — uPnL{" "}
            <span style={{ color: totalUpnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
              {totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)}
            </span>
          </div>
          <div className="section-sub">
            15m BB_UP_SHORT + BB_LOW_LONG. HF stack {config.hf.enabled ? <b style={{ color: "#5fd4a4" }}>ENABLED</b> : <span style={{ color: "#d4655f" }}>DISABLED</span>} in paper config.
            Stake ${config.hf.stake} × {config.hf.leverage}×.
          </div>
        </div>
        {cancelErr && <div className="banner banner-warn" style={{ marginBottom: 8 }}>{cancelErr}</div>}
        <div className="card card-padded">
          {hfOpen.length === 0 ? (
            <div className="muted">No paper HF positions open.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Stake</th><th>Lev</th>
                  <th>Entry</th><th>Mark</th><th>Peak</th>
                  <th>Δ%</th><th>uPnL</th><th>Armed</th><th>Opened (EAT)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {hfOpen.map((t: any) => {
                  const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
                  const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                  const peakPct = ((+t.peakFav - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
                  const uPnl = (+t.stake) * (+t.leverage) * (livePct / 100);
                  const busy = !!cancelBusy[t.id];
                  return (
                    <tr key={t.id}>
                      <td className="mono">
                        <a href={binanceUrl(t.asset)} target="_blank" rel="noopener noreferrer"
                           style={{ color: "#7fb3ff", textDecoration: "none" }}>{t.asset} ↗</a>
                      </td>
                      <td>{t.pattern}</td>
                      <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                      <td className="mono">${(+t.stake).toFixed(2)}</td>
                      <td className="mono">{t.leverage}×</td>
                      <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                      <td className="mono">${mark.toFixed(5)}</td>
                      <td className="mono muted" title={`Peak: ${peakPct >= 0 ? "+" : ""}${peakPct.toFixed(2)}%`}>${(+t.peakFav).toFixed(5)}</td>
                      <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%</td>
                      <td className="mono" style={{ color: uPnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</td>
                      <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                      <td className="muted">{fmtEatTime(t.entryEpoch)}</td>
                      <td>
                        <button className="btn btn-warn" disabled={busy} onClick={() => doCancel(t.id)} style={{ padding: "4px 10px", fontSize: 12 }}>
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

      <ClosedTradesTable title="Paper HF closed trades" trades={hfClosed} />
    </>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Closed trades table (shared between SMC and HF sections)
// ───────────────────────────────────────────────────────────────────────────

function ClosedTradesTable({ title, trades }: { title: string; trades: any[] }) {
  const wins = trades.filter((t) => resolvePnl(t).value > 0).length;
  const total = trades.reduce((s, t) => s + resolvePnl(t).value, 0);
  const wr = trades.length ? (wins / trades.length) * 100 : 0;

  return (
    <div className="section">
      <div className="section-header">
        <div className="section-title">
          {title} ({trades.length}) — WR {wr.toFixed(1)}% — total{" "}
          <span style={{ color: total >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
            {total >= 0 ? "+" : ""}${total.toFixed(2)}
          </span>
        </div>
      </div>
      <div className="card card-padded">
        {trades.length === 0 ? (
          <div className="muted">No closed trades yet.</div>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Closed (EAT)</th><th>Asset</th><th>Pattern</th><th>Side</th>
                <th>Entry</th><th>Exit</th><th>Stake</th><th>P&amp;L</th>
              </tr>
            </thead>
            <tbody>
              {trades.slice(0, 200).map((t: any) => {
                const p = resolvePnl(t);
                return (
                  <tr key={t.id}>
                    <td className="muted">{t.closeEpoch ? fmtEatDateTime(t.closeEpoch) : "—"}</td>
                    <td className="mono">
                      <a href={binanceUrl(t.asset)} target="_blank" rel="noopener noreferrer"
                         style={{ color: "#7fb3ff", textDecoration: "none" }}>{t.asset} ↗</a>
                    </td>
                    <td>{t.pattern}</td>
                    <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                    <td className="mono">${(+(t.closePrice ?? 0)).toFixed(5)}</td>
                    <td className="mono">${(+t.stake).toFixed(2)}</td>
                    <td className="mono" style={{ color: p.value >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
                      {p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Config section — independent stake/lev/patterns/assets for SMC and HF
// ───────────────────────────────────────────────────────────────────────────

function PaperConfigSection({ config, paperWallet, refresh }: { config: BinanceConfig; paperWallet: number; refresh: () => Promise<void> }) {
  // Local form state, mirroring config but as strings for type-friendliness
  const [smcStake, setSmcStake] = useState(String(config.stake));
  const [smcLev, setSmcLev] = useState(String(config.leverage));
  const [smcMaxLoss, setSmcMaxLoss] = useState(String(config.dailyMaxLoss));
  const [smcPatterns, setSmcPatterns] = useState(config.perPatternEnabled);
  const [smcAssets, setSmcAssets] = useState(config.perAssetEnabled);

  const [hfEnabled, setHfEnabled] = useState(config.hf.enabled);
  const [hfStake, setHfStake] = useState(String(config.hf.stake));
  const [hfLev, setHfLev] = useState(String(config.hf.leverage));
  const [hfPatterns, setHfPatterns] = useState(config.hf.perPatternEnabled);
  const [hfAssets, setHfAssets] = useState(config.hf.perAssetEnabled);

  const [martMode, setMartMode] = useState(config.martingale.mode);
  const [martMult, setMartMult] = useState(String(config.martingale.multiplier));
  const [martCap, setMartCap] = useState(String(config.martingale.maxLevels));

  const [walletInput, setWalletInput] = useState(String(paperWallet.toFixed(2)));

  const [saveBusy, setSaveBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [resetBusy, setResetBusy] = useState(false);

  // Re-sync local state when config changes (e.g. another tab updated it)
  const syncRef = useRef(false);
  useEffect(() => {
    if (syncRef.current) return;
    syncRef.current = true;
  }, [config]);

  async function save() {
    setSaveBusy(true); setSaveMsg(null);
    try {
      const r = await api.binancePaperUpdateConfig({
        stake: Number(smcStake) || 1,
        leverage: Number(smcLev) || 30,
        dailyMaxLoss: Number(smcMaxLoss) || 100,
        perPatternEnabled: smcPatterns,
        perAssetEnabled: smcAssets,
        martingale: { mode: martMode, multiplier: Number(martMult) || 2, maxLevels: Number(martCap) || 3 },
        hf: {
          enabled: hfEnabled,
          stake: Number(hfStake) || 1,
          leverage: Number(hfLev) || 30,
          allowMultiplePerKey: config.hf.allowMultiplePerKey,
          perPatternEnabled: hfPatterns,
          perAssetEnabled: hfAssets,
        },
      });
      setSaveMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error ?? "Save failed" });
      if (r.ok) refresh();
    } catch (e: any) { setSaveMsg({ ok: false, text: e?.message ?? "Save failed" }); }
    finally { setSaveBusy(false); setTimeout(() => setSaveMsg(null), 3000); }
  }

  async function resetWallet() {
    if (!confirm(`Reset paper wallet to $${Number(walletInput).toFixed(2)}? This also CLEARS all open and closed paper trades.`)) return;
    setResetBusy(true);
    try {
      await api.binancePaperResetWallet(Number(walletInput));
      refresh();
    } finally { setResetBusy(false); }
  }

  const sortedAssets = Object.keys(config.perAssetEnabled).sort();

  return (
    <>
      {/* ── Wallet reset ── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Paper wallet</div>
          <div className="section-sub">Reset clears ALL open and closed paper trades. Use this to start a fresh test.</div>
        </div>
        <div className="card card-padded" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span>Reset to $</span>
          <input value={walletInput} onChange={(e) => setWalletInput(e.target.value)} className="input" style={{ width: 100 }} />
          <button className="btn btn-warn" disabled={resetBusy} onClick={resetWallet}>{resetBusy ? "…" : "Reset wallet + trades"}</button>
        </div>
      </div>

      {/* ── SMC config ── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Paper SMC config (1h)</div>
          <div className="section-sub">Stake, leverage, daily-loss cap, and per-pattern/per-asset toggles. Identical knobs to live.</div>
        </div>
        <div className="card card-padded">
          <div className="grid grid-3" style={{ gap: 16 }}>
            <label><div className="muted" style={{ marginBottom: 4 }}>Stake $</div>
              <input value={smcStake} onChange={(e) => setSmcStake(e.target.value)} className="input" /></label>
            <label><div className="muted" style={{ marginBottom: 4 }}>Leverage ×</div>
              <input value={smcLev} onChange={(e) => setSmcLev(e.target.value)} className="input" /></label>
            <label><div className="muted" style={{ marginBottom: 4 }}>Daily max loss $</div>
              <input value={smcMaxLoss} onChange={(e) => setSmcMaxLoss(e.target.value)} className="input" /></label>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Patterns</div>
            {(["OB_BULL", "OB_BEAR", "BOS_UP"] as const).map((p) => (
              <label key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input type="checkbox" checked={smcPatterns[p]} onChange={(e) => setSmcPatterns({ ...smcPatterns, [p]: e.target.checked })} />
                <span className="mono">{p}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              Assets ({Object.values(smcAssets).filter(Boolean).length} of {sortedAssets.length} enabled)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
              {sortedAssets.map((a) => (
                <label key={a} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                  <input type="checkbox" checked={!!smcAssets[a]} onChange={(e) => setSmcAssets({ ...smcAssets, [a]: e.target.checked })} />
                  <span className="mono">{a.replace("USDT", "")}</span>
                </label>
              ))}
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Anti-martingale (Paroli)</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <label><input type="radio" checked={martMode === "off"} onChange={() => setMartMode("off")} /> off</label>
              <label><input type="radio" checked={martMode === "anti"} onChange={() => setMartMode("anti")} /> anti (compound after wins)</label>
              <span className="muted" style={{ marginLeft: 12 }}>×</span>
              <input value={martMult} onChange={(e) => setMartMult(e.target.value)} className="input" style={{ width: 60 }} />
              <span className="muted">cap</span>
              <input value={martCap} onChange={(e) => setMartCap(e.target.value)} className="input" style={{ width: 60 }} />
            </div>
          </div>
        </div>
      </div>

      {/* ── HF config ── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Paper HF config (15m)</div>
          <div className="section-sub">Independent stake/leverage from SMC. Defaults: $1 × 30× per HF trade.</div>
        </div>
        <div className="card card-padded">
          <div className="grid grid-3" style={{ gap: 16, marginBottom: 12 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" checked={hfEnabled} onChange={(e) => setHfEnabled(e.target.checked)} />
              <span><strong>HF stack enabled</strong></span>
            </label>
          </div>
          <div className="grid grid-3" style={{ gap: 16 }}>
            <label><div className="muted" style={{ marginBottom: 4 }}>Stake $</div>
              <input value={hfStake} onChange={(e) => setHfStake(e.target.value)} className="input" /></label>
            <label><div className="muted" style={{ marginBottom: 4 }}>Leverage ×</div>
              <input value={hfLev} onChange={(e) => setHfLev(e.target.value)} className="input" /></label>
            <div></div>
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>Patterns</div>
            {(["BB_UP_SHORT", "BB_LOW_LONG"] as const).map((p) => (
              <label key={p} style={{ display: "inline-flex", alignItems: "center", gap: 6, marginRight: 16 }}>
                <input type="checkbox" checked={hfPatterns[p]} onChange={(e) => setHfPatterns({ ...hfPatterns, [p]: e.target.checked })} />
                <span className="mono">{p}</span>
              </label>
            ))}
          </div>
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>
              HF assets ({Object.values(hfAssets).filter(Boolean).length} of {sortedAssets.length} enabled)
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6 }}>
              {sortedAssets.map((a) => (
                <label key={a} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
                  <input type="checkbox" checked={!!hfAssets[a]} onChange={(e) => setHfAssets({ ...hfAssets, [a]: e.target.checked })} />
                  <span className="mono">{a.replace("USDT", "")}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── Save bar ── */}
      <div className="section">
        <div className="card card-padded" style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <button className="btn btn-primary" disabled={saveBusy} onClick={save}>{saveBusy ? "Saving…" : "Save paper config"}</button>
          {saveMsg && <span style={{ color: saveMsg.ok ? "#5fd4a4" : "#d4655f", fontSize: 13 }}>{saveMsg.text}</span>}
        </div>
      </div>
    </>
  );
}

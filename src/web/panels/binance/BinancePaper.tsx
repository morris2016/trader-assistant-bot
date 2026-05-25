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

/** Binance USDT-M Perpetuals max leverage by symbol ($0-50K notional tier). */
const BINANCE_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75,
  LINKUSDT: 75, ADAUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};

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

  // HF Paroli (anti-mart) — separate from SMC mart above
  const hfMart = (config.hf as any).martingale ?? { mode: "off", multiplier: 2, maxLevels: 3 };
  const [hfMartMode, setHfMartMode] = useState<"off" | "anti">(hfMart.mode);
  const [hfMartMult, setHfMartMult] = useState(String(hfMart.multiplier));
  const [hfMartCap, setHfMartCap] = useState(String(hfMart.maxLevels));

  // Percentage SL — % of stake (so max-$-loss = stake × slPct/100)
  const [smcSlPct, setSmcSlPct] = useState(String((config as any).slPctSmc ?? 0));
  const [hfSlPct, setHfSlPct] = useState(String((config.hf as any).slPct ?? 0));

  // Risk rules — safety nets only (edge filters htfTrend/ER/volumeMult removed
  // 2026-05-25 after factor mining showed they hurt P&L).
  const rr = config.riskRules ?? { enabled: false };
  const [riskEnabled, setRiskEnabled] = useState(!!rr.enabled);
  const [maxConcurrent, setMaxConcurrent] = useState(String(rr.maxConcurrentPositions ?? 3));
  const [maxPerBucket, setMaxPerBucket] = useState(String(rr.maxPositionsPerBucket ?? 1));
  const [monthlyLossPct, setMonthlyLossPct] = useState(String(((rr.monthlyLossCircuitBreakerPct ?? 0.06) * 100).toFixed(1)));
  const [perTradeRiskPct, setPerTradeRiskPct] = useState(String((((rr as any).perTradeRiskPctOfEquity ?? 0.02) * 100).toFixed(1)));

  // HF quality filter — validated 2026-05-25 (199K trades, 27/27 months profitable filtered)
  const qf = (config.hf as any).qualityFilter ?? { enabled: false };
  const [qfEnabled, setQfEnabled] = useState(!!qf.enabled);
  const [qfHours, setQfHours] = useState<string>((qf.hoursUtc ?? [12,13,14,15,16,17,18,19,20,21,22]).join(","));
  const [qfBbPctile, setQfBbPctile] = useState(String(((qf.minBbWidthPercentile ?? 0.5) * 100).toFixed(0)));
  const [qfVolPctile, setQfVolPctile] = useState(String(((qf.minVolumePercentile ?? 0.5) * 100).toFixed(0)));

  // Per-asset HF leverage — defaults to each symbol's Binance max
  const initialPerAssetLev: Record<string, number> = (config.hf as any).perAssetLeverage ?? {};
  const [perAssetLev, setPerAssetLev] = useState<Record<string, string>>(
    Object.fromEntries(Object.keys(config.hf.perAssetEnabled).map(a => [a, String(initialPerAssetLev[a] ?? config.hf.leverage)]))
  );

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
          martingale: { mode: hfMartMode, multiplier: Number(hfMartMult) || 2, maxLevels: Number(hfMartCap) || 3 },
          slPct: Number(hfSlPct) || 0,
          perAssetLeverage: Object.fromEntries(Object.entries(perAssetLev).map(([k, v]) => [k, Number(v) || config.hf.leverage])),
          qualityFilter: {
            enabled: qfEnabled,
            hoursUtc: qfHours.split(",").map(s => +s.trim()).filter(n => Number.isFinite(n) && n >= 0 && n <= 23),
            minBbWidthPercentile: (Number(qfBbPctile) || 50) / 100,
            minVolumePercentile: (Number(qfVolPctile) || 50) / 100,
            rollingWindowBars: 200,
          },
        },
        slPctSmc: Number(smcSlPct) || 0,
        riskRules: {
          enabled: riskEnabled,
          maxConcurrentPositions: Number(maxConcurrent) || 3,
          maxPositionsPerBucket: Number(maxPerBucket) || 1,
          monthlyLossCircuitBreakerPct: (Number(monthlyLossPct) || 6) / 100,
          perTradeRiskPctOfEquity: (Number(perTradeRiskPct) || 2) / 100,
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
          <div style={{ marginTop: 16 }}>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Hard SL as % of STAKE. Example: stake $50 × 50% = max $25 loss at SL. Price move = slPct / leverage (so 50% on a 30× trade = 1.67% price move). 0 = disabled (trail-arm only).">
                SMC SL % of stake (max-$-loss = stake × this/100)
              </div>
              <input value={smcSlPct} onChange={(e) => setSmcSlPct(e.target.value)} className="input" style={{ width: 120 }} />
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                → max loss ≈ ${(Number(smcStake) * Number(smcSlPct) / 100 || 0).toFixed(2)}{" "}
                ({Number(smcSlPct) > 0 && Number(smcLev) > 0 ? `${(Number(smcSlPct) / Number(smcLev)).toFixed(3)}% price move` : "disabled"})
              </span>
            </label>
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
          <div style={{ marginTop: 16 }}>
            <div className="muted" style={{ marginBottom: 6 }}>HF anti-martingale (Paroli) — independent ladder from SMC</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <label><input type="radio" checked={hfMartMode === "off"} onChange={() => setHfMartMode("off")} /> off</label>
              <label><input type="radio" checked={hfMartMode === "anti"} onChange={() => setHfMartMode("anti")} /> anti (compound after wins)</label>
              <span className="muted" style={{ marginLeft: 12 }}>×</span>
              <input value={hfMartMult} onChange={(e) => setHfMartMult(e.target.value)} className="input" style={{ width: 60 }} />
              <span className="muted">cap</span>
              <input value={hfMartCap} onChange={(e) => setHfMartCap(e.target.value)} className="input" style={{ width: 60 }} />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Hard SL as % of STAKE for HF trades. Price move = slPct / hf.leverage. 0 = disabled.">
                HF SL % of stake (max-$-loss = stake × this/100)
              </div>
              <input value={hfSlPct} onChange={(e) => setHfSlPct(e.target.value)} className="input" style={{ width: 120 }} />
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                → max loss ≈ ${(Number(hfStake) * Number(hfSlPct) / 100 || 0).toFixed(2)}{" "}
                ({Number(hfSlPct) > 0 && Number(hfLev) > 0 ? `${(Number(hfSlPct) / Number(hfLev)).toFixed(3)}% price move` : "disabled"})
              </span>
            </label>
          </div>

          {/* HF quality filter (validated 2026-05-25 on 199K trades) */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #1e2842" }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={qfEnabled} onChange={(e) => setQfEnabled(e.target.checked)} />
                <strong>HF quality filter</strong>
                <span className="muted" style={{ fontSize: 12 }}>— validated +$1.43/trade vs +$0.32 baseline (29-month, 199K trades)</span>
              </label>
            </div>
            <div className="grid grid-3" style={{ gap: 16 }}>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Comma-separated UTC hours when entries are allowed. Default [12-22] = NY morning + afternoon. Yesterday's worst hour was 6h UTC (Asian midday low-liquidity).">
                  Allowed hours (UTC)
                </div>
                <input value={qfHours} onChange={(e) => setQfHours(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Require current bbWidth in top X% of last 200 15m bars. Higher = wider bands = better edge (BB-revert needs vol). Default 50.">
                  bbWidth top % (rolling 200 bars)
                </div>
                <input value={qfBbPctile} onChange={(e) => setQfBbPctile(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Require current bar's volume in top X% of last 200 bars. Activity proxy — quiet markets fade harder. Default 50.">
                  volume top % (rolling 200 bars)
                </div>
                <input value={qfVolPctile} onChange={(e) => setQfVolPctile(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
            </div>
          </div>

          {/* Per-asset HF leverage table */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #1e2842" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div className="muted">
                <strong>Per-asset HF leverage</strong> — each input shows Binance max for that symbol. Set ≤ max; exceeding rejects on order placement.
              </div>
              <button
                type="button"
                className="btn"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => setPerAssetLev(Object.fromEntries(sortedAssets.map(a => [a, String(BINANCE_MAX_LEV[a] ?? 30)])))}
              >
                Reset all to max
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {sortedAssets.map((a) => {
                const max = BINANCE_MAX_LEV[a] ?? 30;
                const cur = Number(perAssetLev[a]) || 0;
                const overMax = cur > max;
                return (
                  <label key={a} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                    <span className="mono" style={{ width: 50 }}>{a.replace("USDT", "")}</span>
                    <input
                      value={perAssetLev[a] ?? ""}
                      onChange={(e) => setPerAssetLev({ ...perAssetLev, [a]: e.target.value })}
                      className="input"
                      style={{ width: 60, borderColor: overMax ? "#d4655f" : undefined }}
                    />
                    <span className="muted">×</span>
                    <span style={{ color: overMax ? "#d4655f" : "#5fd4a4", fontSize: 11 }}>
                      max {max}{overMax ? " ⚠" : ""}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* ── Risk rules (safety nets only — edge filters removed 2026-05-25) ── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Risk rules (safety nets)</div>
          <div className="section-sub">
            Caps and circuit-breakers only — edge filters (HTF trend / Efficiency Ratio /
            volume × SMA) were removed 2026-05-25 after factor mining showed they
            reduced P&L. The HF quality filter above replaces all three.
            Default OFF; enable individual caps as protection against tail events.
          </div>
        </div>
        <div className="card card-padded">
          <label style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={riskEnabled} onChange={(e) => setRiskEnabled(e.target.checked)} />
            <span><strong>Risk-rules enabled</strong> (master switch)</span>
          </label>
          <div className="grid grid-3" style={{ gap: 16 }}>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Vantage rule: ≤ 3 concurrent positions across the whole book">
                Max concurrent positions
              </div>
              <input value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} className="input" disabled={!riskEnabled} />
            </label>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Buckets: {BTC,ETH,BCH} · {SOL,AVAX,BNB} · {LDO,AAVE,UNI,LINK} · {XRP,ADA,DOT,POL} · {DOGE}. 1 = at most 1 trade per bucket open at any time.">
                Max positions per correlation bucket
              </div>
              <input value={maxPerBucket} onChange={(e) => setMaxPerBucket(e.target.value)} className="input" disabled={!riskEnabled} />
            </label>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Elder rule: halt all entries when month-to-date realized P&L < -X% of month-start equity. 6% is Elder's literal threshold.">
                Monthly loss circuit breaker (%)
              </div>
              <input value={monthlyLossPct} onChange={(e) => setMonthlyLossPct(e.target.value)} className="input" disabled={!riskEnabled} />
            </label>
            <label>
              <div className="muted" style={{ marginBottom: 4 }} title="Elder's 2% rule: refuse any trade whose worst-case loss (1×ATR stop × stake × leverage) would exceed X% of current equity. Default 2%; tighten to 1% for sub-$100 accounts.">
                Per-trade risk cap (% of equity)
              </div>
              <input value={perTradeRiskPct} onChange={(e) => setPerTradeRiskPct(e.target.value)} className="input" disabled={!riskEnabled} />
            </label>
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

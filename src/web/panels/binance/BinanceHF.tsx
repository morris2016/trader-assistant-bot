// Binance HF (15m BB) — dedicated panel for the BB_UP_SHORT + BB_LOW_LONG
// stack. Shows open HF positions with per-row Cancel, config knobs,
// equity curve, and filtered HF-only logs.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type BinanceConfig, type LogEntry, fmtEatTime, eatToday, eatDateOf, isoToEatHms } from "../../api";

const HF_PATTERNS = ["BB_UP_SHORT", "BB_LOW_LONG"] as const;
type HfPattern = (typeof HF_PATTERNS)[number];

function isHf(p: string): boolean { return p === "BB_UP_SHORT" || p === "BB_LOW_LONG"; }

const BINANCE_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75,
  LINKUSDT: 75, ADAUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

/** Resolve a closed trade's P&L. Prefers exchange-truth (realizedPnlExchange
 *  − commissions) when the user-data stream has populated it; otherwise falls
 *  back to the bot's local estimate. */
function resolvePnl(t: any): { value: number; source: "broker" | "est" } {
  if (typeof t.realizedPnlExchange === "number") {
    const ec = t.commissionEntry ?? 0;
    const xc = t.commissionExit ?? 0;
    return { value: t.realizedPnlExchange - ec - xc, source: "broker" };
  }
  return { value: t.pnl ?? 0, source: "est" };
}

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
  // HF Paroli (anti-mart) — independent ladder from SMC
  const [hfMartMode, setHfMartMode] = useState<"off" | "anti">("off");
  const [hfMartMult, setHfMartMult] = useState("2");
  const [hfMartCap, setHfMartCap] = useState("3");
  // Hard SL as % of stake (max-$-loss = stake × this/100)
  const [hfSlPct, setHfSlPct] = useState("0");
  // HF quality filter — validated 2026-05-25
  const [qfEnabled, setQfEnabled] = useState(false);
  const [qfHours, setQfHours] = useState("12,13,14,15,16,17,18,19,20,21,22");
  const [qfBbPctile, setQfBbPctile] = useState("50");
  const [qfVolPctile, setQfVolPctile] = useState("50");
  // Per-asset HF leverage
  const [perAssetLev, setPerAssetLev] = useState<Record<string, string>>({});

  async function refresh() {
    try { setBs(await api.binanceState()); } catch {}
    try {
      const c = await api.binanceConfig();
      setConfig(c.config);
    } catch {}
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  // ── Logs stream — pre-filtered for HF lines ──
  const [logs, setLogs] = useState<LogEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    const fetchLogs = async () => {
      try {
        const r = await api.logs({ limit: 500, q: "binance" });
        if (cancelled) return;
        // Keep only HF-related events: HF heartbeat/warmup/signals/skips,
        // and trade-open/close lines whose pattern is a BB_*.
        const filtered = r.logs.filter((e) => {
          const m = e.msg ?? "";
          if (/\bHF\b/.test(m)) return true;
          if (/BB_UP_SHORT|BB_LOW_LONG/.test(m)) return true;
          const pat = (e as any).pattern;
          if (pat === "BB_UP_SHORT" || pat === "BB_LOW_LONG") return true;
          return false;
        });
        setLogs(filtered);
      } catch {}
    };
    fetchLogs();
    const id = setInterval(fetchLogs, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Recent HF signals (parsed out of logs) ──
  const recentSignals = useMemo(() => {
    return logs.filter((e) => typeof e.msg === "string" && /HF signals on/.test(e.msg)).slice(-20).reverse();
  }, [logs]);

  // ── Per-open-trade live progress snapshots (ref, ephemeral, ~5min window) ──
  const progressRef = useRef<Map<string, Array<{ ts: number; pct: number }>>>(new Map());
  // On every bs refresh, snapshot each open trade's current Δ% and drop dead trades
  useEffect(() => {
    if (!bs) return;
    const open = (bs.state?.open ?? []) as any[];
    const now = Math.floor(Date.now() / 1000);
    const aliveIds = new Set<string>();
    for (const t of open) {
      if (!isHf(t.pattern)) continue;
      aliveIds.add(t.id);
      const arr = progressRef.current.get(t.id) ?? [];
      // Use live mark price so the chart shows real adverse moves, not just
      // the peak-favorable envelope.
      const ref = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
      const pct = ((ref - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
      arr.push({ ts: now, pct });
      if (arr.length > 600) arr.splice(0, arr.length - 600); // 600 samples × 3s ≈ 30min window
      progressRef.current.set(t.id, arr);
    }
    // Drop snapshots for trades no longer open
    for (const id of Array.from(progressRef.current.keys())) {
      if (!aliveIds.has(id)) progressRef.current.delete(id);
    }
  }, [bs]);

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
      const hm = (config.hf as any).martingale ?? { mode: "off", multiplier: 2, maxLevels: 3 };
      setHfMartMode(hm.mode);
      setHfMartMult(String(hm.multiplier));
      setHfMartCap(String(hm.maxLevels));
      setHfSlPct(String((config.hf as any).slPct ?? 0));
      const qf = (config.hf as any).qualityFilter ?? { enabled: false };
      setQfEnabled(!!qf.enabled);
      setQfHours((qf.hoursUtc ?? [12,13,14,15,16,17,18,19,20,21,22]).join(","));
      setQfBbPctile(String(((qf.minBbWidthPercentile ?? 0.5) * 100).toFixed(0)));
      setQfVolPctile(String(((qf.minVolumePercentile ?? 0.5) * 100).toFixed(0)));
      const palv: Record<string, number> = (config.hf as any).perAssetLeverage ?? {};
      setPerAssetLev(Object.fromEntries(Object.keys(config.hf.perAssetEnabled).map(a => [a, String(palv[a] ?? config.hf.leverage)])));
      setSynced(true);
    }
  }, [config, synced]);

  // ── Hooks BEFORE any early return so order stays stable across renders ──
  const allClosed = (bs?.state?.closed ?? []) as any[];
  const hfClosedAll = useMemo(() => allClosed.filter((t) => isHf(t.pattern)), [allClosed]);
  // Sorted newest-first for the closed-trades table.
  const hfClosedDesc = useMemo(
    () => hfClosedAll.slice().sort((a, b) => (b.closeEpoch ?? 0) - (a.closeEpoch ?? 0)),
    [hfClosedAll],
  );
  // Equity curve uses broker-truth P&L when available, local estimate otherwise.
  const equityPoints = useMemo(() => {
    const sorted = hfClosedAll.slice().sort((a, b) => (a.closeEpoch ?? 0) - (b.closeEpoch ?? 0));
    let cum = 0;
    return sorted.map((t) => { cum += resolvePnl(t).value; return { ts: t.closeEpoch ?? 0, balance: cum }; });
  }, [hfClosedAll]);

  if (!bs || !config) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const testnet = !!bs.testnet;
  const allOpen = (bs.state?.open ?? []) as any[];
  const hfOpen = allOpen.filter((t) => isHf(t.pattern));
  const today = eatToday();
  const hfClosedToday = hfClosedAll.filter((t) => t.closeEpoch && eatDateOf(t.closeEpoch) === today);
  const todayPnl = hfClosedToday.reduce((s, t) => s + resolvePnl(t).value, 0);
  const hfBrokerCount = hfClosedAll.filter((t) => typeof t.realizedPnlExchange === "number").length;

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
          martingale: { mode: hfMartMode, multiplier: Number(hfMartMult) || 2, maxLevels: Number(hfMartCap) || 3 },
          slPct: Number(hfSlPct) || 0,
          perAssetLeverage: Object.fromEntries(Object.entries(perAssetLev).map(([k, v]) => [k, Number(v) || (Number(leverage) || 30)])),
          qualityFilter: {
            enabled: qfEnabled,
            hoursUtc: qfHours.split(",").map(s => +s.trim()).filter(n => Number.isFinite(n) && n >= 0 && n <= 23),
            minBbWidthPercentile: (Number(qfBbPctile) || 50) / 100,
            minVolumePercentile: (Number(qfVolPctile) || 50) / 100,
            rollingWindowBars: 200,
          },
        } as any,
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
          <div className="card-value" style={{ color: config.hf.enabled && bs.running ? "#5fd4a4" : "#888" }}>
            {!bs.running ? "Engine off" : config.hf.enabled ? "● ON" : "○ OFF"}
          </div>
          <div className="card-sub">
            {bs.running ? "Engine running" : "Engine stopped"}
            {enabled !== config.hf.enabled && <span style={{ color: "#d4a35f", marginLeft: 6 }}>unsaved</span>}
          </div>
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
                  <th>Entry</th><th>Mark</th><th>Peak</th>
                  <th title="Live Δ% from entry to current mark (signed by side)">Δ%</th>
                  <th title="Unrealized $ P&L">uPnL</th>
                  <th>Armed</th><th>Opened (EAT)</th><th></th>
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
                      <td className="mono" title="Live mark price">${mark.toFixed(5)}</td>
                      <td className="mono muted" title={`Peak favorable: ${peakPct >= 0 ? "+" : ""}${peakPct.toFixed(2)}%`}>${(+t.peakFav).toFixed(5)}</td>
                      <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
                        {livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%
                      </td>
                      <td className="mono" style={{ color: uPnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
                        {uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}
                      </td>
                      <td>{t.armed ? <span className="pill pill-green">●</span> : <span className="muted">·</span>}</td>
                      <td className="muted">{fmtEatTime(t.entryEpoch)}</td>
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

      {/* ── Live progress of open trades ─────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Open-trade live progress</div>
          <div className="section-sub">Δ% from entry over time (snapshot every 3s; ~30min rolling window per trade).</div>
        </div>
        <div className="card card-padded">
          {hfOpen.length === 0 ? (
            <div className="muted">No open HF positions to chart.</div>
          ) : (
            <ProgressSvg series={hfOpen.map((t: any) => ({
              id: t.id, label: `${t.asset.replace("USDT", "")} ${t.pattern}/${t.side}`,
              points: progressRef.current.get(t.id) ?? [],
              armed: !!t.armed,
            }))} />
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

      {/* ── HF closed trades ─────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">HF closed trades ({hfClosedAll.length})</div>
          <div className="section-sub">
            BB stack only. P&amp;L source: <b>broker</b> = exchange-truth (realized − commissions);
            <b>est</b> = local estimate (no fees, pre-stream). {hfBrokerCount}/{hfClosedAll.length} broker-verified.
          </div>
        </div>
        <div className="card card-padded">
          {hfClosedAll.length === 0 ? (
            <div className="muted">No closed HF trades yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Closed (EAT)</th><th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Entry</th><th>Exit</th><th>Stake</th><th>P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {hfClosedDesc.slice(0, 200).map((t: any) => {
                  const p = resolvePnl(t);
                  return (
                    <tr key={t.id}>
                      <td className="muted">{t.closeEpoch ? fmtEatTime(t.closeEpoch) : "—"}</td>
                      <td className="mono">
                        <a href={binanceUrl(t.asset, testnet)} target="_blank" rel="noopener noreferrer"
                           title={`Open ${t.asset} on Binance Futures`}
                           style={{ color: "#7fb3ff", textDecoration: "none" }}>
                          {t.asset} ↗
                        </a>
                      </td>
                      <td>{t.pattern}</td>
                      <td><span className={`pill ${t.side === "LONG" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                      <td className="mono">${(+t.entryPrice).toFixed(5)}</td>
                      <td className="mono">${(+(t.closePrice ?? 0)).toFixed(5)}</td>
                      <td className="mono">${(+t.stake).toFixed(2)}</td>
                      <td className="mono" style={{ color: p.value >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>
                        {p.value >= 0 ? "+" : ""}${p.value.toFixed(2)}
                        {p.source === "est" && <span title="Local estimate — fees not deducted, no broker confirmation yet" style={{ marginLeft: 6, color: "#d4a35f", fontSize: 10, fontWeight: 500 }}>est</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Recent HF signals ────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Recent HF signals</div>
          <div className="section-sub">Last 20 BB signal events. Each row = one bar-close detection (may or may not have opened a trade).</div>
        </div>
        <div className="card card-padded">
          {recentSignals.length === 0 ? (
            <div className="muted">No HF signals seen yet.</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Time (EAT)</th><th>Asset</th><th>Pattern(s)</th></tr>
              </thead>
              <tbody>
                {recentSignals.map((e, i) => {
                  const t = isoToEatHms(e.ts ?? "");
                  const asset = (e as any).asset ?? "";
                  const sigs = (e as any).signals as Array<{ pattern: string; side: string; entryPrice: number }> | undefined;
                  return (
                    <tr key={i}>
                      <td className="muted mono">{t}</td>
                      <td className="mono">{asset}</td>
                      <td>
                        {sigs?.map((s, j) => (
                          <span key={j} style={{ marginRight: 10 }}>
                            <span className="mono" style={{ color: "#7fb3ff" }}>{s.pattern}</span>
                            <span className={`pill ${s.side === "LONG" ? "pill-green" : "pill-red"}`} style={{ marginLeft: 4 }}>{s.side}</span>
                            <span className="muted mono" style={{ marginLeft: 4 }}>@ ${s.entryPrice}</span>
                          </span>
                        )) ?? <span className="muted">{e.msg}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── HF logs ──────────────────────────────────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">HF logs</div>
          <div className="section-sub">Live events from the HF stack only. {logs.length} entries buffered.</div>
        </div>
        <div className="card card-padded">
          <div style={{
            background: "#06080f", border: "1px solid #1e2842", borderRadius: 6,
            padding: 10, maxHeight: 400, overflowY: "auto",
            fontFamily: "monospace", fontSize: 11.5, color: "#a8b3d5", whiteSpace: "pre-wrap",
          }}>
            {logs.length === 0 ? (
              <div className="muted">No HF log entries yet. Enable the HF stack to see activity.</div>
            ) : (
              logs.slice().reverse().slice(0, 200).map((e, i) => {
                const t = isoToEatHms(e.ts ?? "");
                const color = e.level === "error" ? "#d4655f" : e.level === "warn" ? "#d4a35f" : e.level === "info" ? "#a8b3d5" : "#6b7896";
                const { ts, level, msg, ...meta } = e;
                const metaStr = Object.entries(meta).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
                return <div key={i} style={{ color }}>{`${t} ${(level ?? "info").toUpperCase().padEnd(5)} ${msg}${metaStr ? "  " + metaStr : ""}`}</div>;
              })
            )}
          </div>
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
              <div className="muted" style={{ marginBottom: 4 }} title="Hard SL as % of STAKE. price-move = slPct / leverage. 0 = disabled (trail-arm only).">
                HF SL % of stake
              </div>
              <input value={hfSlPct} onChange={(e) => setHfSlPct(e.target.value)} className="input" style={{ width: 120 }} />
              <span className="muted" style={{ marginLeft: 12, fontSize: 12 }}>
                → max loss ≈ ${(Number(stake) * Number(hfSlPct) / 100 || 0).toFixed(2)}{" "}
                ({Number(hfSlPct) > 0 && Number(leverage) > 0 ? `${(Number(hfSlPct) / Number(leverage)).toFixed(3)}% price move` : "disabled"})
              </span>
            </label>
          </div>

          {/* HF quality filter — validated 2026-05-25 (199K trades) */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #1e2842" }}>
            <div style={{ marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={qfEnabled} onChange={(e) => setQfEnabled(e.target.checked)} />
                <strong>HF quality filter</strong>
                <span className="muted" style={{ fontSize: 12 }}>— validated +$1.43/trade vs +$0.32 baseline (29-month, 199K trades, 27/27 months profitable)</span>
              </label>
            </div>
            <div className="grid grid-3" style={{ gap: 16 }}>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Comma-separated UTC hours when HF entries are allowed. Default [12-22] = NY morning + afternoon.">
                  Allowed hours (UTC)
                </div>
                <input value={qfHours} onChange={(e) => setQfHours(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Require current bbWidth in top X% of last 200 15m bars.">
                  bbWidth top % (rolling 200 bars)
                </div>
                <input value={qfBbPctile} onChange={(e) => setQfBbPctile(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
              <label>
                <div className="muted" style={{ marginBottom: 4 }} title="Require current bar's volume in top X% of last 200 bars.">
                  volume top % (rolling 200 bars)
                </div>
                <input value={qfVolPctile} onChange={(e) => setQfVolPctile(e.target.value)} className="input" disabled={!qfEnabled} />
              </label>
            </div>
          </div>

          {/* Per-asset HF leverage */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #1e2842" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div className="muted">
                <strong>Per-asset HF leverage</strong> — each input shows Binance max for that symbol. Exceeding it rejects on order placement.
              </div>
              <button
                type="button"
                className="btn"
                style={{ padding: "4px 10px", fontSize: 12 }}
                onClick={() => setPerAssetLev(Object.fromEntries(Object.keys(perAssetEnabled).sort().map(a => [a, String(BINANCE_MAX_LEV[a] ?? 30)])))}
              >
                Reset all to max
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
              {Object.keys(perAssetEnabled).sort().map((a) => {
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

// ── Multi-line live progress SVG (one line per open trade) ───────────────
const SERIES_COLOURS = ["#7fb3ff", "#5fd4a4", "#d4a35f", "#d4655f", "#b85fd4", "#5fd4d4", "#d4d45f", "#a35fd4"];
function ProgressSvg({ series }: { series: Array<{ id: string; label: string; points: Array<{ ts: number; pct: number }>; armed: boolean }> }) {
  const w = 800, h = 220, padL = 50, padR = 130, padT = 12, padB = 22;
  const allTs = series.flatMap((s) => s.points.map((p) => p.ts));
  const allPct = series.flatMap((s) => s.points.map((p) => p.pct));
  if (allTs.length === 0) return <div className="muted">Collecting samples…</div>;
  const xMin = Math.min(...allTs), xMax = Math.max(...allTs);
  const yMin = Math.min(-0.1, ...allPct), yMax = Math.max(0.1, ...allPct);
  const xScale = (x: number) => padL + ((x - xMin) / Math.max(1, xMax - xMin)) * (w - padL - padR);
  const yScale = (y: number) => padT + (1 - (y - yMin) / Math.max(0.001, yMax - yMin)) * (h - padT - padB);
  const zeroY = yScale(0);
  return (
    <svg width="100%" viewBox={`0 0 ${w} ${h}`} style={{ background: "#0e1528", borderRadius: 4 }}>
      <line x1={padL} y1={zeroY} x2={w - padR} y2={zeroY} stroke="#1e2842" strokeDasharray="2,3" />
      <text x={padL - 6} y={zeroY + 4} fill="#888" fontSize="10" textAnchor="end">0%</text>
      <text x={padL - 6} y={yScale(yMax) + 4} fill="#888" fontSize="10" textAnchor="end">{yMax.toFixed(2)}%</text>
      <text x={padL - 6} y={yScale(yMin) + 4} fill="#888" fontSize="10" textAnchor="end">{yMin.toFixed(2)}%</text>
      {series.map((s, i) => {
        const colour = SERIES_COLOURS[i % SERIES_COLOURS.length];
        const path = s.points.map((p, j) => `${j === 0 ? "M" : "L"}${xScale(p.ts).toFixed(1)},${yScale(p.pct).toFixed(1)}`).join(" ");
        const last = s.points[s.points.length - 1];
        return (
          <g key={s.id}>
            <path d={path} fill="none" stroke={colour} strokeWidth={1.5} opacity={0.9} />
            {last && (
              <circle cx={xScale(last.ts)} cy={yScale(last.pct)} r={3} fill={colour} />
            )}
            {/* Legend entry */}
            <g transform={`translate(${w - padR + 6}, ${padT + 4 + i * 18})`}>
              <line x1={0} y1={6} x2={14} y2={6} stroke={colour} strokeWidth={2} />
              <text x={18} y={9} fill="#a8b3d5" fontSize="10.5">
                {s.label}{s.armed ? " ●" : ""}{last ? ` ${last.pct >= 0 ? "+" : ""}${last.pct.toFixed(2)}%` : ""}
              </text>
            </g>
          </g>
        );
      })}
    </svg>
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
  const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }).slice(5);
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

// Fast2 sandbox panel. Parallel to Fast but with runtime-configurable
// trade leverage and martingale multiplier. Backed by /api/fast2-* endpoints,
// completely independent paper account / ladders / config from Fast.

import React, { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from "lightweight-charts";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type Fast2Config, type Fast2PaperResp, type FastMartingaleSnapshot, type RealTrade, type Signal, type StateResp, type StrategyStats } from "../api";

// Deriv contract constraints for BOOM/CRASH 300N MULTIPLIER contracts.
// Source: Deriv contracts_for API response. Anything outside these ranges
// is rejected by the live buy endpoint with ContractBuyValidationError.
const TRADE_MULT_OPTIONS = [20, 40, 60, 80, 100];
const DERIV_MIN_STAKE = 1;       // USD — minimum stake per multiplier contract
const DERIV_MAX_STAKE = 2000;    // USD — maximum stake (Deriv default ceiling)
const MART_MULT_OPTIONS = [1.7, 2.0, 2.2];
const COMMISSION_OPTIONS = [
  { v: 0,     label: "0% (off)" },
  { v: 0.001, label: "0.1%" },
  { v: 0.003, label: "0.3%" },
  { v: 0.005, label: "0.5% (Deriv default)" },
  { v: 0.006, label: "0.6%" },
  { v: 0.01,  label: "1.0%" },
];

export function Fast2Panel({ state, doAction, pending }: {
  state: StateResp | null;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [paper, setPaper] = useState<Fast2PaperResp | null>(null);
  const [paperTrades, setPaperTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [martingale, setMartingale] = useState<Record<string, FastMartingaleSnapshot>>({});
  const [signals, setSignals] = useState<Signal[]>([]);
  // Real (live) trades — filtered to sandbox==="fast2" client-side. Used
  // only when liveTradingEnabled is on; otherwise paper trades drive the UI.
  const [liveTrades, setLiveTrades] = useState<RealTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterSym, setFilterSym] = useState<string>("ALL");
  const [filterRes, setFilterRes] = useState<"ALL" | "won" | "lost">("ALL");
  const [resetTo, setResetTo] = useState<string>("50");
  const [pendingCfg, setPendingCfg] = useState<Fast2Config | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s, sig, rt] = await Promise.all([
          api.fast2Paper(), api.fast2PaperTrades(500), api.fast2PaperEquity(), api.fast2Strategies(), api.fast2Signals(100), api.trades(500),
        ]);
        setPaper(p);
        setPaperTrades(t.trades);
        setEquity(e.equity);
        setStrategies(s.strategies);
        setMartingale(s.martingale);
        setSignals(sig.signals);
        setLiveTrades(rt.trades.filter((rec) => rec.sandbox === "fast2"));
        setError(null);
      } catch (err) { setError((err as Error).message); }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  if (error && !paper) return <div className="banner banner-danger">⚠ {error}</div>;
  if (!paper) return <div className="empty">Loading…</div>;

  const cfg = pendingCfg ?? paper.config;
  const isLive = paper.config.liveTradingEnabled;
  const dirty = pendingCfg !== null && (
    pendingCfg.tradeMultiplier !== paper.config.tradeMultiplier ||
    pendingCfg.martingaleMultiplier !== paper.config.martingaleMultiplier ||
    pendingCfg.baseStake !== paper.config.baseStake ||
    pendingCfg.maxLevels !== paper.config.maxLevels ||
    pendingCfg.perTradeCap !== paper.config.perTradeCap ||
    pendingCfg.commissionPct !== paper.config.commissionPct ||
    pendingCfg.entrySpreadBps !== paper.config.entrySpreadBps ||
    pendingCfg.slSlippageBps !== paper.config.slSlippageBps ||
    pendingCfg.forceMartingale !== paper.config.forceMartingale ||
    pendingCfg.sideFilter !== paper.config.sideFilter ||
    pendingCfg.martingaleMode !== paper.config.martingaleMode ||
    pendingCfg.liveTradingEnabled !== paper.config.liveTradingEnabled
  );

  // ── Mode-aware view: when live is on, show Deriv account balance + only
  // fast2-tagged real trades. When paper, show simulated balance + paper
  // trades. Both modes share the same configuration UI below.
  const liveClosed = liveTrades.filter((t) => t.closedAt != null);
  const liveOpenCount = liveTrades.length - liveClosed.length;
  const liveWins = liveClosed.filter((t) => (t.profit ?? 0) > 0).length;
  const liveLosses = liveClosed.length - liveWins;
  const liveTotalPnl = liveClosed.reduce((acc, t) => acc + (t.profit ?? 0), 0);
  const liveAvgR = liveClosed.length > 0
    ? liveClosed.reduce((acc, t) => acc + (t.stake > 0 ? (t.profit ?? 0) / t.stake : 0), 0) / liveClosed.length
    : 0;
  const accountBalance = state?.account?.balance ?? 0;
  const accountLogin = state?.account?.loginid ?? "—";

  const view = isLive
    ? {
        balance: accountBalance,
        balanceSub: `Deriv · ${accountLogin}`,
        balanceTone: accountBalance > 0 ? "pos" : "muted",
        totalPnl: liveTotalPnl,
        totalPnlSub: `${liveClosed.length} live trades · ${liveOpenCount} open`,
        wr: liveClosed.length > 0 ? liveWins / liveClosed.length : 0,
        wrSub: `${liveWins}W / ${liveLosses}L · ${liveClosed.length} trades · avg ${liveAvgR.toFixed(2)}R`,
        wrTrades: liveClosed.length,
        peak: 0,
        peakSub: "live peak tracking — see logs",
        ddPct: 0,
      }
    : (() => {
        const s = paper.stats;
        return {
          balance: paper.balance,
          balanceSub: `paper · started at $${paper.startingBalance.toFixed(2)}`,
          balanceTone: (paper.balance >= paper.startingBalance ? "pos" : "neg") as const,
          totalPnl: s.totalPnl,
          totalPnlSub: `${s.pnlPct >= 0 ? "+" : ""}${s.pnlPct.toFixed(1)}% from start`,
          wr: s.winRate,
          wrSub: `${s.wins}W / ${s.losses}L · ${s.trades} trades · avg ${s.avgR.toFixed(2)}R`,
          wrTrades: s.trades,
          peak: s.peak,
          peakSub: `${s.ddPct.toFixed(1)}% from peak · ${s.open} open`,
          ddPct: s.ddPct,
        };
      })();

  // Trade table source — paper or live depending on mode.
  const tradeRows: Array<{
    id: string; closedAt: number | null; symbol: string; side: "BUY" | "SELL"; detector: string;
    stake: number; multiplier?: number; commission: number; entryPrice: number; exitPrice: number;
    rMultiple: number; pnl: number; result: "won" | "lost"; latencyMs?: number | null;
  }> = isLive
    ? liveClosed.map((t) => ({
        id: t.id,
        closedAt: t.closedAt,
        symbol: t.symbol,
        side: t.side,
        detector: t.detector,
        stake: t.stake,
        multiplier: t.multiplier,
        commission: 0,
        entryPrice: t.entrySpot ?? 0,
        exitPrice: t.exitSpot ?? 0,
        rMultiple: t.stake > 0 ? (t.profit ?? 0) / t.stake : 0,
        pnl: t.profit ?? 0,
        result: (t.profit ?? 0) > 0 ? "won" : "lost",
        latencyMs: t.openLatencyMs,
      }))
    : paperTrades.map((t) => ({
        id: t.id,
        closedAt: t.closedAt,
        symbol: t.symbol,
        side: t.side,
        detector: t.detector,
        stake: t.stake,
        multiplier: t.multiplier,
        commission: t.commission ?? 0,
        entryPrice: t.entryPrice,
        exitPrice: t.exitPrice,
        rMultiple: t.rMultiple,
        pnl: t.pnl,
        result: t.result,
        latencyMs: null,
      }));

  const symbols = Array.from(new Set(tradeRows.map((t) => t.symbol))).sort();
  const filtered = tradeRows.filter((t) =>
    (filterSym === "ALL" || t.symbol === filterSym) &&
    (filterRes === "ALL" || t.result === filterRes)
  );
  const totalCommission = tradeRows.reduce((acc, t) => acc + t.commission, 0);

  const setCfg = (patch: Partial<Fast2Config>) => {
    setPendingCfg({ ...cfg, ...patch });
  };

  const applyCfg = () => {
    if (!pendingCfg || !dirty) return;
    // Client-side Deriv-constraint clamp before sending. Server clamps too,
    // but doing it here lets the user see the snapped value immediately.
    const clamped: Fast2Config = { ...pendingCfg };
    if (!TRADE_MULT_OPTIONS.includes(clamped.tradeMultiplier)) {
      clamped.tradeMultiplier = TRADE_MULT_OPTIONS.reduce((best, v) => Math.abs(v - clamped.tradeMultiplier) < Math.abs(best - clamped.tradeMultiplier) ? v : best, TRADE_MULT_OPTIONS[0]);
    }
    if (clamped.baseStake < DERIV_MIN_STAKE) clamped.baseStake = DERIV_MIN_STAKE;
    if (clamped.baseStake > DERIV_MAX_STAKE) clamped.baseStake = DERIV_MAX_STAKE;
    if (clamped.perTradeCap < DERIV_MIN_STAKE) clamped.perTradeCap = DERIV_MIN_STAKE;
    if (clamped.perTradeCap > DERIV_MAX_STAKE) clamped.perTradeCap = DERIV_MAX_STAKE;
    const liveDelta = clamped.liveTradingEnabled !== paper.config.liveTradingEnabled;
    const liveWarning = clamped.liveTradingEnabled
      ? " ⚠ LIVE TRADING — REAL MONEY"
      : (liveDelta ? " · returning to paper" : "");
    doAction(
      `Apply Fast2 config:${liveWarning} MULT=${clamped.tradeMultiplier}× · martingale=${clamped.martingaleMultiplier}×/${clamped.martingaleMode} · forceMart=${clamped.forceMartingale ? "on" : "off"} · sides=${clamped.sideFilter} · base=$${clamped.baseStake} · levels=${clamped.maxLevels} · cap=$${clamped.perTradeCap} · commission=${(clamped.commissionPct * 100).toFixed(2)}% · spread=${clamped.entrySpreadBps}bps`,
      () => api.updateFast2Config(clamped).then(() => setPendingCfg(null)),
    );
  };

  const maxLadderStake = round2(cfg.baseStake * Math.pow(cfg.martingaleMultiplier, cfg.maxLevels - 1));
  const balanceForCheck = view.balance;
  const stakeFitsBalance = maxLadderStake <= balanceForCheck;

  return (
    <>
      {paper.config.liveTradingEnabled && (
        <div className="banner banner-danger" style={{ marginBottom: 12, fontWeight: 600 }}>
          🔴 LIVE TRADING ACTIVE — Fast2 signals are routing to real Deriv contracts. Account balance is at risk.
          Latency circuit ({/* surfaced via avg latency telemetry on trades table */}set to 800ms) and session-DD circuit (30%) will auto-pause if triggered.
        </div>
      )}
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Fast2 Sandbox</strong> — {paper.config.liveTradingEnabled ? "live mode (real Deriv multipliers)" : "paper-only"}. 3-strategy stack: BOOM 300N spike-fade (1m) + CRASH 300N spike-fade (1m) + CRASH 300N drift-pullback (5m).
        Runtime-configurable trade leverage and martingale multiplier.
        Currently running at <strong>MULT={paper.config.tradeMultiplier}× · martingale={paper.config.martingaleMultiplier}×</strong> on a ${paper.startingBalance.toFixed(0)} starting balance.
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card title={isLive ? "Live Balance" : "Paper Balance"} value={`$${view.balance.toFixed(2)}`} sub={view.balanceSub} tone={view.balanceTone as "pos" | "neg" | "muted"} />
        <Card title={isLive ? "Live P&L" : "Total P&L"} value={`${view.totalPnl >= 0 ? "+" : ""}$${view.totalPnl.toFixed(2)}`} sub={view.totalPnlSub} tone={view.totalPnl >= 0 ? "pos" : "neg"} />
        <Card title="Win Rate" value={view.wrTrades > 0 ? `${(view.wr * 100).toFixed(0)}%` : "—"} sub={view.wrSub} tone={view.wr >= 0.55 ? "pos" : view.wrTrades > 5 ? "neg" : "muted"} />
        <Card title="Peak / DD" value={isLive ? "—" : `$${view.peak.toFixed(2)}`} sub={view.peakSub} tone={isLive ? "muted" : view.ddPct > -10 ? "pos" : "neg"} />
      </div>

      <h3 className="section-title">Configuration</h3>
      <div className="card-sub" style={{ marginBottom: 6, fontSize: 11, padding: "0 4px" }}>
        Deriv constraints (BOOM/CRASH 300N MULTIPLIER): leverage ∈ {`{${TRADE_MULT_OPTIONS.join(", ")}}`}× · stake ∈ ${DERIV_MIN_STAKE}–${DERIV_MAX_STAKE}. Out-of-range values are auto-snapped on Apply.
      </div>
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div className="grid grid-3" style={{ gap: 12, marginBottom: 12 }}>
          <ConfigField label="Trade Leverage (MULT) — Deriv-valid only">
            <select className="filter-select" value={cfg.tradeMultiplier} onChange={(e) => setCfg({ tradeMultiplier: Number(e.target.value) })}>
              {TRADE_MULT_OPTIONS.map((m) => <option key={m} value={m}>{m}×</option>)}
            </select>
          </ConfigField>
          <ConfigField label="Martingale Multiplier">
            <select className="filter-select" value={cfg.martingaleMultiplier} onChange={(e) => setCfg({ martingaleMultiplier: Number(e.target.value) })}>
              {MART_MULT_OPTIONS.map((m) => <option key={m} value={m}>{m.toFixed(1)}×</option>)}
            </select>
          </ConfigField>
          <ConfigField label={`Base Stake (level 0) — Deriv min $${DERIV_MIN_STAKE}`}>
            <input
              className="filter-input"
              type="number"
              step="0.5"
              min={DERIV_MIN_STAKE}
              max={DERIV_MAX_STAKE}
              value={cfg.baseStake}
              onChange={(e) => setCfg({ baseStake: Number(e.target.value) })}
            />
          </ConfigField>
          <ConfigField label="Max Ladder Levels">
            <input className="filter-input" type="number" step="1" min="1" max="10" value={cfg.maxLevels} onChange={(e) => setCfg({ maxLevels: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label={`Per-Trade Cap ($) — Deriv max $${DERIV_MAX_STAKE}`}>
            <input
              className="filter-input"
              type="number"
              step="1"
              min={DERIV_MIN_STAKE}
              max={DERIV_MAX_STAKE}
              value={cfg.perTradeCap}
              onChange={(e) => setCfg({ perTradeCap: Number(e.target.value) })}
            />
          </ConfigField>
          <ConfigField label="Commission (% of stake)">
            <select className="filter-select" value={cfg.commissionPct} onChange={(e) => setCfg({ commissionPct: Number(e.target.value) })}>
              {COMMISSION_OPTIONS.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}
            </select>
          </ConfigField>
          <ConfigField label="Entry Spread (bps adverse)">
            <input className="filter-input" type="number" step="0.1" min="0" max="50" value={cfg.entrySpreadBps} onChange={(e) => setCfg({ entrySpreadBps: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="SL Slippage (bps past stop)">
            <input className="filter-input" type="number" step="0.5" min="0" max="100" value={cfg.slSlippageBps} onChange={(e) => setCfg({ slSlippageBps: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Max ladder stake (computed)">
            <div className={`mono ${stakeFitsBalance ? "" : "neg"}`} style={{ paddingTop: 6 }}>
              ${maxLadderStake.toFixed(2)} {stakeFitsBalance ? "" : `> $${balanceForCheck.toFixed(2)} balance`}
            </div>
          </ConfigField>
          <ConfigField label="Per-trade fee at base stake">
            <div className="mono" style={{ paddingTop: 6 }}>
              ${(cfg.baseStake * cfg.commissionPct).toFixed(3)} commission · {cfg.entrySpreadBps.toFixed(1)} bps slip
            </div>
          </ConfigField>
          <ConfigField label="Force Martingale (override)">
            <label style={{ display: "flex", alignItems: "center", gap: 8, paddingTop: 6 }}>
              <input
                type="checkbox"
                checked={cfg.forceMartingale}
                onChange={(e) => setCfg({ forceMartingale: e.target.checked })}
              />
              <span className={`mono ${cfg.forceMartingale ? "pos" : "muted"}`}>
                {cfg.forceMartingale ? "ON — every strategy ladders" : "OFF — registry decides"}
              </span>
            </label>
          </ConfigField>
          <ConfigField label="Trade Side Filter">
            <select className="filter-select" value={cfg.sideFilter} onChange={(e) => setCfg({ sideFilter: e.target.value as "both" | "BUY" | "SELL" })}>
              <option value="both">Both BUY + SELL</option>
              <option value="BUY">BUY only</option>
              <option value="SELL">SELL only</option>
            </select>
          </ConfigField>
          <ConfigField label="Martingale Mode">
            <select className="filter-select" value={cfg.martingaleMode} onChange={(e) => setCfg({ martingaleMode: e.target.value as "classic" | "anti" })}>
              <option value="classic">Classic — escalate on loss, reset on win</option>
              <option value="anti">Anti (Paroli) — escalate on win, reset on loss</option>
            </select>
          </ConfigField>
          <ConfigField label="Trading Mode">
            <button
              type="button"
              onClick={() => setCfg({ liveTradingEnabled: !cfg.liveTradingEnabled })}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                borderRadius: 999,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
                border: `1.5px solid ${cfg.liveTradingEnabled ? "#e8504c" : "#3a4255"}`,
                background: cfg.liveTradingEnabled ? "rgba(232, 80, 76, 0.15)" : "rgba(58, 66, 85, 0.20)",
                color: cfg.liveTradingEnabled ? "#ff8a87" : "#a8b3c5",
                transition: "all 0.15s ease",
                width: "100%",
                justifyContent: "center",
              }}
            >
              <span
                style={{
                  display: "inline-block",
                  width: 32,
                  height: 16,
                  borderRadius: 999,
                  background: cfg.liveTradingEnabled ? "#e8504c" : "#3a4255",
                  position: "relative",
                  flexShrink: 0,
                  transition: "background 0.15s ease",
                }}
              >
                <span
                  style={{
                    position: "absolute",
                    top: 2,
                    left: cfg.liveTradingEnabled ? 18 : 2,
                    width: 12,
                    height: 12,
                    borderRadius: "50%",
                    background: "#fff",
                    transition: "left 0.15s ease",
                  }}
                />
              </span>
              {cfg.liveTradingEnabled ? "🔴 LIVE — real Deriv contracts" : "📝 PAPER — simulation (default)"}
            </button>
          </ConfigField>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="btn btn-primary btn-sm" disabled={!dirty || pending !== null} onClick={applyCfg}>
            {pending && pending.startsWith("Apply Fast2 config") ? "Applying…" : dirty ? "Apply config" : "No changes"}
          </button>
          {dirty && (
            <button className="btn btn-sm" onClick={() => setPendingCfg(null)}>Cancel</button>
          )}
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            Changes apply at the next trade open and ladder advance — open positions keep their original leverage.
          </span>
        </div>
      </div>

      {/* Martingale ladder snapshot per strategy */}
      <h3 className="section-title">Martingale Ladders</h3>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {strategies.map((s) => {
          const m = martingale[s.id] ?? { level: 0, wins: 0, losses: 0, circuitBreakers: 0, lastCircuitBreakerAt: 0, nextStake: paper.config.baseStake };
          const ladderColor = m.level === 0 ? "pos" : m.level >= 3 ? "neg" : "muted";
          return (
            <div key={s.id} className="card">
              <div className="card-title">{s.name}</div>
              <div className="grid grid-3" style={{ marginTop: 6 }}>
                <div>
                  <div className="card-title" style={{ fontSize: 10 }}>Ladder</div>
                  <div className={`card-value ${ladderColor}`} style={{ fontSize: 24 }}>{m.level}/{paper.config.maxLevels}</div>
                  <div className="card-sub">next stake ${m.nextStake.toFixed(2)}</div>
                </div>
                <div>
                  <div className="card-title" style={{ fontSize: 10 }}>W / L</div>
                  <div className="card-value" style={{ fontSize: 20 }}>{m.wins}W / {m.losses}L</div>
                  <div className="card-sub">{m.wins + m.losses > 0 ? `${((m.wins / (m.wins + m.losses)) * 100).toFixed(0)}% WR` : "—"}</div>
                </div>
                <div>
                  <div className="card-title" style={{ fontSize: 10 }}>Circuit Breakers</div>
                  <div className={`card-value ${m.circuitBreakers > 0 ? "neg" : "muted"}`} style={{ fontSize: 20 }}>{m.circuitBreakers}</div>
                  <div className="card-sub">{m.lastCircuitBreakerAt > 0 ? `last ${fmtTime(m.lastCircuitBreakerAt)}` : "none yet"}</div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <h3 className="section-title">Per-Strategy (live)</h3>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Strategy</th><th>Symbol</th><th>TF</th><th>Bars seen</th><th>Live trades</th><th>Live W/L</th><th>Live $</th><th>Last signal</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => (
              <tr key={s.id}>
                <td>
                  <div className="bold">{s.id}</div>
                  <div className="faint" style={{ fontSize: 11 }}>{s.name}</div>
                </td>
                <td className="mono">{s.symbols.join(", ")}</td>
                <td><span className="strat-chip">{s.granularity}s</span></td>
                <td className={`mono ${s.live.barsSeen === 0 ? "neg" : ""}`}>{s.live.barsSeen}</td>
                <td className="mono">{s.live.trades}</td>
                <td className="mono">{s.live.trades > 0 ? `${s.live.wins}W/${s.live.losses}L` : "—"}</td>
                <td className={`mono ${s.live.pnlUsd > 0 ? "pos" : s.live.pnlUsd < 0 ? "neg" : "muted"}`}>
                  {s.live.pnlUsd >= 0 ? "+" : ""}${s.live.pnlUsd.toFixed(2)}
                </td>
                <td className="faint">{s.live.lastSignalAt ? fmtTime(s.live.lastSignalAt) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Equity Curve <span className="muted" style={{ fontSize: 11 }}>{equity.length} samples</span></h3>
      <EquityChart points={equity} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "16px 0" }}>
        <span className="muted">Reset to:</span>
        <input className="filter-input" type="number" value={resetTo} onChange={(e) => setResetTo(e.target.value)} style={{ width: 80 }} />
        <button
          className="btn btn-warn btn-sm"
          disabled={pending !== null}
          onClick={() => doAction(`Reset fast2-paper to $${resetTo}? Wipes balance, all closed trades, and all martingale ladders.`, () => api.resetFast2Paper(Number(resetTo)))}
        >
          {pending ? "…" : "Reset Fast2 Sandbox"}
        </button>
      </div>

      <h3 className="section-title">Recent Trades ({filtered.length})</h3>
      <div className="card table-card">
        <div className="filters">
          <select className="filter-select" value={filterSym} onChange={(e) => setFilterSym(e.target.value)}>
            <option value="ALL">All symbols</option>
            {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="filter-select" value={filterRes} onChange={(e) => setFilterRes(e.target.value as "ALL" | "won" | "lost")}>
            <option value="ALL">Won + Lost</option>
            <option value="won">Won only</option>
            <option value="lost">Lost only</option>
          </select>
        </div>
        {filtered.length === 0 ? (
          <div className="empty"><span className="empty-emoji">⚡⚡</span>No {isLive ? "live" : "paper"} trades yet</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Closed</th><th>Symbol</th><th>Side</th><th>Stake</th><th>MULT</th>
                {!isLive && <th>Fee</th>}
                {isLive && <th>Latency</th>}
                <th>Entry</th><th>Exit</th><th>R</th><th>{isLive ? "P&L" : "Net P&L"}</th><th>Result</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td className="mono faint">{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                  <td className="mono">{t.symbol}</td>
                  <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                  <td className="mono">${t.stake.toFixed(2)}</td>
                  <td className="mono faint">{t.multiplier ?? "—"}×</td>
                  {!isLive && <td className="mono faint">${t.commission.toFixed(2)}</td>}
                  {isLive && <td className="mono faint">{t.latencyMs != null ? `${t.latencyMs}ms` : "—"}</td>}
                  <td className="mono">{t.entryPrice.toFixed(5)}</td>
                  <td className="mono">{t.exitPrice.toFixed(5)}</td>
                  <td className={`mono ${t.rMultiple > 0 ? "pos" : "neg"}`}>{t.rMultiple.toFixed(2)}R</td>
                  <td className={`mono ${t.pnl > 0 ? "pos" : "neg"}`}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                  <td><span className={`pill ${t.result === "won" ? "pill-green" : "pill-red"}`}>{t.result}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h3 className="section-title" style={{ marginTop: 16 }}>Recent Signals ({signals.length})</h3>
      <div className="card table-card">
        {signals.length === 0 ? (
          <div className="empty"><span className="empty-emoji">⚡⚡</span>No fast2 signals yet</div>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Reason</th></tr></thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <td className="mono faint">{fmtTime(s.ts)}</td>
                  <td className="mono">{s.symbol}</td>
                  <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
                  <td className="mono faint">{s.detector}</td>
                  <td className="muted">{s.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Card({ title, value, sub, tone }: { title: string; value: string; sub?: string; tone?: "pos" | "neg" | "muted" }) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className={`card-value ${tone ?? ""}`}>{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="card-title" style={{ fontSize: 11, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

function EquityChart({ points }: { points: EquityPoint[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 180,
      layout: { background: { type: ColorType.Solid, color: "#0a0d14" }, textColor: "#8a95b8", fontSize: 11 },
      grid: { vertLines: { color: "#11182a" }, horzLines: { color: "#11182a" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#1e2842" },
      rightPriceScale: { borderColor: "#1e2842" },
    });
    const series = chart.addSeries(LineSeries, { color: "#5fd4a4", lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;
    const onResize = () => chart.applyOptions({ width: containerRef.current?.clientWidth ?? 600 });
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = points.map((p) => ({ time: Math.floor(p.ts / 1000) as any, value: p.balance }));
    seriesRef.current.setData(data);
  }, [points]);

  return <div ref={containerRef} style={{ width: "100%", height: 180 }} />;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

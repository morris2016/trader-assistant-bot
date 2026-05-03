// Fast3 sandbox panel — DIGITODD tick-level book on synthetic indices.
// Mirrors Fast2 layout (paper/live toggle, config, per-strategy overrides,
// equity curve) but for binary 1-tick contracts. No SL/TP geometry — wins
// pay 1.95× stake, losses lose stake.

import React, { useEffect, useState } from "react";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type Fast3Config, type Fast3PaperResp, type FastMartingaleSnapshot, type StateResp, type StrategyStats } from "../api";

const MART_MULT_OPTIONS = [1.3, 1.5, 1.7, 2.0, 2.2];
const DERIV_MIN_STAKE = 1;
const DERIV_MAX_STAKE = 2000;

export function Fast3Panel({ state, doAction, pending }: {
  state: StateResp | null;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [paper, setPaper] = useState<Fast3PaperResp | null>(null);
  const [paperTrades, setPaperTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [martingale, setMartingale] = useState<Record<string, FastMartingaleSnapshot>>({});
  const [error, setError] = useState<string | null>(null);
  const [resetTo, setResetTo] = useState<string>("41");
  const [pendingCfg, setPendingCfg] = useState<Fast3Config | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s] = await Promise.all([
          api.fast3Paper(), api.fast3PaperTrades(500), api.fast3PaperEquity(), api.fast3Strategies(),
        ]);
        setPaper(p);
        setPaperTrades(t.trades);
        setEquity(e.equity);
        setStrategies(s.strategies);
        setMartingale(s.martingale);
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
    pendingCfg.martingaleMultiplier !== paper.config.martingaleMultiplier ||
    pendingCfg.baseStake !== paper.config.baseStake ||
    pendingCfg.maxLevels !== paper.config.maxLevels ||
    pendingCfg.perTradeCap !== paper.config.perTradeCap ||
    pendingCfg.sideFilter !== paper.config.sideFilter ||
    pendingCfg.martingaleMode !== paper.config.martingaleMode ||
    pendingCfg.liveTradingEnabled !== paper.config.liveTradingEnabled
  );

  const stats = paper.stats;
  const view = {
    balance: paper.balance,
    balanceSub: `${isLive ? "LIVE" : "paper"} · started at $${paper.startingBalance.toFixed(2)}`,
    balanceTone: (paper.balance >= paper.startingBalance ? "pos" : "neg") as "pos" | "neg",
    totalPnl: stats.totalPnl ?? 0,
    totalPnlSub: `${paperTrades.length} trades`,
    wr: stats.winRate ?? 0,
    wrSub: `${stats.wins ?? 0}W / ${stats.losses ?? 0}L`,
    peak: stats.peak ?? 0,
    peakSub: `peak balance`,
    ddPct: stats.ddPct ?? 0,
  };

  const applyCfg = () => {
    if (!pendingCfg) return;
    doAction("update fast3 config", () => api.updateFast3Config(pendingCfg).then(() => setPendingCfg(null)));
  };

  const setCfg = (patch: Partial<Fast3Config>) => setPendingCfg({ ...cfg, ...patch });

  return (
    <div className="panel">
      <h2 className="panel-title">Fast3 — DIGITODD tick book {isLive ? <span className="tone-live">LIVE</span> : <span className="muted">paper</span>}</h2>
      <div className="card-sub" style={{ marginBottom: 12, fontSize: 11 }}>
        Tick-level binary contracts on synthetic indices. Each tick = one DIGITODD bet (predict next tick's last digit is ODD).
        Validated 2026-05-03: ~55.5% WR baseline (RNG bias) × 1.95× payout = ~5% per-tick edge.
        ⚠ Live wiring is a stub — flip ON only after DIGIT-family contract support lands in real.ts.
      </div>

      <div className="kpi-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12, marginBottom: 16 }}>
        <div className="card kpi"><div className="kpi-label">Balance</div><div className={`kpi-value tone-${view.balanceTone}`}>${view.balance.toFixed(2)}</div><div className="muted" style={{ fontSize: 10 }}>{view.balanceSub}</div></div>
        <div className="card kpi"><div className="kpi-label">Total P&L</div><div className={`kpi-value ${view.totalPnl > 0 ? "pos" : view.totalPnl < 0 ? "neg" : "muted"}`}>{view.totalPnl >= 0 ? "+" : ""}${view.totalPnl.toFixed(2)}</div><div className="muted" style={{ fontSize: 10 }}>{view.totalPnlSub}</div></div>
        <div className="card kpi"><div className="kpi-label">Win rate</div><div className="kpi-value">{(view.wr * 100).toFixed(1)}%</div><div className="muted" style={{ fontSize: 10 }}>{view.wrSub}</div></div>
        <div className="card kpi"><div className="kpi-label">Peak</div><div className="kpi-value">${view.peak.toFixed(2)}</div><div className="muted" style={{ fontSize: 10 }}>{view.peakSub}</div></div>
        <div className="card kpi"><div className="kpi-label">DD</div><div className={`kpi-value ${view.ddPct > 0.20 ? "neg" : view.ddPct > 0.10 ? "warn" : "muted"}`}>{(view.ddPct * 100).toFixed(1)}%</div></div>
      </div>

      <h3 className="section-title">Configuration</h3>
      <div className="card" style={{ padding: 12, marginBottom: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>base stake $</label>
          <input className="filter-input" type="number" step="0.5" min={DERIV_MIN_STAKE} max={DERIV_MAX_STAKE} value={cfg.baseStake} onChange={(e) => setCfg({ baseStake: Number(e.target.value) })} style={{ width: "100%" }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>martingale ×</label>
          <select className="filter-select" value={cfg.martingaleMultiplier} onChange={(e) => setCfg({ martingaleMultiplier: Number(e.target.value) })} style={{ width: "100%" }}>
            {MART_MULT_OPTIONS.map((v) => <option key={v} value={v}>{v}×</option>)}
          </select>
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>max levels (depth)</label>
          <input className="filter-input" type="number" step="1" min={1} max={10} value={cfg.maxLevels} onChange={(e) => setCfg({ maxLevels: Number(e.target.value) })} style={{ width: "100%" }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>per-trade cap $</label>
          <input className="filter-input" type="number" step="1" min={1} value={cfg.perTradeCap} onChange={(e) => setCfg({ perTradeCap: Number(e.target.value) })} style={{ width: "100%" }} />
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>side filter</label>
          <select className="filter-select" value={cfg.sideFilter} onChange={(e) => setCfg({ sideFilter: e.target.value as "both" | "BUY" | "SELL" })} style={{ width: "100%" }}>
            <option value="both">both</option>
            <option value="BUY">BUY only</option>
            <option value="SELL">SELL only</option>
          </select>
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>mart mode</label>
          <select className="filter-select" value={cfg.martingaleMode} onChange={(e) => setCfg({ martingaleMode: e.target.value as "classic" | "anti" })} style={{ width: "100%" }}>
            <option value="classic">classic</option>
            <option value="anti">anti (Paroli)</option>
          </select>
        </div>
        <div>
          <label className="muted" style={{ fontSize: 11 }}>live trading</label>
          <select className="filter-select" value={String(cfg.liveTradingEnabled)} onChange={(e) => setCfg({ liveTradingEnabled: e.target.value === "true" })} style={{ width: "100%" }}>
            <option value="false">PAPER</option>
            <option value="true">LIVE (stub — DIGIT family pending)</option>
          </select>
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
          <button className="btn btn-primary btn-sm" disabled={!dirty || pending !== null} onClick={applyCfg}>apply</button>
          <button className="btn btn-warn btn-sm" disabled={pending !== null} onClick={() => doAction("reset fast3", () => api.resetFast3Paper(Number(resetTo)))} title={`Reset paper balance to $${resetTo} and clear all ladders`}>reset</button>
          <input className="filter-input" type="number" step="1" min={1} value={resetTo} onChange={(e) => setResetTo(e.target.value)} style={{ width: 60 }} />
        </div>
      </div>

      <h3 className="section-title">Per-Strategy</h3>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Active</th><th>Strategy</th><th>Symbol</th><th>Trades</th><th>W/L</th><th>WR</th><th>$ net</th><th>Ladder</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const ov = (paper.config.perStrategy ?? {})[s.id] ?? {};
              const isOff = ov.enabled === false;
              const m = martingale[s.id];
              return (
                <tr key={s.id} style={{ opacity: isOff ? 0.45 : 1 }}>
                  <td>
                    <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input type="checkbox" checked={!isOff} onChange={(e) => api.updateFast3StrategyConfig(s.id, { enabled: e.target.checked })} />
                      <span className={`mono ${isOff ? "neg" : "pos"}`} style={{ fontSize: 11 }}>{isOff ? "OFF" : "ON"}</span>
                    </label>
                  </td>
                  <td>
                    <div className="bold" style={{ fontSize: 12 }}>{s.id}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.name}</div>
                  </td>
                  <td className="mono">{s.symbols.join(", ")}</td>
                  <td className="mono">{s.live.trades}</td>
                  <td className="mono">{s.live.trades > 0 ? `${s.live.wins}W/${s.live.losses}L` : "—"}</td>
                  <td className="mono">{s.live.trades > 0 ? `${(s.live.winRate * 100).toFixed(1)}%` : "—"}</td>
                  <td className={`mono ${s.live.pnlUsd > 0 ? "pos" : s.live.pnlUsd < 0 ? "neg" : "muted"}`}>{s.live.pnlUsd >= 0 ? "+" : ""}${s.live.pnlUsd.toFixed(2)}</td>
                  <td className="muted" style={{ fontSize: 11 }}>{m ? `L${m.level} · next $${m.nextStake.toFixed(2)}` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Recent Trades ({paperTrades.length})</h3>
      <div className="card table-card">
        {paperTrades.length === 0 ? (
          <div className="empty"><span className="empty-emoji">⚡⚡</span>No trades yet — Fast3 is awaiting tick stream</div>
        ) : (
          <table>
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th>Stake</th><th>Result</th><th>P&L</th></tr>
            </thead>
            <tbody>
              {paperTrades.slice(0, 100).map((t) => (
                <tr key={t.id}>
                  <td>{fmtTime(t.closedAt)}</td>
                  <td>{t.symbol}</td>
                  <td className="mono">${t.stake.toFixed(2)}</td>
                  <td className={t.pnl > 0 ? "pos" : "neg"}>{t.pnl > 0 ? "WIN" : "LOSS"}</td>
                  <td className={`mono ${t.pnl > 0 ? "pos" : "neg"}`}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

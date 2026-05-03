// Fast3 sandbox panel — DIGITODD tick-level book on synthetic indices.
// Mirrors Fast2 layout closely: KPI cards, configuration grid, per-strategy
// overrides table, recent trades. The contract type is binary 1-tick
// (DIGITODD) so there's no SL/TP geometry or trade multiplier in play.

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

  const stats = (paper.stats ?? {}) as Partial<{ balance: number; startingBalance: number; totalPnl: number; pnlPct: number; trades: number; wins: number; losses: number; winRate: number; avgR: number; peak: number; ddPct: number; open: number }>;
  const balance = paper.balance ?? 0;
  const startingBalance = paper.startingBalance ?? 0;
  const view = {
    balance,
    balanceSub: `${isLive ? "LIVE" : "paper"} · started at $${startingBalance.toFixed(2)}`,
    balanceTone: (balance >= startingBalance ? "pos" : "neg") as "pos" | "neg" | "muted",
    totalPnl: stats.totalPnl ?? 0,
    totalPnlSub: `${(stats.pnlPct ?? 0) >= 0 ? "+" : ""}${(stats.pnlPct ?? 0).toFixed(1)}% from start`,
    wr: stats.winRate ?? 0,
    wrSub: `${stats.wins ?? 0}W / ${stats.losses ?? 0}L · ${stats.trades ?? 0} bets`,
    wrTrades: stats.trades ?? 0,
    peak: stats.peak ?? 0,
    peakSub: `${(stats.ddPct ?? 0).toFixed(1)}% from peak · ${stats.open ?? 0} pending`,
    ddPct: stats.ddPct ?? 0,
  };

  const applyCfg = () => {
    if (!pendingCfg) return;
    doAction("update fast3 config", () => api.updateFast3Config(pendingCfg).then(() => setPendingCfg(null)));
  };
  const setCfg = (patch: Partial<Fast3Config>) => setPendingCfg({ ...cfg, ...patch });

  return (
    <>
      {isLive && (
        <div className="banner banner-danger" style={{ marginBottom: 12, fontWeight: 600 }}>
          🔴 LIVE TRADING TOGGLED — Fast3 LIVE wiring is currently a stub. DIGIT family contract support has not landed in real.ts yet, so signals will log a warning and skip placement until that's done. Flip OFF to keep paper fully working.
        </div>
      )}
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Fast3 Sandbox</strong> — DIGITODD tick-level book on Deriv synthetic indices.
        Each tick = one binary 1-tick contract (predict next tick's last digit is ODD).
        Edge is structural: synthetic RNG never produces digit 0, so digits 1-9 are uniform → P(odd) = 5/9 = 55.5%.
        Deriv pays 1.95× as if it were a fair coin → ~5%/tick edge.
        Currently running at <strong>base ${cfg.baseStake.toFixed(2)} · martingale {cfg.martingaleMultiplier.toFixed(1)}× · depth {cfg.maxLevels}</strong> on a ${startingBalance.toFixed(0)} starting balance.
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card title={isLive ? "Live Balance" : "Paper Balance"} value={`$${view.balance.toFixed(2)}`} sub={view.balanceSub} tone={view.balanceTone} />
        <Card title={isLive ? "Live P&L" : "Total P&L"} value={`${view.totalPnl >= 0 ? "+" : ""}$${view.totalPnl.toFixed(2)}`} sub={view.totalPnlSub} tone={view.totalPnl > 0 ? "pos" : view.totalPnl < 0 ? "neg" : "muted"} />
        <Card title="Win Rate" value={view.wrTrades > 0 ? `${(view.wr * 100).toFixed(1)}%` : "—"} sub={view.wrSub} tone={view.wr >= 0.55 ? "pos" : view.wrTrades > 50 ? "neg" : "muted"} />
        <Card title="Peak / DD" value={`$${view.peak.toFixed(2)}`} sub={view.peakSub} tone={view.ddPct > 20 ? "neg" : view.ddPct > 10 ? "muted" : "pos"} />
      </div>

      {!isLive && (
        <div className="card" style={{ display: "flex", gap: 8, alignItems: "center", padding: 12, marginBottom: 16 }}>
          <span className="muted" style={{ fontWeight: 600 }}>Set Paper Balance:</span>
          <span className="muted">$</span>
          <input
            className="filter-input"
            type="number"
            step="any"
            min={DERIV_MIN_STAKE}
            value={resetTo}
            onChange={(e) => setResetTo(e.target.value)}
            style={{ width: 100 }}
          />
          <button
            className="btn btn-warn btn-sm"
            disabled={pending !== null}
            onClick={() => doAction(`Set Fast3 paper balance to $${resetTo}? Wipes trades, ladders, equity.`, () => api.resetFast3Paper(Number(resetTo)))}
          >
            {pending ? "…" : "Set & Restart Sandbox"}
          </button>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            Default $41 = validated 1.5× mart d=6 sweet spot.
          </span>
        </div>
      )}

      <h3 className="section-title">Configuration</h3>
      <div className="card-sub" style={{ marginBottom: 6, fontSize: 11, padding: "0 4px" }}>
        DIGITODD is a binary 1-tick contract — there's no trade multiplier (payout is fixed 1.95×). Stake/martingale/cap apply identically to Fast2.
      </div>
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div className="grid grid-3" style={{ gap: 12, marginBottom: 12 }}>
          <ConfigField label="Martingale Multiplier">
            <select className="filter-select" value={cfg.martingaleMultiplier} onChange={(e) => setCfg({ martingaleMultiplier: Number(e.target.value) })}>
              {MART_MULT_OPTIONS.map((m) => <option key={m} value={m}>{m.toFixed(1)}×</option>)}
            </select>
          </ConfigField>
          <ConfigField label={`Base Stake — Deriv min $${DERIV_MIN_STAKE}`}>
            <input className="filter-input" type="number" step="0.5" min={DERIV_MIN_STAKE} max={DERIV_MAX_STAKE} value={cfg.baseStake} onChange={(e) => setCfg({ baseStake: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Max Ladder Levels (depth)">
            <input className="filter-input" type="number" step="1" min={1} max={10} value={cfg.maxLevels} onChange={(e) => setCfg({ maxLevels: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label={`Per-Trade Cap ($) — Deriv DIGIT max ~$50`}>
            <input className="filter-input" type="number" step="1" min={DERIV_MIN_STAKE} max={DERIV_MAX_STAKE} value={cfg.perTradeCap} onChange={(e) => setCfg({ perTradeCap: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Side Filter">
            <select className="filter-select" value={cfg.sideFilter} onChange={(e) => setCfg({ sideFilter: e.target.value as "both" | "BUY" | "SELL" })}>
              <option value="both">both (DIGITODD)</option>
              <option value="BUY">BUY only (no effect on DIGIT)</option>
              <option value="SELL">SELL only (no effect on DIGIT)</option>
            </select>
          </ConfigField>
          <ConfigField label="Martingale Mode">
            <select className="filter-select" value={cfg.martingaleMode} onChange={(e) => setCfg({ martingaleMode: e.target.value as "classic" | "anti" })}>
              <option value="classic">classic (escalate on loss)</option>
              <option value="anti">anti / Paroli (escalate on win)</option>
            </select>
          </ConfigField>
          <ConfigField label="Live Trading">
            <select className="filter-select" value={String(cfg.liveTradingEnabled)} onChange={(e) => setCfg({ liveTradingEnabled: e.target.value === "true" })}>
              <option value="false">PAPER</option>
              <option value="true">LIVE (stub — DIGIT family pending in real.ts)</option>
            </select>
          </ConfigField>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary btn-sm" disabled={!dirty || pending !== null} onClick={() => setPendingCfg(null)}>cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!dirty || pending !== null} onClick={applyCfg}>apply</button>
        </div>
      </div>

      <h3 className="section-title">Per-Strategy</h3>
      <div className="card-sub" style={{ marginBottom: 6, fontSize: 11, padding: "0 4px" }}>
        Toggle the ON/OFF checkbox to silence a strategy without removing it from the registry.
      </div>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Active</th><th>Strategy</th><th>Symbol</th><th>Bets</th><th>W/L</th><th>WR</th><th>$ net</th><th>Ladder</th><th>Last bet</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const ov = (paper.config.perStrategy ?? {})[s.id] ?? {};
              const isOff = ov.enabled === false;
              const m = martingale[s.id];
              const pnlUsd = s.live.pnlUsd ?? 0;
              return (
                <tr key={s.id} style={{ opacity: isOff ? 0.45 : 1 }}>
                  <td>
                    <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }} title="Toggle this strategy on/off">
                      <input type="checkbox" checked={!isOff} onChange={(e) => api.updateFast3StrategyConfig(s.id, { enabled: e.target.checked })} />
                      <span className={`mono ${isOff ? "neg" : "pos"}`} style={{ fontSize: 11 }}>{isOff ? "OFF" : "ON"}</span>
                    </label>
                  </td>
                  <td>
                    <div className="bold" style={{ fontSize: 12 }}>{s.id}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.name}</div>
                  </td>
                  <td className="mono">{s.symbols.join(", ")}</td>
                  <td className="mono">{s.live.trades ?? 0}</td>
                  <td className="mono">{(s.live.trades ?? 0) > 0 ? `${s.live.wins ?? 0}W/${s.live.losses ?? 0}L` : "—"}</td>
                  <td className="mono">{(s.live.trades ?? 0) > 0 ? `${((s.live.winRate ?? 0) * 100).toFixed(1)}%` : "—"}</td>
                  <td className={`mono ${pnlUsd > 0 ? "pos" : pnlUsd < 0 ? "neg" : "muted"}`}>{pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {m ? <>L{m.level} · next ${m.nextStake.toFixed(2)}</> : "—"}
                  </td>
                  <td className="faint" style={{ fontSize: 11 }}>{s.live.lastTradeAt ? fmtTime(s.live.lastTradeAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="section-title">Recent Trades ({paperTrades.length})</h3>
      <div className="card table-card">
        {paperTrades.length === 0 ? (
          <div className="empty"><span className="empty-emoji">🎯</span>No trades yet — Fast3 is awaiting tick stream. The bot subscribes to ticks for {strategies.length} symbols on startup; trades will appear as ticks arrive.</div>
        ) : (
          <table className="trades-table">
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th style={{ textAlign: "right" }}>Stake</th><th>Result</th><th style={{ textAlign: "right" }}>P&L</th></tr>
            </thead>
            <tbody>
              {paperTrades.slice(0, 100).map((t) => (
                <tr key={t.id}>
                  <td>{fmtTime(t.closedAt)}</td>
                  <td>{t.symbol}</td>
                  <td className="mono" style={{ textAlign: "right" }}>${(t.stake ?? 0).toFixed(2)}</td>
                  <td className={t.pnl > 0 ? "pos" : "neg"}>{t.pnl > 0 ? "WIN" : "LOSS"}</td>
                  <td className={`mono ${t.pnl > 0 ? "pos" : "neg"}`} style={{ textAlign: "right" }}>{t.pnl >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2)}</td>
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
  const toneClass = tone === "pos" ? "pos" : tone === "neg" ? "neg" : "muted";
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className={`card-value ${toneClass}`}>{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

function ConfigField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="muted" style={{ fontSize: 11, display: "block", marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  );
}

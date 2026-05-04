// Consolidated Real-trading panel — unifies Strategies / Signals / Trades /
// Paper into a single view, mirroring Fast3's all-in-one layout.
//
// Sections (stacked):
//   1. KPI cards (Deriv balance, daily P&L, open trades, WR)
//   2. Per-Strategy table (silver_ob, silver_fvg, gold_fvg, plat_fvg)
//   3. Recent Live Trades (with detail expand)
//   4. Recent Paper Trades
//   5. Recent Signals (filterable)

import React, { useEffect, useState } from "react";
import {
  api,
  fmtAgo,
  fmtGranularity,
  fmtTime,
  type ClosedPaperPosition,
  type PaperResp,
  type RealTrade,
  type Signal,
  type StateResp,
  type StrategyStats,
} from "../api";

export function RealPanel({ state, strategies }: {
  state: StateResp | null;
  strategies: StrategyStats[];
}) {
  const [liveTrades, setLiveTrades] = useState<RealTrade[]>([]);
  const [paper, setPaper] = useState<PaperResp | null>(null);
  const [paperTrades, setPaperTrades] = useState<ClosedPaperPosition[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [expandedTrade, setExpandedTrade] = useState<string | null>(null);
  const [sigFilterSym, setSigFilterSym] = useState("ALL");
  const [sigFilterSide, setSigFilterSide] = useState<"ALL" | "BUY" | "SELL">("ALL");

  useEffect(() => {
    const load = async () => {
      try {
        const [t, p, pt, sig] = await Promise.all([
          api.trades(100, "real"),
          api.paper(),
          api.paperTrades(100),
          api.signals(100),
        ]);
        setLiveTrades(t.trades);
        setPaper(p);
        setPaperTrades(pt.trades);
        setSignals(sig.signals);
      } catch {}
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  // ── KPI computations ──
  const account = state?.account ?? null;
  const live = state?.account ?? null;
  const daily = state?.daily ?? null;
  const liveClosed = liveTrades.filter((t) => t.closedAt != null);
  const liveOpen = liveTrades.filter((t) => t.closedAt == null);
  const liveWins = liveClosed.filter((t) => (t.profit ?? 0) > 0).length;
  const liveLosses = liveClosed.length - liveWins;
  const liveWR = liveClosed.length > 0 ? liveWins / liveClosed.length : 0;
  const liveTotalPnl = liveClosed.reduce((acc, t) => acc + (t.profit ?? 0), 0);
  const accountBalance = account?.balance ?? 0;
  const accountLogin = account?.loginid ?? "—";
  const accountIsVirtual = account?.isVirtual ?? false;

  // Signal filters
  const sigSymbols = Array.from(new Set(signals.map((s) => s.symbol))).sort();
  const filteredSignals = signals.filter((s) =>
    (sigFilterSym === "ALL" || s.symbol === sigFilterSym) &&
    (sigFilterSide === "ALL" || s.action === sigFilterSide),
  );

  return (
    <>
      {/* Status banner */}
      <div className={`banner ${accountIsVirtual ? "banner-info" : "banner-warn"}`} style={{ marginBottom: 12, fontWeight: 600 }}>
        {accountIsVirtual ? "🟢" : "🔴"} Real account: <strong>{accountLogin}</strong> · {account?.currency ?? ""} ${accountBalance.toFixed(2)} · {accountIsVirtual ? "DEMO" : "LIVE money"}
        {state?.paused && <span style={{ marginLeft: 8 }} className="pill pill-amber">PAUSED</span>}
      </div>

      {/* KPI grid */}
      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card title="Deriv Balance" value={`$${accountBalance.toFixed(2)}`} sub={accountIsVirtual ? "demo account" : "real money"} tone={accountBalance > 0 ? "pos" : "muted"} />
        <Card title="Today's P&L" value={`${(daily?.profit ?? 0) >= 0 ? "+" : ""}$${(daily?.profit ?? 0).toFixed(2)}`} sub={`${daily?.tradesOpened ?? 0} opened today${daily?.capHit ? " · CAP HIT" : ""}`} tone={(daily?.profit ?? 0) > 0 ? "pos" : (daily?.profit ?? 0) < 0 ? "neg" : "muted"} />
        <Card title="Open / Closed" value={`${state?.openCount ?? 0} / ${state?.totalClosed ?? 0}`} sub={`${liveOpen.length} fast3-tagged open`} tone="muted" />
        <Card title="Live Win Rate" value={liveClosed.length > 0 ? `${(liveWR * 100).toFixed(1)}%` : "—"} sub={`${liveWins}W / ${liveLosses}L · net ${liveTotalPnl >= 0 ? "+" : ""}$${liveTotalPnl.toFixed(2)}`} tone={liveWR >= 0.55 ? "pos" : liveClosed.length > 5 ? "neg" : "muted"} />
      </div>

      {/* ── Per-Strategy ── */}
      <h3 className="section-title">Per-Strategy ({strategies.length})</h3>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Strategy</th>
              <th>Symbol</th>
              <th>TF</th>
              <th>Validated</th>
              <th>Bars seen</th>
              <th>Last bar</th>
              <th>Signals</th>
              <th>Trades</th>
              <th>WR</th>
              <th>P&amp;L</th>
              <th>Last sig</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const pnl = s.live.pnlUsd ?? 0;
              const wr = s.live.winRate ?? 0;
              return (
                <tr key={s.id}>
                  <td>
                    <div className="bold">{s.id}</div>
                    <div className="faint" style={{ fontSize: 11 }}>{s.name}</div>
                  </td>
                  <td className="mono">{s.symbols.join(", ")}</td>
                  <td><span className="strat-chip">{fmtGranularity(s.granularity)}</span></td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {s.validation.expectancyR != null && <>{s.validation.expectancyR.toFixed(2)}R · </>}
                    {s.validation.winRate != null && <>{(s.validation.winRate * 100).toFixed(0)}% · </>}
                    {s.validation.pnlUsd != null && <>${s.validation.pnlUsd.toFixed(0)}</>}
                  </td>
                  <td className={`mono ${s.live.barsSeen === 0 ? "neg" : ""}`}>{s.live.barsSeen}</td>
                  <td className="faint">{fmtAgo(s.live.lastBarSeenAt)}</td>
                  <td className="mono">{s.live.signals}</td>
                  <td className="mono">{s.live.trades}</td>
                  <td className="mono">{s.live.trades > 0 ? `${(wr * 100).toFixed(0)}%` : "—"}</td>
                  <td className={`mono ${pnl > 0 ? "pos" : pnl < 0 ? "neg" : "muted"}`}>
                    {pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}
                  </td>
                  <td className="faint">{fmtAgo(s.live.lastSignalAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Recent Live Trades ── */}
      <h3 className="section-title">Recent Live Trades ({liveTrades.length})</h3>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        {liveTrades.length === 0 ? (
          <div className="empty"><span className="empty-emoji">$</span>No real trades yet</div>
        ) : (
          <table>
            <thead>
              <tr><th></th><th>Closed</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>Profit</th><th>Status</th></tr>
            </thead>
            <tbody>
              {liveTrades.slice(0, 50).map((t) => (
                <React.Fragment key={t.id}>
                  <tr onClick={() => setExpandedTrade(expandedTrade === t.id ? null : t.id)} style={{ cursor: "pointer" }}>
                    <td className="faint">{expandedTrade === t.id ? "▼" : "▶"}</td>
                    <td className="mono faint">{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                    <td className="mono">{t.symbol}</td>
                    <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td><span className="strat-chip">{t.detector}</span></td>
                    <td className="mono">${t.stake.toFixed(2)}</td>
                    <td className={`mono ${(t.profit ?? 0) > 0 ? "pos" : (t.profit ?? 0) < 0 ? "neg" : "muted"}`}>
                      {t.profit != null ? `${t.profit >= 0 ? "+" : ""}$${t.profit.toFixed(2)}` : "—"}
                    </td>
                    <td>
                      <span className={`pill ${t.status === "won" ? "pill-green" : t.status === "lost" ? "pill-red" : "pill-blue"}`}>{t.status}</span>
                    </td>
                  </tr>
                  {expandedTrade === t.id && (
                    <tr className="row-expand">
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div className="detail-grid">
                          <div><div className="detail-key">Contract ID</div><div className="detail-val mono">{t.contractId}</div></div>
                          <div><div className="detail-key">Family</div><div className="detail-val">{t.family} · {t.contractType}</div></div>
                          <div><div className="detail-key">Multiplier</div><div className="detail-val mono">{t.multiplier ?? "—"}×</div></div>
                          <div><div className="detail-key">Buy / Payout</div><div className="detail-val mono">${t.buyPrice.toFixed(2)} / {t.payout != null ? `$${t.payout.toFixed(2)}` : "—"}</div></div>
                          <div><div className="detail-key">Entry / Exit</div><div className="detail-val mono">{t.entrySpot?.toFixed(5) ?? "—"} / {t.exitSpot?.toFixed(5) ?? "—"}</div></div>
                          <div><div className="detail-key">TP / SL</div><div className="detail-val mono">{t.takeProfit != null ? `$${t.takeProfit.toFixed(2)}` : "—"} / {t.stopLoss != null ? `$${t.stopLoss.toFixed(2)}` : "—"}</div></div>
                          <div><div className="detail-key">Opened</div><div className="detail-val mono">{fmtTime(t.openedAt)}</div></div>
                          <div><div className="detail-key">Closed</div><div className="detail-val mono">{t.closedAt ? fmtTime(t.closedAt) : "—"}</div></div>
                          <div><div className="detail-key">Sandbox</div><div className="detail-val">{t.sandbox ?? "real"}{t.sandboxStrategyId ? ` · ${t.sandboxStrategyId}` : ""}</div></div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Paper Trading ── */}
      <h3 className="section-title">Paper Sandbox {paper ? <span className="muted" style={{ fontSize: 11 }}>${paper.balance.toFixed(2)} · {paperTrades.length} trades</span> : null}</h3>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        {!paper ? (
          <div className="empty">Loading…</div>
        ) : paperTrades.length === 0 ? (
          <div className="empty"><span className="empty-emoji">📝</span>No paper trades yet</div>
        ) : (
          <table>
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>P&amp;L</th><th>R</th></tr>
            </thead>
            <tbody>
              {paperTrades.slice(0, 30).map((t) => (
                <tr key={t.id}>
                  <td className="mono faint">{fmtTime(t.closedAt)}</td>
                  <td className="mono">{t.symbol}</td>
                  <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                  <td><span className="strat-chip">{t.detector}</span></td>
                  <td className="mono">${t.stake.toFixed(2)}</td>
                  <td className={`mono ${t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "muted"}`}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                  <td className="mono muted">{t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Recent Signals ── */}
      <h3 className="section-title">Recent Signals ({filteredSignals.length} of {signals.length})</h3>
      <div className="card table-card">
        <div className="filters">
          <select className="filter-select" value={sigFilterSym} onChange={(e) => setSigFilterSym(e.target.value)}>
            <option value="ALL">All symbols</option>
            {sigSymbols.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="filter-select" value={sigFilterSide} onChange={(e) => setSigFilterSide(e.target.value as "ALL" | "BUY" | "SELL")}>
            <option value="ALL">Both sides</option>
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>
        {filteredSignals.length === 0 ? (
          <div className="empty"><span className="empty-emoji">⚡</span>No signals match the filter</div>
        ) : (
          <table>
            <thead>
              <tr><th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Conf.</th><th>Reason</th></tr>
            </thead>
            <tbody>
              {filteredSignals.slice(0, 50).map((s) => (
                <tr key={s.id}>
                  <td className="mono faint">{fmtTime(s.emittedAt)}</td>
                  <td className="mono">{s.symbol}</td>
                  <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
                  <td><span className="strat-chip">{s.detector}</span></td>
                  <td className="mono">{(s.confidence * 100).toFixed(0)}%</td>
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
  const toneClass = tone === "pos" ? "pos" : tone === "neg" ? "neg" : "muted";
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className={`card-value ${toneClass}`}>{value}</div>
      {sub && <div className="card-sub">{sub}</div>}
    </div>
  );
}

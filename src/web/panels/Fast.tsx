// Fast-trade sandbox panel. Mirrors the Synth panel but for the
// CRASH500N + BOOM300N drift-fade scalp strategies with martingale stake
// escalation. /api/fast-paper/* endpoints back this panel.

import React, { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from "lightweight-charts";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type FastMartingaleSnapshot, type FastPaperResp, type Signal, type StrategyStats } from "../api";

export function FastPanel({ doAction, pending }: {
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [paper, setPaper] = useState<FastPaperResp | null>(null);
  const [trades, setTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [martingale, setMartingale] = useState<Record<string, FastMartingaleSnapshot>>({});
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterSym, setFilterSym] = useState<string>("ALL");
  const [filterRes, setFilterRes] = useState<"ALL" | "won" | "lost">("ALL");
  const [resetTo, setResetTo] = useState<string>("200");

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s, sig] = await Promise.all([
          api.fastPaper(), api.fastPaperTrades(500), api.fastPaperEquity(), api.fastStrategies(), api.fastSignals(100),
        ]);
        setPaper(p);
        setTrades(t.trades);
        setEquity(e.equity);
        setStrategies(s.strategies);
        setMartingale(s.martingale);
        setSignals(sig.signals);
        setError(null);
      } catch (err) { setError((err as Error).message); }
    };
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);

  if (error && !paper) return <div className="banner banner-danger">⚠ {error}</div>;
  if (!paper) return <div className="empty">Loading…</div>;

  const stats = paper.stats;
  const symbols = Array.from(new Set(trades.map((t) => t.symbol))).sort();
  const filtered = trades.filter((t) =>
    (filterSym === "ALL" || t.symbol === filterSym) &&
    (filterRes === "ALL" || t.result === filterRes)
  );

  return (
    <>
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Fast Sandbox</strong> — paper-only. CRASH500N drift-fade BUY · BOOM300N drift-fade SELL.
        High-frequency scalps on Boom/Crash synthetics with martingale stake escalation.
        Tight TP (0.3×ATR) + wide SL (2.0×ATR). Martingale: 2.2× per loss, max 5 levels, $30 per-trade cap.
        Target ≥60% WR over 7-day paper before live promotion.
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card title="Balance" value={`$${paper.balance.toFixed(2)}`} sub={`started at $${paper.startingBalance.toFixed(2)}`} tone={paper.balance >= paper.startingBalance ? "pos" : "neg"} />
        <Card title="Total P&L" value={`${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}`} sub={`${stats.pnlPct >= 0 ? "+" : ""}${stats.pnlPct.toFixed(1)}% from start`} tone={stats.totalPnl >= 0 ? "pos" : "neg"} />
        <Card title="Win Rate" value={stats.trades > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : "—"} sub={`${stats.wins}W / ${stats.losses}L · ${stats.trades} trades · avg ${stats.avgR.toFixed(2)}R`} tone={stats.winRate >= 0.6 ? "pos" : stats.trades > 5 ? "neg" : "muted"} />
        <Card title="Peak / DD" value={`$${stats.peak.toFixed(2)}`} sub={`${stats.ddPct.toFixed(1)}% from peak · ${stats.open} open`} tone={stats.ddPct > -10 ? "pos" : "neg"} />
      </div>

      {/* Martingale ladder snapshot per strategy */}
      <h3 className="section-title">Martingale Ladders</h3>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {strategies.map((s) => {
          const m = martingale[s.id] ?? { level: 0, wins: 0, losses: 0, circuitBreakers: 0, lastCircuitBreakerAt: 0, nextStake: 0.5 };
          const ladderColor = m.level === 0 ? "pos" : m.level >= 3 ? "neg" : "muted";
          return (
            <div key={s.id} className="card">
              <div className="card-title">{s.name}</div>
              <div className="grid grid-3" style={{ marginTop: 6 }}>
                <div>
                  <div className="card-title" style={{ fontSize: 10 }}>Ladder</div>
                  <div className={`card-value ${ladderColor}`} style={{ fontSize: 24 }}>{m.level}/5</div>
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
          onClick={() => doAction(`Reset fast-paper to $${resetTo}? Wipes balance, all closed trades, and all martingale ladders.`, () => api.resetFastPaper(Number(resetTo)))}
        >
          {pending ? "…" : "Reset Fast Sandbox"}
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
          <div className="empty"><span className="empty-emoji">⚡</span>No fast-paper trades yet</div>
        ) : (
          <table>
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th>Side</th><th>Stake</th><th>Entry</th><th>Exit</th><th>R</th><th>P&amp;L</th><th>Result</th></tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id}>
                  <td className="mono faint">{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                  <td className="mono">{t.symbol}</td>
                  <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                  <td className="mono">${t.stake.toFixed(2)}</td>
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
          <div className="empty"><span className="empty-emoji">⚡</span>No fast signals yet</div>
        ) : (
          <table>
            <thead><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Reason</th></tr></thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <td className="mono faint">{fmtTime(s.ts)}</td>
                  <td className="mono">{s.symbol}</td>
                  <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
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

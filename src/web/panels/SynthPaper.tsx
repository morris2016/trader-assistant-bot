// Synth paper-trading panel. Mirrors the Paper panel but talks to the
// /api/synth-paper/* endpoints — RDBULL FVG, JD100 Sweep, BOOM300N OB sandbox.

import React, { useEffect, useRef, useState } from "react";
import { createChart, LineSeries, type IChartApi, type ISeriesApi, ColorType } from "lightweight-charts";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type PaperPosition, type PaperResp, type Signal, type StrategyStats } from "../api";

export function SynthPaperPanel({ doAction, pending }: {
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [paper, setPaper] = useState<PaperResp | null>(null);
  const [trades, setTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [signals, setSignals] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filterSym, setFilterSym] = useState<string>("ALL");
  const [filterRes, setFilterRes] = useState<"ALL" | "won" | "lost">("ALL");
  const [resetTo, setResetTo] = useState<string>("500");

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s, sig] = await Promise.all([
          api.synthPaper(), api.synthPaperTrades(500), api.synthPaperEquity(), api.synthStrategies(), api.synthSignals(100),
        ]);
        setPaper(p); setTrades(t.trades); setEquity(e.equity); setStrategies(s.strategies); setSignals(sig.signals); setError(null);
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
        <strong>Synth Sandbox</strong> — paper-only. RDBULL FVG · JD100 Sweep · BOOM300N OB. These
        strategies were validated 2026-04-29 via 3-window cross-validation; they live-paper trade
        here so we can verify performance before promoting to real money.
      </div>

      <div className="grid grid-4">
        <div className="card">
          <div className="card-title">Balance</div>
          <div className={`card-value ${stats.balance >= stats.startingBalance ? "pos" : "neg"}`}>${stats.balance.toFixed(2)}</div>
          <div className="card-sub">started at ${stats.startingBalance.toFixed(2)}</div>
        </div>
        <div className="card">
          <div className="card-title">Total P&amp;L</div>
          <div className={`card-value ${stats.totalPnl >= 0 ? "pos" : "neg"}`}>{stats.totalPnl >= 0 ? "+" : ""}${stats.totalPnl.toFixed(2)}</div>
          <div className="card-sub">{stats.pnlPct >= 0 ? "+" : ""}{stats.pnlPct.toFixed(1)}% from start</div>
        </div>
        <div className="card">
          <div className="card-title">Win Rate</div>
          <div className="card-value">{stats.trades > 0 ? `${(stats.winRate * 100).toFixed(0)}%` : "—"}</div>
          <div className="card-sub">{stats.wins}W / {stats.losses}L · {stats.trades} trades · avg {stats.avgR >= 0 ? "+" : ""}{stats.avgR.toFixed(2)}R</div>
        </div>
        <div className="card">
          <div className="card-title">Peak / DD</div>
          <div className="card-value pos">${stats.peak.toFixed(2)}</div>
          <div className="card-sub">{stats.ddPct.toFixed(1)}% from peak · {stats.open} open</div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Per-Strategy (live)</div>
          <div className="section-sub">{strategies.length} synth strategies</div>
        </div>
        <div className="card table-card">
          <table>
            <thead>
              <tr>
                <th>Strategy</th><th>Symbols</th><th>TF</th><th>Validated $</th><th>Live trades</th><th>Live W/L</th><th>Live $</th><th>Last signal</th>
              </tr>
            </thead>
            <tbody>
              {strategies.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong><div className="card-sub" style={{ marginTop: 2 }}>{s.description}</div></td>
                  <td className="mono">{s.symbols.join(", ")}</td>
                  <td className="mono">{s.granularity / 60}m</td>
                  <td className="mono pos">+${(s.validation.pnlUsd ?? 0).toFixed(0)}</td>
                  <td className="mono">{s.live.trades}</td>
                  <td className="mono">{s.live.wins}W/{s.live.losses}L</td>
                  <td className={`mono ${s.live.pnlUsd > 0 ? "pos" : s.live.pnlUsd < 0 ? "neg" : "muted"}`}>{s.live.pnlUsd >= 0 ? "+" : ""}${s.live.pnlUsd.toFixed(2)}</td>
                  <td className="mono faint">{fmtTime(s.live.lastSignalAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Equity Curve</div>
          <div className="section-sub">{equity.length} samples</div>
        </div>
        <div className="card" style={{ padding: 0 }}>
          <EquityChart equity={equity} startingBalance={stats.startingBalance} />
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Synth Signals ({signals.length})</div>
          <div className="section-sub">Most recent first · all detector emissions on RDBULL/JD100/BOOM300N</div>
        </div>
        <div className="card table-card">
          {signals.length === 0 ? (
            <div className="empty"><span className="empty-emoji">⚡</span>No synth signals yet — bot may still be warming up. RDBULL fires ~2.7/day on 1h.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Time</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Confidence</th></tr>
              </thead>
              <tbody>
                {signals.slice(0, 50).map((s) => (
                  <tr key={s.id}>
                    <td className="mono faint">{fmtTime(s.emittedAt)}</td>
                    <td className="mono">{s.symbol}</td>
                    <td><span className={`pill ${s.action === "BUY" ? "pill-green" : "pill-red"}`}>{s.action}</span></td>
                    <td><span className="strat-chip">{s.detector}</span></td>
                    <td className="mono">{(s.confidence * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {paper.open.length > 0 && (
        <div className="section">
          <div className="section-header">
            <div className="section-title">Open Synth Positions ({paper.open.length})</div>
          </div>
          <div className="card table-card">
            <table>
              <thead>
                <tr>
                  <th>Opened</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>Entry</th><th>Stop</th><th>TP</th>
                </tr>
              </thead>
              <tbody>
                {paper.open.map((p) => <OpenRow key={p.id} p={p} />)}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="section">
        <div className="section-header">
          <div className="section-title">Closed Synth Trades ({filtered.length})</div>
        </div>
        <div className="card table-card">
          <div className="filters">
            <select className="filter-select" value={filterSym} onChange={(e) => setFilterSym(e.target.value)}>
              <option value="ALL">All symbols</option>
              {symbols.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="filter-select" value={filterRes} onChange={(e) => setFilterRes(e.target.value as any)}>
              <option value="ALL">Won + Lost</option>
              <option value="won">Won only</option>
              <option value="lost">Lost only</option>
            </select>
          </div>
          {filtered.length === 0 ? (
            <div className="empty"><span className="empty-emoji">📊</span>No synth paper trades yet — RDBULL/JD100/BOOM300N signals will trigger trades here.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Closed</th><th>Symbol</th><th>Side</th><th>Detector</th><th>Stake</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>R</th><th>Result</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 200).map((t) => (
                  <tr key={t.id}>
                    <td className="mono faint">{fmtTime(t.closedAt)}</td>
                    <td className="mono">{t.symbol}</td>
                    <td><span className={`pill ${t.side === "BUY" ? "pill-green" : "pill-red"}`}>{t.side}</span></td>
                    <td><span className="strat-chip">{t.detector}</span></td>
                    <td className="mono">${t.stake.toFixed(2)}</td>
                    <td className="mono faint">{t.entryPrice.toFixed(5)}</td>
                    <td className="mono faint">{t.exitPrice.toFixed(5)}</td>
                    <td className={`mono ${t.pnl > 0 ? "pos" : t.pnl < 0 ? "neg" : "muted"}`}>{t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}</td>
                    <td className={`mono ${t.rMultiple > 0 ? "pos" : t.rMultiple < 0 ? "neg" : "muted"}`}>{t.rMultiple >= 0 ? "+" : ""}{t.rMultiple.toFixed(2)}R</td>
                    <td><span className={`pill ${t.result === "won" ? "pill-green" : "pill-red"}`}>{t.result}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Reset Synth Sandbox</div>
          <div className="section-sub">Wipe synth balance + trade history + adaptive shift, restart at fresh balance</div>
        </div>
        <div className="card card-padded">
          <div className="row">
            <input
              type="number" min={50} step={50} className="filter-input"
              value={resetTo}
              onChange={(e) => setResetTo(e.target.value)}
              style={{ width: 120 }}
            />
            <button className="btn btn-warn" disabled={pending !== null} onClick={() => doAction(`Reset synth sandbox to $${resetTo}?`, () => api.resetSynthPaper(Number(resetTo)))}>
              ⟳ Reset Synth Sandbox
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function OpenRow({ p }: { p: PaperPosition }) {
  return (
    <tr>
      <td className="mono faint">{fmtTime(p.openedAt)}</td>
      <td className="mono">{p.symbol}</td>
      <td><span className={`pill ${p.side === "BUY" ? "pill-green" : "pill-red"}`}>{p.side}</span></td>
      <td><span className="strat-chip">{p.detector}</span></td>
      <td className="mono">${p.stake.toFixed(2)}</td>
      <td className="mono faint">{p.entryPrice.toFixed(5)}</td>
      <td className="mono neg">{p.stopPrice.toFixed(5)}</td>
      <td className="mono pos">{p.takeProfitPrice.toFixed(5)}</td>
    </tr>
  );
}

function EquityChart({ equity, startingBalance }: { equity: EquityPoint[]; startingBalance: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 260,
      layout: { background: { type: ColorType.Solid, color: "#11161f" }, textColor: "#8b96a6" },
      grid: { vertLines: { color: "#1f2733" }, horzLines: { color: "#1f2733" } },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a3343" },
      rightPriceScale: { borderColor: "#2a3343" },
      crosshair: { mode: 0 },
    });
    const series = chart.addSeries(LineSeries, { color: "#bf7af0", lineWidth: 2 });
    chartRef.current = chart;
    seriesRef.current = series;
    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!seriesRef.current) return;
    const data = equity.map((p) => ({ time: Math.floor(p.ts / 1000), value: p.balance })) as any;
    seriesRef.current.setData(data);
    if (chartRef.current && data.length > 0) chartRef.current.timeScale().fitContent();
  }, [equity]);

  return (
    <div>
      <div ref={containerRef} style={{ width: "100%", height: 260 }} />
      <div className="card-sub" style={{ padding: "8px 16px" }}>
        Starting balance: ${startingBalance.toFixed(2)}
      </div>
    </div>
  );
}

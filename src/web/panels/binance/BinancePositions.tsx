// Open positions table + per-trade Cancel + live progress chart.
// Shows all open positions across all stacks (1h SMC + 15m HF), with live
// mark price, real Δ% (from mark, not peak), uPnL, and per-row Cancel button.
// Includes a multi-line SVG of Δ% over time so the operator can watch the
// trades breathe.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtEatTime } from "../../api";

function binanceUrl(symbol: string, testnet: boolean): string {
  return testnet
    ? `https://testnet.binancefuture.com/en/futures/${symbol}`
    : `https://www.binance.com/en/futures/${symbol}`;
}

export function BinancePositionsPanel() {
  const [bs, setBs] = useState<any>(null);
  const [cancelBusy, setCancelBusy] = useState<Record<string, boolean>>({});
  const [cancelErr, setCancelErr] = useState<string | null>(null);

  async function refresh() { try { setBs(await api.binanceState()); } catch {} }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id); }, []);

  // Per-open-trade live progress snapshots (ref, ephemeral, ~30min window)
  const progressRef = useRef<Map<string, Array<{ ts: number; pct: number }>>>(new Map());
  useEffect(() => {
    if (!bs) return;
    const open = (bs.state?.open ?? []) as any[];
    const now = Math.floor(Date.now() / 1000);
    const aliveIds = new Set<string>();
    for (const t of open) {
      aliveIds.add(t.id);
      const arr = progressRef.current.get(t.id) ?? [];
      const ref = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
      const pct = ((ref - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
      arr.push({ ts: now, pct });
      if (arr.length > 600) arr.splice(0, arr.length - 600);
      progressRef.current.set(t.id, arr);
    }
    for (const id of Array.from(progressRef.current.keys())) {
      if (!aliveIds.has(id)) progressRef.current.delete(id);
    }
  }, [bs]);

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

  if (!bs) return <div className="empty-state">Loading…</div>;
  if (!bs.hasCreds) return <div className="banner banner-warn">No Binance credentials. Go to Settings.</div>;

  const open = (bs.state?.open ?? []) as any[];
  const testnet = !!bs.testnet;
  const totalUpnl = open.reduce((s, t) => {
    const mark = +(t.markPrice ?? t.peakFav ?? t.entryPrice);
    const livePct = ((mark - +t.entryPrice) / +t.entryPrice) * 100 * (t.side === "LONG" ? 1 : -1);
    return s + (+t.stake) * (+t.leverage) * (livePct / 100);
  }, 0);

  return (
    <>
      <div className="section">
        <div className="section-header">
          <div className="section-title">Open positions ({open.length}) — total uPnL <span style={{ color: totalUpnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{totalUpnl >= 0 ? "+" : ""}${totalUpnl.toFixed(2)}</span></div>
          <div className="section-sub">
            Live mark price + uPnL. Trail-arm fires after +1×ATR; exits at peak − 0.3×ATR via MARKET reduce-only.
            Click Cancel to force-close any row at market.
          </div>
        </div>
        {cancelErr && <div className="banner banner-warn" style={{ marginBottom: 8 }}>{cancelErr}</div>}
        <div className="card card-padded">
          {open.length === 0 ? (
            <div className="muted">No open positions.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Asset</th><th>Pattern</th><th>Side</th>
                  <th>Stake</th><th>Lev</th>
                  <th>Entry</th><th>Mark</th><th>Peak</th>
                  <th title="Live Δ% from entry to current mark, signed by side">Δ%</th>
                  <th title="Unrealized $ P&L on this position">uPnL</th>
                  <th>Armed</th><th>Opened (EAT)</th><th></th>
                </tr>
              </thead>
              <tbody>
                {open.map((t: any) => {
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
                      <td className="mono" style={{ color: livePct >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{livePct >= 0 ? "+" : ""}{livePct.toFixed(2)}%</td>
                      <td className="mono" style={{ color: uPnl >= 0 ? "#5fd4a4" : "#d4655f", fontWeight: 600 }}>{uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}</td>
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

      {/* ── Live progress chart per open position ──────────────────── */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Open-trade live progress</div>
          <div className="section-sub">Δ% from entry over time (snapshot every 3s; ~30min rolling window per trade).</div>
        </div>
        <div className="card card-padded">
          {open.length === 0 ? (
            <div className="muted">No open positions to chart.</div>
          ) : (
            <ProgressSvg series={open.map((t: any) => ({
              id: t.id,
              label: `${t.asset.replace("USDT", "")} ${t.pattern}/${t.side}`,
              points: progressRef.current.get(t.id) ?? [],
              armed: !!t.armed,
            }))} />
          )}
        </div>
      </div>
    </>
  );
}

// ── Multi-line SVG of Δ% over time, one line per open trade ─────────────
const SERIES_COLOURS = ["#7fb3ff", "#5fd4a4", "#d4a35f", "#d4655f", "#b85fd4", "#5fd4d4", "#d4d45f", "#a35fd4"];
function ProgressSvg({ series }: { series: Array<{ id: string; label: string; points: Array<{ ts: number; pct: number }>; armed: boolean }> }) {
  const w = 800, h = 240, padL = 50, padR = 150, padT = 12, padB = 22;
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
            {last && <circle cx={xScale(last.ts)} cy={yScale(last.pct)} r={3} fill={colour} />}
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

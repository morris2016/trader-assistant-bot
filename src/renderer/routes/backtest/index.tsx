import { useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "../../components/Chart";
import { SYMBOLS } from "@shared/symbols";
import type {
  BacktestResult,
  DetectorConfig,
  Granularity,
  LiquidityPool,
  OrderBlock,
  Signal,
  StructureMark,
  SymbolCode,
} from "@shared/types";
import { useStore } from "../../store";

const GRANULARITIES: { label: string; value: Granularity }[] = [
  { label: "1 min",  value: 60 },
  { label: "2 min",  value: 120 },
  { label: "5 min",  value: 300 },
  { label: "10 min", value: 600 },
  { label: "15 min", value: 900 },
  { label: "30 min", value: 1800 },
  { label: "1 hour", value: 3600 },
];

const COUNTS = [250, 500, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
const SPEEDS = [1, 5, 25, 100, 500];

/**
 * Convert a per-trade %P&L to USD on a leveraged Deriv MULTIPLIER position.
 * Caps each trade at −stake (Deriv auto-stops a position at −100% return).
 */
function tradeUsd(pnlPct: number, stake: number, multiplier: number): number {
  const ret = Math.max(-1, pnlPct * multiplier);
  return stake * ret;
}

export default function BacktestRoute() {
  const settings = useStore((s) => s.settings);
  const [symbol, setSymbol] = useState<SymbolCode>(settings?.activeSymbol ?? "R_100");
  const [granularity, setGranularity] = useState<Granularity>(settings?.granularity ?? 60);
  const [count, setCount] = useState(1000);
  const [atrSlMult, setAtrSlMult] = useState(1.0);
  const [atrTpMult, setAtrTpMult] = useState(2.0);
  const [stakeUsd, setStakeUsd] = useState(50);
  // Deriv MULTIPLIER leverage. 30× is the live-trading default in storage/store.ts.
  // Effective per-trade return = pnlPct × multiplier, capped at −100% (forced stop-out).
  const [multiplier, setMultiplier] = useState(settings?.realTrading.multiplier ?? 30);
  // Round-trip transaction cost in basis points. Realistic typical values:
  // FX majors 1-2, FX minors 2-4, metals 5-10, crypto 5-20.
  const [costBps, setCostBps] = useState(2);
  const [aiMode, setAiMode] = useState<"off" | "primary" | "consensus">("off");
  const [aiIntervalBars, setAiIntervalBars] = useState(30);
  // Filters: which symbols to scan, which detectors to run.
  // Defaults: all non-synthetic symbols selected, all enabled detectors selected.
  const [selectedSymbols, setSelectedSymbols] = useState<Set<SymbolCode>>(
    () => new Set(SYMBOLS.filter((s) => s.group !== "Synthetic").map((s) => s.code)),
  );
  const [selectedDetectorIds, setSelectedDetectorIds] = useState<Set<string>>(new Set());
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const [detectorPickerOpen, setDetectorPickerOpen] = useState(false);

  // Initialize detector selection from settings the first time settings arrive.
  useEffect(() => {
    if (!settings) return;
    if (selectedDetectorIds.size === 0) {
      setSelectedDetectorIds(new Set(settings.detectors.filter((d) => d.enabled).map((d) => d.id)));
    }
    // we intentionally only initialize once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(5);
  const tickRef = useRef<number | null>(null);

  type ScanRow = {
    symbol: SymbolCode;
    label: string;
    group: string;
    trades: number;
    wins: number;
    losses: number;
    winRate: number;
    pnlPct: number;
    pnlUsd: number;
    expectancyR: number;
    error?: string;
  };
  const [scanRows, setScanRows] = useState<ScanRow[]>([]);
  const [scanProgress, setScanProgress] = useState<{ done: number; total: number; current: string } | null>(null);

  // Per-run detector config: take the user's saved detector params but force
  // `enabled` based on the toolbar selection so the user can exclude detectors
  // for a single backtest without changing global Settings.
  const detectors: DetectorConfig[] = useMemo(() => {
    const base = settings?.detectors ?? [];
    return base.map((d) => ({ ...d, enabled: selectedDetectorIds.has(d.id) }));
  }, [settings?.detectors, selectedDetectorIds]);

  // Real-history symbols only (Synthetic indices are GBM-generated, not market data).
  // The scan further narrows to user-selected symbols.
  const realSymbols = useMemo(
    () => SYMBOLS.filter((s) => s.group !== "Synthetic" && selectedSymbols.has(s.code)),
    [selectedSymbols],
  );

  const scanReal = async () => {
    setScanRows([]);
    setError(null);
    const rows: ScanRow[] = [];
    setScanProgress({ done: 0, total: realSymbols.length, current: realSymbols[0]?.label ?? "" });
    for (let i = 0; i < realSymbols.length; i++) {
      const def = realSymbols[i];
      setScanProgress({ done: i, total: realSymbols.length, current: def.label });
      try {
        const r = await window.api.runBacktest({
          symbol: def.code,
          granularity,
          count,
          atrSlMult,
          atrTpMult,
          costBps,
          // Scans force aiMode=off — running DeepSeek on 16 symbols × thousands
          // of bars would be slow and expensive. Test AI on single symbols first.
          aiMode: "off",
          detectors,
          strategy: settings?.strategy,
        });
        const wins = r.trades.filter((t) => t.pnlPct > 0).length;
        const losses = r.trades.length - wins;
        const pnlPct = r.stats.totalPnlPct;
        let totalR = 0;
        let pnlUsd = 0;
        for (const t of r.trades) {
          const riskPct = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
          if (riskPct > 0) totalR += t.pnlPct / riskPct;
          pnlUsd += tradeUsd(t.pnlPct, stakeUsd, multiplier);
        }
        const expectancyR = r.trades.length > 0 ? totalR / r.trades.length : 0;
        rows.push({
          symbol: def.code,
          label: def.label,
          group: def.group,
          trades: r.trades.length,
          wins,
          losses,
          winRate: r.trades.length > 0 ? wins / r.trades.length : 0,
          pnlPct,
          pnlUsd,
          expectancyR,
        });
      } catch (e) {
        rows.push({
          symbol: def.code, label: def.label, group: def.group,
          trades: 0, wins: 0, losses: 0, winRate: 0, pnlPct: 0, pnlUsd: 0, expectancyR: 0,
          error: (e as Error).message,
        });
      }
      setScanRows([...rows]);
    }
    setScanProgress(null);
  };

  const run = async () => {
    setLoading(true);
    setError(null);
    setPlaying(false);
    try {
      const r = await window.api.runBacktest({
        symbol,
        granularity,
        count,
        atrSlMult,
        atrTpMult,
        costBps,
        aiMode,
        aiIntervalBars,
        aiMinConfidence: settings?.deepseekMinConfidence,
        detectors,
        strategy: settings?.strategy,
      });
      setResult(r);
      setCursor(r.candles.length > 0 ? r.candles.length - 1 : 0);
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Playback loop
  useEffect(() => {
    if (!playing || !result) return;
    const intervalMs = Math.max(8, Math.floor(1000 / speed));
    const id = window.setInterval(() => {
      setCursor((c) => {
        if (!result) return c;
        const next = c + 1;
        if (next >= result.candles.length) {
          setPlaying(false);
          return result.candles.length - 1;
        }
        return next;
      });
    }, intervalMs);
    tickRef.current = id;
    return () => window.clearInterval(id);
  }, [playing, speed, result]);

  // Visible candles + overlays at cursor
  const visibleCandles = useMemo(
    () => (result ? result.candles.slice(0, cursor + 1) : []),
    [result, cursor],
  );
  const visibleSignals: Signal[] = useMemo(() => {
    if (!result) return [];
    const out: Signal[] = [];
    for (let i = 0; i <= cursor; i++) out.push(...result.signalsAt[i]);
    return out;
  }, [result, cursor]);
  const visibleBlocks: OrderBlock[] = useMemo(() => {
    if (!result) return [];
    // Rebuild the active (un-mitigated) block set up to the cursor.
    const active = new Map<string, OrderBlock>();
    for (let i = 0; i <= cursor; i++) {
      for (const b of result.blocksCreatedAt[i]) active.set(b.id, { ...b });
      for (const id of result.blocksMitigatedAt[i]) active.delete(id);
    }
    return Array.from(active.values());
  }, [result, cursor]);

  const visibleMarks: StructureMark[] = useMemo(() => {
    if (!result?.structureMarksAt) return [];
    const marks: StructureMark[] = [];
    for (let i = 0; i <= cursor; i++) marks.push(...result.structureMarksAt[i]);
    return marks;
  }, [result, cursor]);

  const visiblePools: LiquidityPool[] = useMemo(() => {
    if (!result?.poolsCreatedAt) return [];
    const active = new Map<string, LiquidityPool>();
    for (let i = 0; i <= cursor; i++) {
      for (const p of result.poolsCreatedAt[i]) active.set(p.id, { ...p });
      for (const s of result.poolsSweptAt[i]) {
        const p = active.get(s.id);
        if (p) p.sweptEpoch = s.sweptEpoch;
      }
      for (const id of result.poolsRemovedAt[i]) active.delete(id);
    }
    return Array.from(active.values());
  }, [result, cursor]);

  const pct = result ? ((cursor + 1) / result.candles.length) * 100 : 0;

  return (
    <>
      <div className="toolbar">
        <label style={lbl}>SYMBOL</label>
        <select value={symbol} onChange={(e) => setSymbol(e.target.value as SymbolCode)}>
          {SYMBOLS.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
        </select>
        <label style={lbl}>TF</label>
        <select value={granularity} onChange={(e) => setGranularity(+e.target.value as Granularity)}>
          {GRANULARITIES.map((g) => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <label style={lbl}>BARS</label>
        <select value={count} onChange={(e) => setCount(+e.target.value)}>
          {COUNTS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <button
          className="btn"
          onClick={() => { setSymbolPickerOpen((v) => !v); setDetectorPickerOpen(false); }}
          title="Filter which symbols the scan iterates over."
        >
          Symbols {selectedSymbols.size}/{SYMBOLS.filter((s) => s.group !== "Synthetic").length}
        </button>
        <button
          className="btn"
          onClick={() => { setDetectorPickerOpen((v) => !v); setSymbolPickerOpen(false); }}
          title="Choose which strategies (detectors) run. Affects single-symbol Run + scan."
        >
          Strategies {selectedDetectorIds.size}/{settings?.detectors.length ?? 0}
        </button>
        <label style={lbl}>SL ×ATR</label>
        <input
          type="number"
          step={0.1}
          min={0.1}
          value={atrSlMult}
          onChange={(e) => setAtrSlMult(Math.max(0.1, +e.target.value || 1))}
          style={{ width: 64 }}
        />
        <label style={lbl}>TP ×ATR</label>
        <input
          type="number"
          step={0.1}
          min={0.1}
          value={atrTpMult}
          onChange={(e) => setAtrTpMult(Math.max(0.1, +e.target.value || 2))}
          style={{ width: 64 }}
        />
        <span style={{ ...lbl, color: atrTpMult / atrSlMult >= 1 ? "#5fd4a4" : "#e05f8a" }}>
          R:R {(atrTpMult / atrSlMult).toFixed(2)}:1
        </span>
        <label style={lbl}>AI</label>
        <select
          value={aiMode}
          onChange={(e) => setAiMode(e.target.value as typeof aiMode)}
          title="Off = rule-based detectors only. Primary = DeepSeek decides every N bars. Consensus = DeepSeek ratifies each detector signal."
        >
          <option value="off">off</option>
          <option value="primary">primary</option>
          <option value="consensus">consensus</option>
        </select>
        {aiMode === "primary" && (
          <>
            <label style={lbl}>every</label>
            <input
              type="number"
              step={1}
              min={1}
              value={aiIntervalBars}
              onChange={(e) => setAiIntervalBars(Math.max(1, +e.target.value || 30))}
              style={{ width: 56 }}
              title="Bars between DeepSeek samples. Each sample is one API call. Estimated calls = bars / interval."
            />
            <span style={lbl}>
              ≈ {Math.ceil(Math.max(0, count - 25) / aiIntervalBars)} calls · ~$
              {(Math.ceil(Math.max(0, count - 25) / aiIntervalBars) * 0.0005).toFixed(3)}
            </span>
          </>
        )}
        <label style={lbl}>STAKE $</label>
        <input
          type="number"
          step={5}
          min={1}
          value={stakeUsd}
          onChange={(e) => setStakeUsd(Math.max(1, +e.target.value || 50))}
          style={{ width: 64 }}
        />
        <label style={lbl}>MULT ×</label>
        <input
          type="number"
          step={5}
          min={1}
          value={multiplier}
          onChange={(e) => setMultiplier(Math.max(1, +e.target.value || 30))}
          style={{ width: 56 }}
          title="Deriv MULTIPLIER leverage. Deriv offers 1× / 10× / 30× / 100× / 200× / 1000× depending on symbol."
        />
        <label style={lbl}>COST bps</label>
        <input
          type="number"
          step={0.5}
          min={0}
          value={costBps}
          onChange={(e) => setCostBps(Math.max(0, +e.target.value))}
          style={{ width: 56 }}
          title="Round-trip transaction cost in basis points (1 bps = 0.01%). Realistic typical values: FX majors 1-2, FX minors 2-4, metals 5-10, crypto 5-20. Subtracted from each closed trade's pnl."
        />
        <button className="btn btn-primary" onClick={run} disabled={loading || scanProgress !== null}>
          {loading
            ? (count > 5000 ? `Fetching ${count} bars…` : "Loading…")
            : "Run backtest"}
        </button>
        <button
          className="btn"
          onClick={scanReal}
          disabled={loading || scanProgress !== null}
          title="Run backtest against every non-synthetic symbol (FX, Metals, Crypto)"
        >
          {scanProgress
            ? `Scanning ${scanProgress.done}/${scanProgress.total}…`
            : "Scan all real symbols"}
        </button>
        {error && <span style={{ color: "#e05f8a", marginLeft: 12, fontSize: 12 }}>{error}</span>}
      </div>

      {symbolPickerOpen && (
        <SymbolPicker
          selected={selectedSymbols}
          onChange={setSelectedSymbols}
          onClose={() => setSymbolPickerOpen(false)}
        />
      )}
      {detectorPickerOpen && settings && (
        <DetectorPicker
          settings={settings}
          selected={selectedDetectorIds}
          onChange={setSelectedDetectorIds}
          onClose={() => setDetectorPickerOpen(false)}
        />
      )}

      <div className="page">
        {scanRows.length > 0 && (
          <ScanLeaderboard
            rows={scanRows}
            stakeUsd={stakeUsd}
            multiplier={multiplier}
            atrSlMult={atrSlMult}
            atrTpMult={atrTpMult}
            costBps={costBps}
            granularity={granularity}
            count={count}
            inProgress={scanProgress !== null}
          />
        )}

        {!result ? (
          scanRows.length === 0 ? (
            <div className="card empty-state">
              Choose a symbol + timeframe + bar count, then hit <b>Run backtest</b>.
              Or hit <b>Scan all real symbols</b> to compare every FX / Metals / Crypto
              instrument at the chosen settings.
            </div>
          ) : null
        ) : (
          <>
            <div className="card" style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <button className="btn" onClick={() => { setCursor(0); setPlaying(false); }}>⏮</button>
              <button className="btn" onClick={() => setCursor((c) => Math.max(0, c - 1))}>◀</button>
              {playing ? (
                <button className="btn btn-primary" onClick={() => setPlaying(false)}>⏸ Pause</button>
              ) : (
                <button className="btn btn-primary" onClick={() => {
                  if (!result) return;
                  if (cursor >= result.candles.length - 1) setCursor(0);
                  setPlaying(true);
                }}>▶ Play</button>
              )}
              <button className="btn" onClick={() => setCursor((c) => Math.min((result?.candles.length ?? 1) - 1, c + 1))}>▶</button>
              <button className="btn" onClick={() => setCursor((result?.candles.length ?? 1) - 1)}>⏭</button>
              <label style={lbl}>SPEED</label>
              <select value={speed} onChange={(e) => setSpeed(+e.target.value)}>
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              <input
                type="range"
                min={0}
                max={result.candles.length - 1}
                value={cursor}
                onChange={(e) => setCursor(+e.target.value)}
                style={{ flex: 1, minWidth: 200 }}
              />
              <span style={{ color: "#8a95b8", fontSize: 12, minWidth: 160, textAlign: "right" }}>
                bar {cursor + 1} / {result.candles.length} · {pct.toFixed(0)}%
              </span>
            </div>

            <Chart candles={visibleCandles} orderBlocks={visibleBlocks} signals={visibleSignals} structureMarks={visibleMarks} liquidityPools={visiblePools} symbol={symbol} height={460} />

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 16 }}>
              <section>
                <h3 className="section-title">Stats at cursor</h3>
                <StatsBlock result={result} cursor={cursor} stakeUsd={stakeUsd} multiplier={multiplier} />
              </section>
              <section>
                <h3 className="section-title">Equity curve</h3>
                <EquityCurve values={result.equityByIndex} cursor={cursor} />
              </section>
            </div>

            <section style={{ marginTop: 16 }}>
              <h3 className="section-title">Per-detector</h3>
              <DetectorBreakdown result={result} />
            </section>

            {(result.aiCalls ?? 0) > 0 && (
              <section style={{ marginTop: 16 }}>
                <h3 className="section-title">DeepSeek calls</h3>
                <div className="card" style={{ padding: 12, fontSize: 13 }}>
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                    <span><b>{result.aiCalls}</b> calls · ~${(result.aiCostUsd ?? 0).toFixed(3)}</span>
                    {result.aiConsensus && (
                      <>
                        <span style={{ color: "#5fd4a4" }}>ratified <b>{result.aiConsensus.ratified}</b></span>
                        <span style={{ color: "#e05f8a" }}>vetoed <b>{result.aiConsensus.vetoed}</b></span>
                        <span style={{ color: "#d4a35f" }}>abstained <b>{result.aiConsensus.abstained}</b></span>
                      </>
                    )}
                  </div>
                </div>
              </section>
            )}

            {result.detectorDiagnostics && Object.keys(result.detectorDiagnostics).length > 0 && (
              <section style={{ marginTop: 16 }}>
                <h3 className="section-title">Detector diagnostics (why zones were rejected)</h3>
                <div className="card">
                  {Object.entries(result.detectorDiagnostics).map(([det, counts]) => (
                    <div key={det} style={{ marginBottom: 10 }}>
                      <div style={{ color: "#5fd4a4", fontWeight: 600, marginBottom: 4 }}>{det}</div>
                      <table style={{ fontSize: 12, color: "#8a95b8" }}>
                        <tbody>
                          {Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
                            <tr key={reason}>
                              <td style={{ paddingRight: 16 }}>{reason}</td>
                              <td style={{ fontFamily: "monospace", color: "#e0e5f5" }}>{count}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </div>
    </>
  );
}

const lbl: React.CSSProperties = { color: "#8a95b8", fontSize: 12 };

function StatsBlock({
  result, cursor, stakeUsd, multiplier,
}: { result: BacktestResult; cursor: number; stakeUsd: number; multiplier: number }) {
  const tradesSoFar = result.trades.filter((t) => t.closedAtIndex <= cursor);
  const wins = tradesSoFar.filter((t) => t.pnlPct > 0).length;
  const winRate = tradesSoFar.length > 0 ? wins / tradesSoFar.length : 0;
  const pnl = tradesSoFar.reduce((s, t) => s + t.pnlPct, 0);
  const pnlUsd = tradesSoFar.reduce((s, t) => s + tradeUsd(t.pnlPct, stakeUsd, multiplier), 0);
  const totalR = tradesSoFar.reduce((s, t) => {
    if (!t.atrAtEntry || t.atrAtEntry <= 0) return s;
    const riskPct = Math.abs(t.entryPrice - t.stopPrice) / t.entryPrice;
    return riskPct > 0 ? s + t.pnlPct / riskPct : s;
  }, 0);
  const expectancyR = tradesSoFar.length > 0 ? totalR / tradesSoFar.length : 0;

  return (
    <div className="stats-grid">
      <Stat label="Trades" value={String(tradesSoFar.length)} tone="neutral" />
      <Stat label="Wins" value={String(wins)} tone={wins > 0 ? "ok" : "neutral"} />
      <Stat label="Win rate" value={`${(winRate * 100).toFixed(0)}%`} tone={winRate >= 0.5 ? "ok" : "bad"} />
      <Stat label="P&L" value={`${(pnl * 100).toFixed(2)}%`} tone={pnl >= 0 ? "ok" : "bad"} />
      <Stat label={`P&L $${stakeUsd}×${multiplier}`} value={`${pnlUsd >= 0 ? "+" : ""}$${pnlUsd.toFixed(2)}`} tone={pnlUsd >= 0 ? "ok" : "bad"} />
      <Stat label="Total R" value={`${totalR >= 0 ? "+" : ""}${totalR.toFixed(2)}R`} tone={totalR >= 0 ? "ok" : "bad"} />
      <Stat label="Expectancy" value={`${expectancyR >= 0 ? "+" : ""}${expectancyR.toFixed(2)}R`} tone={expectancyR >= 0 ? "ok" : "bad"} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: "ok" | "bad" | "neutral" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone}`}>{value}</div>
    </div>
  );
}

function SymbolPicker({
  selected, onChange, onClose,
}: {
  selected: Set<SymbolCode>;
  onChange: (s: Set<SymbolCode>) => void;
  onClose: () => void;
}) {
  const groups: Record<string, typeof SYMBOLS> = {};
  for (const s of SYMBOLS) (groups[s.group] ??= []).push(s);

  const toggle = (code: SymbolCode) => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    onChange(next);
  };
  const setGroup = (groupSymbols: typeof SYMBOLS, on: boolean) => {
    const next = new Set(selected);
    for (const s of groupSymbols) {
      if (on) next.add(s.code);
      else next.delete(s.code);
    }
    onChange(next);
  };
  const allReal = SYMBOLS.filter((s) => s.group !== "Synthetic").map((s) => s.code);
  const allEverything = SYMBOLS.map((s) => s.code);

  return (
    <div className="card" style={{ margin: "12px 16px 0", padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Select symbols to scan</h3>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => onChange(new Set(allReal))}>All real</button>
        <button className="btn" onClick={() => onChange(new Set(allEverything))}>All</button>
        <button className="btn" onClick={() => onChange(new Set())}>None</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
        {Object.entries(groups).map(([group, syms]) => {
          const allOn = syms.every((s) => selected.has(s.code));
          const someOn = syms.some((s) => selected.has(s.code));
          return (
            <div key={group} style={{ background: "#0e1528", border: "1px solid #1e2842", borderRadius: 6, padding: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                <input
                  type="checkbox"
                  checked={allOn}
                  ref={(el) => { if (el) el.indeterminate = !allOn && someOn; }}
                  onChange={(e) => setGroup(syms, e.target.checked)}
                />
                <span style={{ fontWeight: 700, color: group === "Synthetic" ? "#d4a35f" : "#5fd4a4", fontSize: 12 }}>
                  {group}{group === "Synthetic" ? " (not real history)" : ""}
                </span>
              </div>
              {syms.map((s) => (
                <label key={s.code} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 4px", fontSize: 12, cursor: "pointer" }}>
                  <input type="checkbox" checked={selected.has(s.code)} onChange={() => toggle(s.code)} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetectorPicker({
  settings, selected, onChange, onClose,
}: {
  settings: { detectors: DetectorConfig[] };
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
}) {
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };
  return (
    <div className="card" style={{ margin: "12px 16px 0", padding: 14 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 className="section-title" style={{ margin: 0 }}>Select strategies</h3>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => onChange(new Set(settings.detectors.map((d) => d.id)))}>All</button>
        <button className="btn" onClick={() => onChange(new Set())}>None</button>
        <button className="btn btn-primary" onClick={onClose}>Done</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 10 }}>
        {settings.detectors.map((d) => (
          <label
            key={d.id}
            style={{
              display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
              background: selected.has(d.id) ? "#0e1528" : "#0a1020",
              border: `1px solid ${selected.has(d.id) ? "#5fd4a4" : "#1e2842"}`,
              borderRadius: 6, cursor: "pointer",
            }}
          >
            <input type="checkbox" checked={selected.has(d.id)} onChange={() => toggle(d.id)} />
            <span style={{ fontWeight: 600, fontSize: 13 }}>{d.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ScanLeaderboard({
  rows, stakeUsd, multiplier, atrSlMult, atrTpMult, costBps, granularity, count, inProgress,
}: {
  rows: Array<{
    symbol: string; label: string; group: string;
    trades: number; wins: number; losses: number; winRate: number;
    pnlPct: number; pnlUsd: number; expectancyR: number; error?: string;
  }>;
  stakeUsd: number;
  multiplier: number;
  atrSlMult: number;
  atrTpMult: number;
  costBps: number;
  granularity: number;
  count: number;
  inProgress: boolean;
}) {
  const sorted = [...rows].sort((a, b) => b.wins - a.wins || b.expectancyR - a.expectancyR);
  const totalTrades = sorted.reduce((s, r) => s + r.trades, 0);
  const totalWins = sorted.reduce((s, r) => s + r.wins, 0);
  const totalUsd = sorted.reduce((s, r) => s + r.pnlUsd, 0);
  const best = sorted.find((r) => r.trades > 0);
  return (
    <section style={{ marginBottom: 16 }}>
      <h3 className="section-title">
        Real-history scan {inProgress ? "(running…)" : `· ranked by wins`}
      </h3>
      <div className="card" style={{ padding: 12 }}>
        <div style={{ fontSize: 12, color: "#8a95b8", marginBottom: 10 }}>
          {count} bars · {Math.round(granularity / 60)}m TF · SL {atrSlMult}×ATR · TP {atrTpMult}×ATR · cost {costBps}bps · ${stakeUsd} stake × {multiplier}× MULTIPLIER
          {best && (
            <span style={{ marginLeft: 12 }}>
              · top: <b style={{ color: "#5fd4a4" }}>{best.label}</b> ({best.wins} wins, {(best.winRate * 100).toFixed(0)}%, {best.pnlUsd >= 0 ? "+" : ""}${best.pnlUsd.toFixed(2)})
            </span>
          )}
        </div>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "#8a95b8", textAlign: "left", borderBottom: "1px solid #1e2842" }}>
              <th style={{ padding: "6px 8px" }}>Symbol</th>
              <th style={{ padding: "6px 8px" }}>Group</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Trades</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Wins</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Losses</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Win rate</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>Expectancy</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>P&amp;L %</th>
              <th style={{ padding: "6px 8px", textAlign: "right" }}>P&amp;L $</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.symbol} style={{ borderBottom: "1px solid #1a2240" }}>
                <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.label}</td>
                <td style={{ padding: "6px 8px", color: "#8a95b8" }}>{r.group}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>{r.error ? "—" : r.trades}</td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: "#5fd4a4", fontWeight: 600 }}>
                  {r.error ? "—" : r.wins}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: "#e05f8a" }}>
                  {r.error ? "—" : r.losses}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: r.winRate >= 0.5 ? "#5fd4a4" : "#e05f8a" }}>
                  {r.error ? "—" : `${(r.winRate * 100).toFixed(0)}%`}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: r.expectancyR >= 0 ? "#5fd4a4" : "#e05f8a" }}>
                  {r.error ? "—" : `${r.expectancyR >= 0 ? "+" : ""}${r.expectancyR.toFixed(2)}R`}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: r.pnlPct >= 0 ? "#5fd4a4" : "#e05f8a" }}>
                  {r.error ? <span style={{ color: "#d4a35f" }}>err</span> : `${(r.pnlPct * 100).toFixed(2)}%`}
                </td>
                <td style={{ padding: "6px 8px", textAlign: "right", color: r.pnlUsd >= 0 ? "#5fd4a4" : "#e05f8a", fontWeight: 700 }}>
                  {r.error ? "—" : `${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`}
                </td>
              </tr>
            ))}
            <tr style={{ borderTop: "2px solid #1e2842", color: "#e0e5f5", fontWeight: 700 }}>
              <td style={{ padding: "8px" }} colSpan={2}>Total</td>
              <td style={{ padding: "8px", textAlign: "right" }}>{totalTrades}</td>
              <td style={{ padding: "8px", textAlign: "right", color: "#5fd4a4" }}>{totalWins}</td>
              <td style={{ padding: "8px", textAlign: "right" }} colSpan={3}></td>
              <td style={{ padding: "8px", textAlign: "right" }}></td>
              <td style={{ padding: "8px", textAlign: "right", color: totalUsd >= 0 ? "#5fd4a4" : "#e05f8a" }}>
                {totalUsd >= 0 ? "+" : ""}${totalUsd.toFixed(2)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function DetectorBreakdown({ result }: { result: BacktestResult }) {
  const rows = Object.entries(result.stats.byDetector);
  if (rows.length === 0) return <div className="empty-state">No trades fired.</div>;
  return (
    <div className="card">
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: "#8a95b8", textAlign: "left", borderBottom: "1px solid #1e2842" }}>
            <th style={{ padding: "8px 10px" }}>Detector</th>
            <th style={{ padding: "8px 10px" }}>Trades</th>
            <th style={{ padding: "8px 10px" }}>Wins</th>
            <th style={{ padding: "8px 10px" }}>Win rate</th>
            <th style={{ padding: "8px 10px", textAlign: "right" }}>Total P&amp;L</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([id, s]) => (
            <tr key={id} style={{ borderBottom: "1px solid #1a2240" }}>
              <td style={{ padding: "8px 10px", fontWeight: 600 }}>{id}</td>
              <td style={{ padding: "8px 10px" }}>{s.totalClosed}</td>
              <td style={{ padding: "8px 10px" }}>{s.wins}</td>
              <td style={{ padding: "8px 10px", color: s.winRate >= 0.5 ? "#5fd4a4" : "#e05f8a" }}>
                {(s.winRate * 100).toFixed(0)}%
              </td>
              <td style={{ padding: "8px 10px", textAlign: "right", color: s.totalPnlPct >= 0 ? "#5fd4a4" : "#e05f8a", fontWeight: 700 }}>
                {(s.totalPnlPct * 100).toFixed(2)}%
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EquityCurve({ values, cursor }: { values: number[]; cursor: number }) {
  const width = 400;
  const height = 120;
  if (values.length === 0) return <div className="card empty-state">No data</div>;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = Math.max(max - min, 1e-6);
  const toX = (i: number) => (i / Math.max(1, values.length - 1)) * width;
  const toY = (v: number) => height - ((v - min) / range) * height;
  const zeroY = toY(0);
  const points = values.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
  const cursorX = toX(Math.min(cursor, values.length - 1));
  const final = values[values.length - 1];
  const cursorVal = values[Math.min(cursor, values.length - 1)] ?? 0;

  return (
    <div className="card" style={{ padding: 14 }}>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: "block" }}>
        <line x1={0} y1={zeroY} x2={width} y2={zeroY} stroke="#1e2842" strokeWidth={1} strokeDasharray="2 2" />
        <polyline
          points={points}
          fill="none"
          stroke={final >= 0 ? "#5fd4a4" : "#e05f8a"}
          strokeWidth={1.5}
        />
        <line x1={cursorX} y1={0} x2={cursorX} y2={height} stroke="#8a95b8" strokeWidth={0.5} />
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, color: "#8a95b8" }}>
        <span>at cursor: <b style={{ color: cursorVal >= 0 ? "#5fd4a4" : "#e05f8a" }}>{(cursorVal * 100).toFixed(2)}%</b></span>
        <span>final: <b style={{ color: final >= 0 ? "#5fd4a4" : "#e05f8a" }}>{(final * 100).toFixed(2)}%</b></span>
      </div>
    </div>
  );
}

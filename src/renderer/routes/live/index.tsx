import { useMemo } from "react";
import { useStore } from "../../store";
import { Chart } from "../../components/Chart";
import { SYMBOLS, SYMBOL_GROUPS, GRANULARITY_OPTIONS, symbolSupports } from "@shared/symbols";
import type { DetectorDiagnostics, Granularity, RealTradeSide, SymbolCode } from "@shared/types";

export default function LiveRoute() {
  const {
    candles, orderBlocks, signals, paper, real, status, settings, regime,
    structureMarks, liquidityPools, symbolMeta, detectorDiagnostics,
    setSymbol, setGranularity, startWatcher, stopWatcher, resetPaper,
    placeManualTrade, closeRealPosition,
  } = useStore();

  const obs = Array.from(orderBlocks.values());
  const pools = Array.from(liquidityPools.values());
  const activeSymbol = status.activeSymbol ?? settings?.activeSymbol ?? "frxEURUSD";
  const account = status.account;
  const realOn = status.realModeEnabled;
  const family = settings?.realTrading.contractFamily ?? "MULTIPLIER";

  // Only show symbols that support the currently-configured contract family
  // so we don't offer a Multiplier on a symbol Deriv can't multiplier-trade.
  const availableSymbols = useMemo(
    () => SYMBOLS.filter((s) => symbolSupports(s.code, family)),
    [family],
  );
  const groupedSymbols = useMemo(() => {
    const by: Record<string, typeof availableSymbols> = {};
    for (const s of availableSymbols) (by[s.group] ??= []).push(s);
    return by;
  }, [availableSymbols]);

  const manualTrade = (side: RealTradeSide) => placeManualTrade(side);

  return (
    <>
      {realOn && (
        <div style={{
          padding: "8px 16px",
          background: account?.isVirtual ? "#4a3e1e" : "#4a1e2e",
          borderBottom: `2px solid ${account?.isVirtual ? "#d4a35f" : "#e05f8a"}`,
          color: account?.isVirtual ? "#d4a35f" : "#e05f8a",
          fontWeight: 700,
          fontSize: 13,
          textAlign: "center",
          letterSpacing: 0.8,
        }}>
          {account?.isVirtual
            ? "● DEMO REAL MODE — placing simulated-money orders via Deriv"
            : "● LIVE REAL MODE — orders below use actual account balance"}
        </div>
      )}

      <div className="toolbar">
        <label style={{ color: "#8a95b8", fontSize: 12 }}>SYMBOL</label>
        <select value={activeSymbol} onChange={(e) => setSymbol(e.target.value as SymbolCode)}>
          {SYMBOL_GROUPS.map((g) =>
            groupedSymbols[g]?.length ? (
              <optgroup key={g} label={g}>
                {groupedSymbols[g].map((s) => (
                  <option key={s.code} value={s.code}>{s.label}</option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        <label style={{ color: "#8a95b8", fontSize: 12 }}>TF</label>
        <select
          value={settings?.granularity ?? 60}
          onChange={(e) => setGranularity(+e.target.value as Granularity)}
        >
          {GRANULARITY_OPTIONS.map((g) => (
            <option key={g.value} value={g.value}>{g.label}</option>
          ))}
        </select>
        {status.watching ? (
          <button className="btn btn-danger" onClick={stopWatcher}>Stop</button>
        ) : (
          <button className="btn btn-primary" onClick={startWatcher}>Start</button>
        )}

        {realOn && (
          <>
            <span style={{ borderLeft: "1px solid #1e2842", height: 22, marginLeft: 8 }} />
            <button
              className="btn"
              style={{ background: "#1e4a38", color: "#5fd4a4", borderColor: "#5fd4a4" }}
              onClick={() => manualTrade("BUY")}
            >
              ↑ BUY {buyLabel(settings)} · {settings?.risk.perTradeMaxStake} {account?.currency}
            </button>
            <button
              className="btn"
              style={{ background: "#4a1e2e", color: "#e05f8a", borderColor: "#e05f8a" }}
              onClick={() => manualTrade("SELL")}
            >
              ↓ SELL {buyLabel(settings)} · {settings?.risk.perTradeMaxStake} {account?.currency}
            </button>
          </>
        )}

        <span style={{ marginLeft: "auto", color: "#8a95b8", fontSize: 12, display: "flex", alignItems: "center", gap: 12 }}>
          {regime && <RegimePill regime={regime} />}
          <span>{candles.length} candles · {obs.length} zones · {signals.length} signals</span>
        </span>
      </div>

      <div className="page">
        <Chart candles={candles} orderBlocks={obs} signals={signals} structureMarks={structureMarks} liquidityPools={pools} symbol={activeSymbol} symbolMeta={symbolMeta} height={520} />

        <DiagnosticsPanel diagnostics={detectorDiagnostics} />

        <div style={{ display: "grid", gridTemplateColumns: realOn ? "1fr 1fr 1fr" : "1fr 1fr", gap: 16, marginTop: 16 }}>
          <section>
            <h3 className="section-title">Paper Trading</h3>
            {paper ? (
              <>
                <div className="stats-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                  <Stat label="Win Rate" value={`${(paper.stats.winRate * 100).toFixed(0)}%`} tone={paper.stats.winRate >= 0.5 ? "ok" : "bad"} />
                  <Stat label="P&L" value={`${(paper.stats.totalPnlPct * 100).toFixed(2)}%`} tone={paper.stats.totalPnlPct >= 0 ? "ok" : "bad"} />
                  <Stat label="Trades" value={String(paper.stats.totalClosed)} tone="neutral" />
                  <Stat label="Open" value={String(paper.stats.openCount)} tone="neutral" />
                </div>
                {paper.stats.totalClosed > 0 && (
                  <button className="btn" onClick={resetPaper} style={{ marginTop: 10 }}>Reset paper trades</button>
                )}
              </>
            ) : <div className="empty-state">Loading…</div>}
          </section>

          {realOn && (
            <section>
              <h3 className="section-title">Real Trading</h3>
              {real ? (
                <>
                  <div className="stats-grid" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
                    <Stat label="Win Rate" value={`${(real.stats.winRate * 100).toFixed(0)}%`} tone={real.stats.winRate >= 0.5 ? "ok" : "bad"} />
                    <Stat label="Today" value={`${real.daily.profit >= 0 ? "+" : ""}${real.daily.profit.toFixed(2)}`} tone={real.daily.profit >= 0 ? "ok" : "bad"} />
                    <Stat label="Trades" value={String(real.stats.totalClosed)} tone="neutral" />
                    <Stat label="Open" value={String(real.open.length)} tone="neutral" />
                  </div>
                  {real.open.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      {real.open.map((t) => (
                        <div key={t.id} className="pos-row">
                          <span className={`pill ${t.side === "BUY" ? "pill-buy" : "pill-sell"}`}>{t.side}</span>
                          <span style={{ fontWeight: 600 }}>{t.symbol}</span>
                          <span style={{ color: "#8a95b8", fontSize: 12 }}>
                            {t.stake.toFixed(2)} {t.currency}
                            {t.family === "MULTIPLIER" ? ` · ${t.multiplier}×` : ` · ${t.durationTicks}t`}
                          </span>
                          {t.family === "MULTIPLIER" && (
                            <button
                              className="btn"
                              style={{ padding: "4px 10px", fontSize: 11 }}
                              onClick={() => closeRealPosition(t.id)}
                            >
                              Close
                            </button>
                          )}
                          <span style={{ marginLeft: "auto", color: "#6b7390", fontSize: 11 }}>
                            #{t.contractId} · {t.detector}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                  {real.daily.capHit && (
                    <div style={{
                      marginTop: 10, padding: 10, background: "#4a1e2e", color: "#e05f8a",
                      borderRadius: 6, border: "1px solid #e05f8a", fontSize: 12, fontWeight: 600,
                    }}>
                      Daily loss cap hit. Real mode paused. Adjust caps in Settings or reset the day to resume.
                    </div>
                  )}
                </>
              ) : <div className="empty-state">Loading…</div>}
            </section>
          )}

          <section>
            <h3 className="section-title">Recent Signals</h3>
            {signals.length === 0 ? (
              <div className="empty-state">No signals yet. Waiting for the next bar close.</div>
            ) : (
              signals.slice(0, 20).map((s) => (
                <div key={s.id} className="signal-row">
                  <span className={`pill ${s.action === "BUY" ? "pill-buy" : "pill-sell"}`}>{s.action}</span>
                  <span style={{ fontWeight: 600 }}>{s.detector}</span>
                  <span style={{ color: "#8a95b8", fontSize: 12 }}>{s.reason}</span>
                  <span style={{ marginLeft: "auto", color: "#6b7390", fontSize: 11 }}>
                    {new Date(s.ts).toLocaleTimeString()} · {(s.confidence * 100).toFixed(0)}%
                  </span>
                </div>
              ))
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function DiagnosticsPanel({ diagnostics }: { diagnostics: Map<string, DetectorDiagnostics> }) {
  const entries = Array.from(diagnostics.values());
  if (entries.length === 0) {
    return (
      <div style={{
        marginTop: 12, padding: "8px 12px",
        background: "#0e1528", border: "1px solid #1e2842", borderRadius: 6,
        color: "#6b7390", fontSize: 11, fontFamily: "monospace",
      }}>
        Detector diagnostics — waiting for first bar close…
      </div>
    );
  }
  return (
    <div style={{
      marginTop: 12, padding: "8px 12px",
      background: "#0e1528", border: "1px solid #1e2842", borderRadius: 6,
      fontSize: 11, fontFamily: "monospace", color: "#8a95b8",
    }}>
      {entries.map((d) => {
        const total = Object.values(d.rejections).reduce((a, b) => a + b, 0);
        const sorted = Object.entries(d.rejections).sort((a, b) => b[1] - a[1]);
        return (
          <div key={d.detector} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center" }}>
            <span style={{ color: "#d4a35f", fontWeight: 700 }}>{d.detector}</span>
            <span>active: <b style={{ color: d.active > 0 ? "#5fd4a4" : "#8a95b8" }}>{d.active}</b></span>
            <span>provisional: <b style={{ color: d.provisional > 0 ? "#d4a35f" : "#8a95b8" }}>{d.provisional}</b></span>
            <span>rejected: <b>{total}</b></span>
            {sorted.length > 0 && (
              <span style={{ color: "#6b7390" }}>
                ({sorted.map(([reason, n]) => `${reason}:${n}`).join(" · ")})
              </span>
            )}
          </div>
        );
      })}
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

function buyLabel(settings: { realTrading: { contractFamily: string; multiplier: number; durationTicks: number } } | null) {
  if (!settings) return "";
  return settings.realTrading.contractFamily === "MULTIPLIER"
    ? `${settings.realTrading.multiplier}×`
    : `${settings.realTrading.durationTicks}t`;
}

function RegimePill({ regime }: { regime: { adx: number; direction: string; trending: boolean; threshold: number } }) {
  const arrow = regime.direction === "up" ? "↑" : regime.direction === "down" ? "↓" : "→";
  const color = !regime.trending
    ? "#d4a35f"
    : regime.direction === "up" ? "#5fd4a4"
    : regime.direction === "down" ? "#e05f8a"
    : "#8a95b8";
  const label = regime.trending
    ? `Trending ${arrow}`
    : `Ranging — signals suppressed`;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 6,
      padding: "3px 9px", borderRadius: 12,
      background: regime.trending ? "#0e1528" : "#2e1e0e",
      border: `1px solid ${color}`,
      color, fontWeight: 600, fontSize: 11,
    }}>
      ADX {regime.adx.toFixed(1)} · {label}
    </span>
  );
}

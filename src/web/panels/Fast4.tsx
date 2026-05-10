// Fast4 sandbox panel — Fast3 + opposite-side probe circuit breaker.
//
// Fast4 mirrors Fast3 (DIGITODD tick-level book) but adds:
//   probeEnabled        — master switch
//   lossStreakTrigger   — N base-side losses required to fire the probe (default 3)
//   probePattern        — named recipe for the probe phase (e.g. EBEBE, WX-OPP-10)
//   hardCap             — ladder freeze level (0 = disabled)
//
// The recent-trades table shows ODD/EVEN per row plus a PROBE tag so the
// operator can spot when a probe phase fired.

import React, { useEffect, useState } from "react";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type Fast4Config, type Fast4PaperResp, type FastMartingaleSnapshot, type RealTrade, type StateResp, type StrategyStats } from "../api";
import { validateProbePattern as validatePatternFn } from "../../main/engine/fast4-patterns";

const MART_MULT_OPTIONS = [1.3, 1.5, 1.7, 2.0, 2.2];
const DERIV_MIN_STAKE = 0.35;
const DERIV_MAX_STAKE = 2000;

// Probe-pattern dropdown options. Mirror the registry in
// src/main/engine/fast4-patterns.ts. Grouped by family for readability.
const PROBE_PATTERN_GROUPS: Array<{ label: string; options: string[] }> = [
  { label: "Disabled",        options: ["OFF"] },
  { label: "Fixed (length 2)", options: ["EE", "EO"] },
  { label: "Fixed (length 3)", options: ["EOE", "EEE"] },
  { label: "Fixed (length 4)", options: ["EEEE", "EOEO"] },
  { label: "Fixed (length 5)", options: ["EBEBE", "EEEEE", "EOEOE"] },
  { label: "Fixed (length 6)", options: ["EEEEEE", "EOEOEO", "EOOEEO", "EOEEOE", "EEEOE", "EOOOEE"] },
  { label: "Fixed (length 7+)", options: ["EEEEEEE", "EOEOEOE"] },
  { label: "Win-exit (until win or maxTrades)", options: ["WX-OPP-3", "WX-OPP-5", "WX-OPP-7", "WX-OPP-10", "WX-OPP-15", "WX-ALT-5", "WX-ALT-10"] },
];

export function Fast4Panel({ state, doAction, pending }: {
  state: StateResp | null;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const [paper, setPaper] = useState<Fast4PaperResp | null>(null);
  const [paperTrades, setPaperTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [martingale, setMartingale] = useState<Record<string, FastMartingaleSnapshot>>({});
  const [liveTrades, setLiveTrades] = useState<RealTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resetTo, setResetTo] = useState<string>("41");
  const [pendingCfg, setPendingCfg] = useState<Fast4Config | null>(null);
  const [addingCustom, setAddingCustom] = useState<boolean>(false);
  const [customDraft, setCustomDraft] = useState<string>("");
  const [showManage, setShowManage] = useState<boolean>(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s, rt] = await Promise.all([
          api.fast4Paper(), api.fast4PaperTrades(100), api.fast4PaperEquity(), api.fast4Strategies(), api.trades(100, "fast4"),
        ]);
        setPaper(p);
        setPaperTrades(t.trades);
        setEquity(e.equity);
        setStrategies(s.strategies);
        setMartingale(s.martingale);
        setLiveTrades(rt.trades.filter((rec) => rec.sandbox === "fast4"));
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
  const probeState = paper.probeState ?? {};
  const dirty = pendingCfg !== null && (
    pendingCfg.martingaleMultiplier !== paper.config.martingaleMultiplier ||
    pendingCfg.baseStake !== paper.config.baseStake ||
    pendingCfg.maxLevels !== paper.config.maxLevels ||
    pendingCfg.perTradeCap !== paper.config.perTradeCap ||
    pendingCfg.sideFilter !== paper.config.sideFilter ||
    pendingCfg.martingaleMode !== paper.config.martingaleMode ||
    pendingCfg.liveTradingEnabled !== paper.config.liveTradingEnabled ||
    (pendingCfg.martingaleDecay ?? 1) !== (paper.config.martingaleDecay ?? 1) ||
    pendingCfg.probeEnabled !== paper.config.probeEnabled ||
    pendingCfg.lossStreakTrigger !== paper.config.lossStreakTrigger ||
    (pendingCfg.probePattern ?? "EBEBE") !== (paper.config.probePattern ?? "EBEBE") ||
    (pendingCfg.hardCap ?? 0) !== (paper.config.hardCap ?? 0) ||
    JSON.stringify(pendingCfg.customPatterns ?? []) !== JSON.stringify(paper.config.customPatterns ?? [])
  );

  const stats = (paper.stats ?? {}) as Partial<{ balance: number; startingBalance: number; totalPnl: number; pnlPct: number; trades: number; wins: number; losses: number; winRate: number; avgR: number; peak: number; ddPct: number; open: number }>;
  const liveClosed = liveTrades.filter((t) => t.closedAt != null);
  const liveOpen = liveTrades.filter((t) => t.closedAt == null);
  const liveOpenCount = liveOpen.length;
  const liveOpenUnrealized = liveOpen.reduce((acc, t) => acc + (t.currentProfit ?? 0), 0);
  const liveWins = liveClosed.filter((t) => (t.profit ?? 0) > 0).length;
  const liveLosses = liveClosed.length - liveWins;
  const liveTotalPnl = liveClosed.reduce((acc, t) => acc + (t.profit ?? 0), 0);
  const accountBalance = state?.account?.balance ?? 0;
  const accountLogin = state?.account?.loginid ?? "—";
  const paperBalance = paper.balance ?? 0;
  const paperStartingBalance = paper.startingBalance ?? 0;
  const view = isLive
    ? {
        balance: accountBalance,
        balanceSub: `Deriv · ${accountLogin}`,
        balanceTone: (accountBalance > 0 ? "pos" : "muted") as "pos" | "neg" | "muted",
        totalPnl: liveTotalPnl,
        totalPnlSub: `${liveClosed.length} live trades · ${liveOpenCount} open`,
        wr: liveClosed.length > 0 ? liveWins / liveClosed.length : 0,
        wrSub: `${liveWins}W / ${liveLosses}L · ${liveClosed.length} bets`,
        wrTrades: liveClosed.length,
        peak: 0,
        peakSub: "live peak — see logs",
        ddPct: 0,
      }
    : {
        balance: paperBalance,
        balanceSub: `paper · started at $${paperStartingBalance.toFixed(2)}`,
        balanceTone: (paperBalance >= paperStartingBalance ? "pos" : "neg") as "pos" | "neg" | "muted",
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
    doAction("update fast4 config", () => api.updateFast4Config(pendingCfg).then(() => setPendingCfg(null)));
  };
  const setCfg = (patch: Partial<Fast4Config>) => setPendingCfg({ ...cfg, ...patch });

  // Aggregate probe stats for the header banner.
  const totalProbesFired = Object.values(probeState).reduce((acc, p) => acc + p.probesFired, 0);
  const stratsCurrentlyProbing = Object.entries(probeState).filter(([, p]) => p.probeRemaining > 0).length;

  return (
    <>
      {isLive && (
        <div className="banner banner-danger" style={{ marginBottom: 12, fontWeight: 600 }}>
          🔴 LIVE TRADING ACTIVE — Fast4 fires real DIGITODD/EVEN contracts on Deriv ({accountLogin}). Probe logic active: after {cfg.lossStreakTrigger} consecutive base-side losses, fires probe pattern <strong>{cfg.probePattern || "EBEBE"}</strong>.
        </div>
      )}
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Fast4 Sandbox</strong> — independent copy of Fast3 with a configurable probe-pattern circuit breaker.
        After <strong>{cfg.lossStreakTrigger}</strong> consecutive base-side losses, the bot fires the probe pattern <strong>{cfg.probePattern || "EBEBE"}</strong>.
        The martingale ladder continues through every trade; in-phase trades do NOT count toward the streak counter.
        Currently <strong>{cfg.probeEnabled ? "ENABLED" : "DISABLED"}</strong>.
        {(cfg.hardCap ?? 0) > 0 && <> · ladder freeze at <strong>L{cfg.hardCap}</strong></>}
        {totalProbesFired > 0 && <> · <span className="mono">{totalProbesFired}</span> probe phase{totalProbesFired === 1 ? "" : "s"} fired so far</>}
        {stratsCurrentlyProbing > 0 && <> · <span className="pos">{stratsCurrentlyProbing} strategy{stratsCurrentlyProbing === 1 ? "" : "ies"} currently in probe phase</span></>}
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Card title={isLive ? "Live Balance" : "Paper Balance"} value={`$${view.balance.toFixed(2)}`} sub={view.balanceSub} tone={view.balanceTone} />
        <Card title={isLive ? "Live P&L" : "Total P&L"} value={`${view.totalPnl >= 0 ? "+" : ""}$${view.totalPnl.toFixed(2)}`} sub={view.totalPnlSub} tone={view.totalPnl > 0 ? "pos" : view.totalPnl < 0 ? "neg" : "muted"} />
        <Card title="Win Rate" value={view.wrTrades > 0 ? `${(view.wr * 100).toFixed(1)}%` : "—"} sub={view.wrSub} tone={view.wr >= 0.55 ? "pos" : view.wrTrades > 50 ? "neg" : "muted"} />
        <Card title="Probes Fired" value={String(totalProbesFired)} sub={`${stratsCurrentlyProbing} active now`} tone={stratsCurrentlyProbing > 0 ? "pos" : "muted"} />
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
            onClick={() => doAction(`Set Fast4 paper balance to $${resetTo}? Wipes trades, ladders, probe state.`, () => api.resetFast4Paper(Number(resetTo)))}
          >
            {pending ? "…" : "Set & Restart Sandbox"}
          </button>
          <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>
            Default $41 (matches Fast3 — for direct A/B comparison).
          </span>
        </div>
      )}

      <h3 className="section-title">Configuration</h3>
      <div className="card" style={{ marginBottom: 16, padding: 16 }}>
        <div className="grid grid-3" style={{ gap: 12, marginBottom: 12 }}>
          <ConfigField label="Probe Enabled (master switch)">
            <select className="filter-select" value={String(cfg.probeEnabled)} onChange={(e) => setCfg({ probeEnabled: e.target.value === "true" })}>
              <option value="true">ON — probe after streak</option>
              <option value="false">OFF — behaves like Fast3</option>
            </select>
          </ConfigField>
          <ConfigField label="Loss Streak Trigger (consec base losses → probe)">
            <input
              className="filter-input"
              type="number"
              step="1"
              min={1}
              max={20}
              value={cfg.lossStreakTrigger}
              onChange={(e) => setCfg({ lossStreakTrigger: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
              title="After this many consecutive base-side losses, the configured probe pattern fires. Default 3."
            />
          </ConfigField>
          <ConfigField label="Probe Pattern (the recipe to fire when triggered)">
            <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
              <select
                className="filter-select"
                style={{ flex: 1 }}
                value={cfg.probePattern || "EBEBE"}
                onChange={(e) => {
                  if (e.target.value === "__ADD_CUSTOM__") {
                    setAddingCustom(true);
                    setCustomDraft("");
                    return;
                  }
                  setCfg({ probePattern: e.target.value });
                }}
                title="Named probe pattern. E = opposite digit, O/B = base digit. WX-OPP-N = keep firing opposite until win or N trades. WX-ALT-N = alternate."
              >
                {PROBE_PATTERN_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </optgroup>
                ))}
                {(cfg.customPatterns ?? []).length > 0 && (
                  <optgroup label="My Customs">
                    {(cfg.customPatterns ?? []).map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Custom">
                  <option value="__ADD_CUSTOM__">+ Add custom…</option>
                </optgroup>
              </select>
              {(cfg.customPatterns ?? []).length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ padding: "0 8px" }}
                  onClick={() => setShowManage(true)}
                  title="Manage saved custom patterns"
                >
                  ⋯
                </button>
              )}
            </div>
            {addingCustom && (() => {
              const draft = customDraft.toUpperCase();
              const v = validatePatternFn(draft);
              const isDuplicate = (cfg.customPatterns ?? []).includes(draft);
              const canSave = v.valid && !isDuplicate;
              const reason = v.valid
                ? (isDuplicate ? "already saved" : "")
                : (v as { valid: false; reason: string }).reason;
              const onSave = () => {
                const next = [...(cfg.customPatterns ?? []), draft];
                setCfg({ customPatterns: next, probePattern: draft });
                setAddingCustom(false);
                setCustomDraft("");
              };
              return (
                <div style={{ marginTop: 6, display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    className="filter-input"
                    style={{
                      flex: 1,
                      borderColor: draft.length === 0 ? undefined : (canSave ? "#3a8" : "#a33"),
                    }}
                    value={draft}
                    autoFocus
                    placeholder="e.g. EOOEEEOO or WX-OPP-25"
                    onChange={(e) => setCustomDraft(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSave) onSave();
                      if (e.key === "Escape") { setAddingCustom(false); setCustomDraft(""); }
                    }}
                  />
                  <button type="button" className="btn btn-primary btn-sm" disabled={!canSave} onClick={onSave}>save</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setAddingCustom(false); setCustomDraft(""); }}>cancel</button>
                  {draft.length > 0 && reason && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>{reason}</span>
                  )}
                </div>
              );
            })()}
          </ConfigField>
          <ConfigField label="Hard Cap (ladder freeze level, 0 = disabled)">
            <input
              className="filter-input"
              type="number"
              step="1"
              min={0}
              max={20}
              value={cfg.hardCap ?? 0}
              onChange={(e) => setCfg({ hardCap: Math.max(0, Math.round(Number(e.target.value) || 0)) })}
              title="When the ladder would advance past this level, FREEZE at the cap level instead of advancing. Each subsequent loss stays at cap stake. A win still triggers the natural mart W→L0 reset. 0 = disabled (no cap)."
            />
          </ConfigField>
          <ConfigField label="Martingale Multiplier">
            <select className="filter-select" value={cfg.martingaleMultiplier} onChange={(e) => setCfg({ martingaleMultiplier: Number(e.target.value) })}>
              {MART_MULT_OPTIONS.map((m) => <option key={m} value={m}>{m.toFixed(1)}×</option>)}
            </select>
          </ConfigField>
          <ConfigField label={`Base Stake — Deriv min $${DERIV_MIN_STAKE}`}>
            <input className="filter-input" type="number" step="0.05" min={DERIV_MIN_STAKE} max={DERIV_MAX_STAKE} value={cfg.baseStake} onChange={(e) => setCfg({ baseStake: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Max Ladder Levels (depth)">
            <input className="filter-input" type="number" step="1" min={1} max={10} value={cfg.maxLevels} onChange={(e) => setCfg({ maxLevels: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Multiplier Decay (1 = off)">
            <input
              className="filter-input"
              type="number"
              step="0.05"
              min={0.1}
              max={1}
              value={cfg.martingaleDecay ?? 1}
              onChange={(e) => setCfg({ martingaleDecay: Number(e.target.value) || 1 })}
            />
          </ConfigField>
          <ConfigField label={`Per-Trade Cap ($) — Deriv DIGIT max ~$50`}>
            <input className="filter-input" type="number" step="1" min={DERIV_MIN_STAKE} max={DERIV_MAX_STAKE} value={cfg.perTradeCap} onChange={(e) => setCfg({ perTradeCap: Number(e.target.value) })} />
          </ConfigField>
          <ConfigField label="Martingale Mode">
            <select className="filter-select" value={cfg.martingaleMode} onChange={(e) => setCfg({ martingaleMode: e.target.value as "classic" | "anti" })}>
              <option value="classic">classic (escalate on loss)</option>
              <option value="anti">anti / Paroli (escalate on win)</option>
            </select>
          </ConfigField>
          <ConfigField label="Live Trading">
            <select className="filter-select" value={String(cfg.liveTradingEnabled)} onChange={(e) => setCfg({ liveTradingEnabled: e.target.value === "true" })}>
              <option value="false">PAPER (sandbox sim)</option>
              <option value="true">LIVE (real DIGITODD/EVEN on Deriv)</option>
            </select>
          </ConfigField>
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary btn-sm" disabled={!dirty || pending !== null} onClick={() => setPendingCfg(null)}>cancel</button>
          <button className="btn btn-primary btn-sm" disabled={!dirty || pending !== null} onClick={applyCfg}>apply</button>
        </div>
      </div>

      {showManage && (
        <div
          style={{
            position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)",
            display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50,
          }}
          onClick={() => setShowManage(false)}
        >
          <div
            className="card"
            style={{ minWidth: 360, maxWidth: 480, padding: 16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 style={{ marginTop: 0, marginBottom: 12 }}>Manage Custom Patterns</h4>
            {(cfg.customPatterns ?? []).length === 0 ? (
              <div className="muted">No custom patterns saved.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(cfg.customPatterns ?? []).map((pat) => (
                  <div key={pat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ flex: 1 }}>{pat}</span>
                    <button
                      type="button"
                      className="btn btn-warn btn-sm"
                      onClick={() => {
                        const next = (cfg.customPatterns ?? []).filter((p) => p !== pat);
                        const patch: Partial<Fast4Config> = { customPatterns: next };
                        if (cfg.probePattern === pat) patch.probePattern = "EBEBE";
                        setCfg(patch);
                      }}
                      title="Delete this custom pattern"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowManage(false)}>close</button>
            </div>
          </div>
        </div>
      )}

      <h3 className="section-title">Per-Strategy</h3>
      <div className="card-sub" style={{ marginBottom: 6, fontSize: 11, padding: "0 4px" }}>
        Streak / Probe columns surface the live state of the probe circuit per strategy.
      </div>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Active</th><th>Strategy</th><th>Symbol</th><th>Bets</th><th>W/L</th><th>WR</th><th>$ net</th><th>Ladder</th><th>Streak</th><th>Probe</th><th>Last bet</th>
            </tr>
          </thead>
          <tbody>
            {strategies.map((s) => {
              const ov = (paper.config.perStrategy ?? {})[s.id] ?? {};
              const isOff = ov.enabled === false;
              const m = martingale[s.id];
              const ps = probeState[s.id];
              let trades: number, wins: number, losses: number, pnlUsd: number, lastTradeAt: number | null;
              if (isLive) {
                const myTrades = liveClosed.filter((t) => t.sandboxStrategyId === s.id);
                trades = myTrades.length;
                wins = myTrades.filter((t) => (t.profit ?? 0) > 0).length;
                losses = trades - wins;
                pnlUsd = myTrades.reduce((acc, t) => acc + (t.profit ?? 0), 0);
                lastTradeAt = myTrades.length > 0 ? Math.max(...myTrades.map((t) => t.closedAt ?? 0)) : null;
              } else {
                trades = s.live.trades ?? 0;
                wins = s.live.wins ?? 0;
                losses = s.live.losses ?? 0;
                pnlUsd = s.live.pnlUsd ?? 0;
                lastTradeAt = s.live.lastTradeAt ?? null;
              }
              const wr = trades > 0 ? wins / trades : 0;
              const inProbe = (ps?.probeRemaining ?? 0) > 0;
              return (
                <tr key={s.id} style={{ opacity: isOff ? 0.45 : 1, background: inProbe ? "rgba(255, 153, 0, 0.07)" : undefined }}>
                  <td>
                    <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input type="checkbox" checked={!isOff} onChange={(e) => api.updateFast4StrategyConfig(s.id, { enabled: e.target.checked })} />
                      <span className={`mono ${isOff ? "neg" : "pos"}`} style={{ fontSize: 11 }}>{isOff ? "OFF" : "ON"}</span>
                    </label>
                  </td>
                  <td>
                    <div className="bold" style={{ fontSize: 12 }}>{s.id}</div>
                    <div className="muted" style={{ fontSize: 10 }}>{s.name}</div>
                  </td>
                  <td className="mono">{s.symbols.join(", ")}</td>
                  <td className="mono">{trades}</td>
                  <td className="mono">{trades > 0 ? `${wins}W/${losses}L` : "—"}</td>
                  <td className="mono">{trades > 0 ? `${(wr * 100).toFixed(1)}%` : "—"}</td>
                  <td className={`mono ${pnlUsd > 0 ? "pos" : pnlUsd < 0 ? "neg" : "muted"}`}>{pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {m ? <>L{m.level ?? 0} · next ${(m.nextStake ?? 0).toFixed(2)}</> : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {ps ? `${ps.baseLossStreak}/${cfg.lossStreakTrigger}` : "—"}
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {inProbe
                      ? <span className="pos">PROBE {ps!.probeRemaining} left</span>
                      : ps && ps.probesFired > 0
                        ? <span className="muted">{ps.probesFired} fired</span>
                        : "—"}
                  </td>
                  <td className="faint" style={{ fontSize: 11 }}>{lastTradeAt ? fmtTime(lastTradeAt) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isLive && liveOpen.length > 0 && (
        <>
          <h3 className="section-title">Open Positions ({liveOpenCount}) · live unrealized {liveOpenUnrealized >= 0 ? "+" : ""}${liveOpenUnrealized.toFixed(2)}</h3>
          <div className="card table-card" style={{ marginBottom: 16 }}>
            <table>
              <thead>
                <tr><th>Opened</th><th>Symbol</th><th>Strategy</th><th>Side</th><th>Stake</th><th>Live P&amp;L</th><th>Age</th></tr>
              </thead>
              <tbody>
                {liveOpen.map((t) => {
                  const cp = t.currentProfit ?? null;
                  const ageSec = Math.floor((Date.now() - t.openedAt) / 1000);
                  return (
                    <tr key={t.id}>
                      <td className="mono faint">{fmtTime(t.openedAt)}</td>
                      <td className="mono">{t.symbol}</td>
                      <td className="faint" style={{ fontSize: 11 }}>{t.sandboxStrategyId ?? "—"}</td>
                      <td className="mono" style={{ fontSize: 11 }}>{(t.contractType ?? "").replace("DIGIT", "") || "—"}</td>
                      <td className="mono">${t.stake.toFixed(2)}</td>
                      <td className={`mono ${cp != null && cp > 0 ? "pos" : cp != null && cp < 0 ? "neg" : "muted"}`}>
                        {cp != null ? `${cp >= 0 ? "+" : ""}$${cp.toFixed(2)}` : "…"}
                      </td>
                      <td className="faint">{ageSec < 60 ? `${ageSec}s` : `${Math.floor(ageSec / 60)}m`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="section-title">Recent {isLive ? "Live" : "Paper"} Trades ({isLive ? liveClosed.length : paperTrades.length})</h3>
      <div className="card table-card">
        {(isLive ? liveClosed.length : paperTrades.length) === 0 ? (
          <div className="empty"><span className="empty-emoji">🔬</span>No {isLive ? "live" : "paper"} trades yet — Fast4 awaiting tick stream.</div>
        ) : (
          <table className="trades-table">
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th>Strategy</th><th>Side</th><th>Phase</th><th style={{ textAlign: "right" }}>Stake</th><th>Result</th><th style={{ textAlign: "right" }}>P&L</th>{isLive && <th style={{ textAlign: "right" }}>Contract</th>}</tr>
            </thead>
            <tbody>
              {isLive
                ? liveClosed.slice(0, 100).map((t) => {
                    const pnl = t.profit ?? 0;
                    const sideShort = (t.contractType ?? "").replace("DIGIT", "") || "—";
                    return (
                      <tr key={t.id}>
                        <td>{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                        <td>{t.symbol}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{t.sandboxStrategyId ?? "—"}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{sideShort}</td>
                        <td className="muted" style={{ fontSize: 11 }}>—</td>
                        <td className="mono" style={{ textAlign: "right" }}>${(t.stake ?? 0).toFixed(2)}</td>
                        <td className={pnl > 0 ? "pos" : "neg"}>{pnl > 0 ? "WIN" : "LOSS"}</td>
                        <td className={`mono ${pnl > 0 ? "pos" : "neg"}`} style={{ textAlign: "right" }}>{pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</td>
                        <td style={{ textAlign: "right", fontSize: 11 }} className="muted">{t.contractId ?? "—"}</td>
                      </tr>
                    );
                  })
                : paperTrades.slice(0, 100).map((t) => {
                    const inPhase = t.phaseKind === "probe" || t.phaseKind === "interleave";
                    const bg = t.phaseKind === "probe"
                      ? "rgba(255, 153, 0, 0.10)"
                      : t.phaseKind === "interleave"
                        ? "rgba(255, 200, 0, 0.05)"
                        : undefined;
                    const phaseLabel = t.phaseKind === "probe" ? <span className="pos">PROBE</span>
                      : t.phaseKind === "interleave" ? <span style={{ color: "#cc9900" }}>interleave</span>
                      : t.phaseKind === "exit" ? <span className="muted">resume</span>
                      : <span className="muted">base</span>;
                    return (
                      <tr key={t.id} style={{ background: bg }}>
                        <td>{fmtTime(t.closedAt)}</td>
                        <td>{t.symbol}</td>
                        <td className="muted" style={{ fontSize: 11 }}>—</td>
                        <td className="mono" style={{ fontSize: 11 }}>{t.digitSide ? t.digitSide.replace("DIGIT", "") : "—"}</td>
                        <td className="mono" style={{ fontSize: 11 }}>{phaseLabel}</td>
                        <td className="mono" style={{ textAlign: "right" }}>${(t.stake ?? 0).toFixed(2)}</td>
                        <td className={t.pnl > 0 ? "pos" : "neg"}>{t.pnl > 0 ? "WIN" : "LOSS"}</td>
                        <td className={`mono ${t.pnl > 0 ? "pos" : "neg"}`} style={{ textAlign: "right" }}>{t.pnl >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2)}</td>
                      </tr>
                    );
                  })}
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

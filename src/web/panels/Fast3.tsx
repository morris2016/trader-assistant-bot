// Fast3 sandbox panel — DIGITODD tick-level book on synthetic indices.
// Mirrors Fast2 layout closely: KPI cards, configuration grid, per-strategy
// overrides table, recent trades. The contract type is binary 1-tick
// (DIGITODD) so there's no SL/TP geometry or trade multiplier in play.

import React, { useEffect, useState } from "react";
import { api, fmtTime, type ClosedPaperPosition, type EquityPoint, type Fast3Config, type Fast3PaperResp, type FastMartingaleSnapshot, type RealTrade, type StateResp, type StrategyStats } from "../api";

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
  const [liveTrades, setLiveTrades] = useState<RealTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resetTo, setResetTo] = useState<string>("41");
  const [pendingCfg, setPendingCfg] = useState<Fast3Config | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [p, t, e, s, rt] = await Promise.all([
          api.fast3Paper(), api.fast3PaperTrades(100), api.fast3PaperEquity(), api.fast3Strategies(), api.trades(100, "fast3"),
        ]);
        setPaper(p);
        setPaperTrades(t.trades);
        setEquity(e.equity);
        setStrategies(s.strategies);
        setMartingale(s.martingale);
        setLiveTrades(rt.trades.filter((rec) => rec.sandbox === "fast3"));
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

  // ── Mode-aware view: LIVE reads Deriv account balance + real trades
  // tagged sandbox="fast3"; PAPER reads from the paper engine state.
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
    doAction("update fast3 config", () => api.updateFast3Config(pendingCfg).then(() => setPendingCfg(null)));
  };
  const setCfg = (patch: Partial<Fast3Config>) => setPendingCfg({ ...cfg, ...patch });

  // ── Per-strategy rater ──
  // Score (0-100) blends three signals the operator cares about:
  //   - WR vs DIGIT-style breakeven (~50%): 45 pts
  //   - $/bet (the actual edge after Deriv's house cut): 35 pts
  //   - Bust safety (martingale ladder reaching maxLevels): 20 pts
  // Letter grade falls out of score AND requires safety floors:
  //   A — score ≥85 AND 0 busts AND positive $ net
  //   B — score ≥70 AND positive $ net
  //   C — score ≥50
  //   D — score ≥30
  //   F — anything lower
  // Strategies with <30 closed bets get "—" instead of a grade — sample is
  // too small to judge consistency and would mislead the sort.
  type Rating = { grade: "A" | "B" | "C" | "D" | "F" | "—"; score: number; reason: string };
  function rate(trades: number, wr: number, pnlUsd: number, busts: number): Rating {
    if (trades < 30) return { grade: "—", score: -1, reason: `${trades}/30 bets — sample too small to grade` };
    let pts = 0;
    if (wr >= 0.55) pts += 45;
    else if (wr >= 0.52) pts += 30;
    else if (wr >= 0.50) pts += 15;
    const pnlPerBet = pnlUsd / trades;
    if (pnlPerBet >= 0.05) pts += 35;
    else if (pnlPerBet >= 0.02) pts += 25;
    else if (pnlPerBet > 0) pts += 15;
    else if (pnlPerBet > -0.02) pts += 5;
    if (busts === 0) pts += 20;
    else if (busts === 1) pts += 10;
    let grade: Rating["grade"] = "F";
    if (pts >= 85 && busts === 0 && pnlUsd > 0) grade = "A";
    else if (pts >= 70 && pnlUsd > 0) grade = "B";
    else if (pts >= 50) grade = "C";
    else if (pts >= 30) grade = "D";
    return { grade, score: pts, reason: `WR=${(wr * 100).toFixed(1)}% · $/bet=${pnlPerBet >= 0 ? "+" : ""}${pnlPerBet.toFixed(3)} · busts=${busts}` };
  }

  type SortKey = "rating" | "pnl" | "wr" | "trades" | "default";
  type RatingFilter = "all" | "enabled" | "A_or_B" | "positive" | "zero_busts";
  const [sortBy, setSortBy] = useState<SortKey>("rating");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");

  const enrichedStrategies = strategies.map((s) => {
    const ov = (paper.config.perStrategy ?? {})[s.id] ?? {};
    const isOff = ov.enabled === false;
    const m = martingale[s.id];
    const busts = m?.circuitBreakers ?? 0;
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
    const rating = rate(trades, wr, pnlUsd, busts);
    return { s, trades, wins, losses, pnlUsd, lastTradeAt, wr, busts, rating, isOff, m };
  });

  const filteredStrategies = enrichedStrategies.filter(({ isOff, rating, pnlUsd, busts }) => {
    if (ratingFilter === "enabled") return !isOff;
    if (ratingFilter === "A_or_B") return rating.grade === "A" || rating.grade === "B";
    if (ratingFilter === "positive") return pnlUsd > 0;
    if (ratingFilter === "zero_busts") return busts === 0;
    return true;
  });

  const sortedStrategies = [...filteredStrategies].sort((a, b) => {
    if (sortBy === "default") return 0;
    if (sortBy === "rating") return b.rating.score - a.rating.score;
    if (sortBy === "pnl") return b.pnlUsd - a.pnlUsd;
    if (sortBy === "wr") return b.wr - a.wr;
    if (sortBy === "trades") return b.trades - a.trades;
    return 0;
  });

  return (
    <>
      {isLive && (
        <div className="banner banner-danger" style={{ marginBottom: 12, fontWeight: 600 }}>
          🔴 LIVE TRADING ACTIVE — every tick fires a real DIGITODD contract on Deriv ({accountLogin}). KPI cards now show your Deriv account balance + live-trade stats, not paper. Per-strategy table below shows live ladder state. Flip OFF to switch back to paper sim.
        </div>
      )}
      <div className="banner" style={{ marginBottom: 12 }}>
        <strong>Fast3 Sandbox</strong> — DIGITODD tick-level book on Deriv synthetic indices.
        Each tick = one binary 1-tick contract (predict next tick's last digit is ODD).
        Edge is structural: synthetic RNG never produces digit 0, so digits 1-9 are uniform → P(odd) = 5/9 = 55.5%.
        Deriv pays 1.95× as if it were a fair coin → ~5%/tick edge.
        Currently running at <strong>base ${cfg.baseStake.toFixed(2)} · martingale {cfg.martingaleMultiplier.toFixed(1)}× · depth {cfg.maxLevels}</strong> on a ${paperStartingBalance.toFixed(0)} starting balance.
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
              <option value="false">PAPER (sandbox sim)</option>
              <option value="true">LIVE (real DIGITODD on Deriv)</option>
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
        Toggle the ON/OFF checkbox to silence a strategy without removing it from the registry. The Rating column scores each strategy on WR, $ net per bet, and martingale busts (≥30 bets needed before a grade is shown). Sort by Rating to surface the consistent ones.
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, fontSize: 11 }}>
        <span className="muted">Sort by:</span>
        <select className="filter-select" value={sortBy} onChange={(e) => setSortBy(e.target.value as SortKey)}>
          <option value="rating">Rating (best first)</option>
          <option value="pnl">$ net (best first)</option>
          <option value="wr">WR (best first)</option>
          <option value="trades">Bets (most first)</option>
          <option value="default">Registry order</option>
        </select>
        <span className="muted" style={{ marginLeft: 8 }}>Filter:</span>
        <select className="filter-select" value={ratingFilter} onChange={(e) => setRatingFilter(e.target.value as RatingFilter)}>
          <option value="all">All ({strategies.length})</option>
          <option value="enabled">Active only</option>
          <option value="A_or_B">A or B only</option>
          <option value="positive">Positive $ only</option>
          <option value="zero_busts">0 busts only</option>
        </select>
      </div>
      <div className="card table-card" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th>Active</th><th>Rating</th><th>Strategy</th><th>Symbol</th><th>Bets</th><th>W/L</th><th>WR</th><th>$ net</th><th>$/bet</th><th>Busts</th><th>Ladder</th><th>Last bet</th>
            </tr>
          </thead>
          <tbody>
            {sortedStrategies.map(({ s, trades, wins, losses, pnlUsd, lastTradeAt, wr, busts, rating, isOff, m }) => {
              const gradeClass =
                rating.grade === "A" ? "pill-green" :
                rating.grade === "B" ? "pill-blue" :
                rating.grade === "C" ? "pill-amber" :
                rating.grade === "D" ? "pill-amber" :
                rating.grade === "F" ? "pill-red" : "";
              return (
                <tr key={s.id} style={{ opacity: isOff ? 0.45 : 1 }}>
                  <td>
                    <label style={{ cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }} title="Toggle this strategy on/off">
                      <input type="checkbox" checked={!isOff} onChange={(e) => api.updateFast3StrategyConfig(s.id, { enabled: e.target.checked })} />
                      <span className={`mono ${isOff ? "neg" : "pos"}`} style={{ fontSize: 11 }}>{isOff ? "OFF" : "ON"}</span>
                    </label>
                  </td>
                  <td>
                    <span className={`pill ${gradeClass}`} style={{ minWidth: 22, justifyContent: "center", fontWeight: 700 }} title={`score=${rating.score} · ${rating.reason}`}>{rating.grade}</span>
                    {rating.grade !== "—" && <div className="faint mono" style={{ fontSize: 10, marginTop: 2 }}>{rating.score}/100</div>}
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
                  <td className={`mono ${trades > 0 && pnlUsd / trades > 0 ? "pos" : trades > 0 && pnlUsd / trades < 0 ? "neg" : "muted"}`}>{trades > 0 ? `${pnlUsd / trades >= 0 ? "+" : ""}${(pnlUsd / trades).toFixed(3)}` : "—"}</td>
                  <td className={`mono ${busts === 0 ? "muted" : "neg"}`} style={{ fontSize: 11 }}>{busts}</td>
                  <td className="muted" style={{ fontSize: 11 }}>
                    {m ? <>L{m.level ?? 0} · next ${(m.nextStake ?? 0).toFixed(2)}</> : "—"}
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
                <tr><th>Opened</th><th>Symbol</th><th>Strategy</th><th>Stake</th><th>Live P&amp;L</th><th>Age</th></tr>
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
          <div className="empty"><span className="empty-emoji">🎯</span>No {isLive ? "live" : "paper"} trades yet — Fast3 is awaiting tick stream. The bot subscribes to ticks for {strategies.length} symbols on startup; trades will appear as ticks arrive.</div>
        ) : (
          <table className="trades-table">
            <thead>
              <tr><th>Closed</th><th>Symbol</th><th>Strategy</th><th style={{ textAlign: "right" }}>Stake</th><th>Result</th><th style={{ textAlign: "right" }}>P&L</th>{isLive && <th style={{ textAlign: "right" }}>Contract</th>}</tr>
            </thead>
            <tbody>
              {isLive
                ? liveClosed.slice(0, 100).map((t) => {
                    const pnl = t.profit ?? 0;
                    return (
                      <tr key={t.id}>
                        <td>{t.closedAt ? fmtTime(t.closedAt) : "—"}</td>
                        <td>{t.symbol}</td>
                        <td className="muted" style={{ fontSize: 11 }}>{t.sandboxStrategyId ?? "—"}</td>
                        <td className="mono" style={{ textAlign: "right" }}>${(t.stake ?? 0).toFixed(2)}</td>
                        <td className={pnl > 0 ? "pos" : "neg"}>{pnl > 0 ? "WIN" : "LOSS"}</td>
                        <td className={`mono ${pnl > 0 ? "pos" : "neg"}`} style={{ textAlign: "right" }}>{pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}</td>
                        <td style={{ textAlign: "right", fontSize: 11 }} className="muted">{t.contractId ?? "—"}</td>
                      </tr>
                    );
                  })
                : paperTrades.slice(0, 100).map((t) => (
                    <tr key={t.id}>
                      <td>{fmtTime(t.closedAt)}</td>
                      <td>{t.symbol}</td>
                      <td className="muted" style={{ fontSize: 11 }}>—</td>
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

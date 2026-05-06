import React, { useEffect, useState, useCallback } from "react";
import { api, fmtUptime, type StateResp, type StrategyStats, type Subscription } from "./api";
import { OverviewPanel } from "./panels/Overview";
import { ChartsPanel } from "./panels/Charts";
import { RealPanel } from "./panels/Real";
import { AdaptivePanel } from "./panels/Adaptive";
import { SettingsPanel } from "./panels/Settings";
// Fast (sandbox 1) re-enabled 2026-05-06 — repurposed to host
// boom300n_fade_fast (1m, k=1, asym 0.3/3.0 SL/TP) with its own config
// space separate from Synth (fast2). UI label "Fade".
import { FastPanel } from "./panels/Fast";
// Synth sandbox 2026-05-04 — re-uses the fast2 sandbox infrastructure
// (paper engine, ladders, candle dispatch, live toggle) but with the
// recovered synth-strategies (boom300n drift / rdbull breakout). Internal
// sandbox tag stays "fast2"; UI is renamed "Synth".
import { Fast2Panel } from "./panels/Fast2";
import { Fast3Panel } from "./panels/Fast3";
import { LogsPanel } from "./panels/Logs";

const REFRESH_MS = 3000;

type TabId = "overview" | "charts" | "real" | "synth" | "fade" | "fast3" | "adaptive" | "logs" | "settings";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "overview",   label: "Overview",   icon: "◆" },
  { id: "charts",     label: "Charts",     icon: "📈" },
  { id: "real",       label: "Real",       icon: "$" },
  { id: "synth",      label: "Synth",      icon: "🧬" },
  { id: "fade",       label: "Fade",       icon: "💥" },
  { id: "fast3",      label: "Fast3",      icon: "🎯" },
  { id: "adaptive",   label: "Adaptive",   icon: "🛡" },
  { id: "logs",       label: "Logs",       icon: "📋" },
  { id: "settings",   label: "Settings",   icon: "⚙" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [state, setState] = useState<StateResp | null>(null);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [lastFetch, setLastFetch] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, st, su] = await Promise.all([api.state(), api.strategies(), api.subscriptions()]);
      setState(s);
      setStrategies(st.strategies);
      setSubs(su.subscriptions);
      setLastFetch(Date.now());
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const doAction = useCallback(async (label: string, fn: () => Promise<unknown>) => {
    if (!confirm(`${label}?`)) return;
    setActionPending(label);
    try {
      await fn();
      await refresh();
    } catch (e) {
      alert(`Failed: ${(e as Error).message}`);
    } finally {
      setActionPending(null);
    }
  }, [refresh]);

  const stale = Date.now() - lastFetch > REFRESH_MS * 2;

  return (
    <div className="shell">
      <Sidebar tab={tab} setTab={setTab} state={state} subs={subs} strategies={strategies} />
      <div className="main">
        <Header state={state} stale={stale} error={error} />
        {!state && !error && <SkeletonGrid />}
        {!state && error && <div className="banner banner-danger">⚠ {error}</div>}
        {state && (
          <>
            {tab === "overview"   && <OverviewPanel state={state} strategies={strategies} doAction={doAction} pending={actionPending} />}
            {tab === "charts"     && <ChartsPanel subs={subs} />}
            {tab === "real"       && <RealPanel state={state} strategies={strategies} />}
            {tab === "synth"      && <Fast2Panel state={state} doAction={doAction} pending={actionPending} />}
            {tab === "fade"       && <FastPanel state={state} doAction={doAction} pending={actionPending} />}
            {tab === "fast3"      && <Fast3Panel state={state} doAction={doAction} pending={actionPending} />}
            {tab === "adaptive"   && <AdaptivePanel state={state} doAction={doAction} pending={actionPending} />}
            {tab === "logs"       && <LogsPanel />}
            {tab === "settings"   && <SettingsPanel state={state} doAction={doAction} pending={actionPending} />}
          </>
        )}
        <Footer state={state} />
      </div>
    </div>
  );
}

function Sidebar({ tab, setTab, state, subs, strategies }: {
  tab: TabId; setTab: (t: TabId) => void;
  state: StateResp | null; subs: Subscription[]; strategies: StrategyStats[];
}) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-brand-emoji">📈</span>
        <span>Trader Bot</span>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-title">Dashboard</div>
        {TABS.map((t) => (
          <div
            key={t.id}
            className={`nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => setTab(t.id)}
          >
            <span className="nav-item-icon">{t.icon}</span>
            <span>{t.label}</span>
            {t.id === "real" && strategies.length > 0 && (
              <span className="nav-badge">{strategies.length}</span>
            )}
            {t.id === "charts" && subs.length > 0 && (
              <span className="nav-badge">{subs.length}</span>
            )}
          </div>
        ))}
      </div>
      {state && (
        <div className="sidebar-section">
          <div className="sidebar-section-title">Status</div>
          <div className="nav-item" style={{ cursor: "default" }}>
            <span className={`dot ${state.health.wsConnected && state.health.authorized ? "dot-green" : "dot-red"}`} />
            <span>{state.health.wsConnected && state.health.authorized ? "Connected" : "Disconnected"}</span>
          </div>
          <div className="nav-item" style={{ cursor: "default" }}>
            <span className={`dot ${state.paused ? "dot-amber" : "dot-green"}`} />
            <span>{state.paused ? "Paused" : "Active"}</span>
          </div>
          <div className="nav-item" style={{ cursor: "default" }}>
            <span className="nav-item-icon">⏱</span>
            <span className="muted">{fmtUptime(state.health.uptimeSec)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ state, stale, error }: { state: StateResp | null; stale: boolean; error: string | null }) {
  const live = state?.health.wsConnected && state?.health.authorized;
  const status = error ? "dead" : stale ? "stale" : live ? "live" : "stale";
  const account = state?.account;
  return (
    <>
      <div className="header">
        <div className="header-left">
          <h1>{titleForTab()}</h1>
          <div className="subtitle">
            {account ? (
              <>
                {account.loginid} · {account.currency} ${(account.balance ?? 0).toFixed(2)} · {account.isVirtual ? "DEMO" : "LIVE"}
              </>
            ) : "no account"}
          </div>
        </div>
        <div className="row">
          {state && (
            <>
              <span className={`pill ${state.paused ? "pill-amber" : "pill-green"}`}>
                <span className="pill-dot" />
                {state.paused ? "PAUSED" : "ACTIVE"}
              </span>
              <span className={`pill ${live ? "pill-green" : "pill-red"}`}>
                <span className="pill-dot" />
                {live ? "WS UP" : "WS DOWN"}
              </span>
              <span className={`refresh ${status}`}>{status === "live" ? "live" : status === "stale" ? "stale" : "down"}</span>
            </>
          )}
        </div>
      </div>
      {state && account && !account.isVirtual && account.balance != null && account.balance < 10 && (
        <div className="banner banner-warn">
          ⚠ Real account with balance ${(account.balance ?? 0).toFixed(2)} — fund the account or switch DERIV_TOKEN to a demo account before trading.
        </div>
      )}
    </>
  );
}

function titleForTab() {
  return "Dashboard";
}

function SkeletonGrid() {
  return (
    <div className="grid grid-4">
      {[0, 1, 2, 3].map((i) => (
        <div className="card" key={i}>
          <div className="skel" style={{ height: 14, width: "60%", marginBottom: 12 }} />
          <div className="skel" style={{ height: 28, width: "80%" }} />
        </div>
      ))}
    </div>
  );
}

function Footer({ state }: { state: StateResp | null }) {
  return (
    <div className="footer">
      bot.proxaslab.com · auto-refresh every {REFRESH_MS / 1000}s
      {state && <> · uptime {fmtUptime(state.health.uptimeSec)}</>}
    </div>
  );
}

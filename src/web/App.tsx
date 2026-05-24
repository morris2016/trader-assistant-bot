import React, { useEffect, useState, useCallback } from "react";
import { api, fmtUptime, eatToday, eatDateOf, type StateResp, type StrategyStats, type Subscription } from "./api";
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
import { Fast4Panel } from "./panels/Fast4";
import { LogsPanel } from "./panels/Logs";
import { BinanceOverviewPanel } from "./panels/binance/BinanceOverview";
import { BinancePositionsPanel } from "./panels/binance/BinancePositions";
import { BinanceTradesPanel } from "./panels/binance/BinanceTrades";
import { BinanceStrategiesPanel } from "./panels/binance/BinanceStrategies";
import { BinanceHFPanel } from "./panels/binance/BinanceHF";
import { BinanceExternalPanel } from "./panels/binance/BinanceExternal";
import { BinanceLogsPanel } from "./panels/binance/BinanceLogs";
import { BinanceSettingsPanel } from "./panels/binance/BinanceSettings";
import { BinancePaperPanel } from "./panels/binance/BinancePaper";

const REFRESH_MS = 3000;

type TabId = "overview" | "charts" | "real" | "synth" | "fade" | "fast3" | "fast4" | "adaptive" | "logs" | "settings";
type BinanceTabId = "overview" | "positions" | "external" | "trades" | "strategies" | "hf" | "paper" | "logs" | "settings";
type Mode = "deriv" | "binance";

const BINANCE_TABS: { id: BinanceTabId; label: string; icon: string }[] = [
  { id: "overview",   label: "Overview",   icon: "◆" },
  { id: "positions",  label: "Positions",  icon: "▣" },
  { id: "external",   label: "External",   icon: "↪" },
  { id: "trades",     label: "Trades",     icon: "≡" },
  { id: "strategies", label: "Strategies", icon: "⚛" },
  { id: "hf",         label: "HF",         icon: "⚡" },
  { id: "paper",      label: "Paper",      icon: "📝" },
  { id: "logs",       label: "Logs",       icon: "📋" },
  { id: "settings",   label: "Settings",   icon: "⚙" },
];

// SILENCED 2026-05-19: synth/fast3/fast4 tabs hidden while Fade iteration is
// active. Their panels still build (no runtime cost) but aren't reachable
// from the nav. Re-enable by uncommenting.
const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "overview",   label: "Overview",   icon: "◆" },
  { id: "charts",     label: "Charts",     icon: "📈" },
  { id: "real",       label: "Real",       icon: "$" },
  // { id: "synth",      label: "Synth",      icon: "🧬" },
  { id: "fade",       label: "Fade",       icon: "💥" },
  // { id: "fast3",      label: "Fast3",      icon: "🎯" },
  // { id: "fast4",      label: "Fast4",      icon: "🔬" },
  { id: "adaptive",   label: "Adaptive",   icon: "🛡" },
  { id: "logs",       label: "Logs",       icon: "📋" },
  { id: "settings",   label: "Settings",   icon: "⚙" },
];

export function App() {
  const [tab, setTab] = useState<TabId>("overview");
  const [bTab, setBTab] = useState<BinanceTabId>("overview");
  const [mode, setMode] = useState<Mode>("deriv");
  // Toggle a body-level class so the Binance-mode palette applies to the
  // full viewport background, not just the .shell grid.
  useEffect(() => {
    if (mode === "binance") document.body.classList.add("binance-mode");
    else document.body.classList.remove("binance-mode");
  }, [mode]);
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
    <div className={`shell ${mode === "binance" ? "binance-mode" : ""}`}>
      {mode === "binance"
        ? <BinanceSidebar tab={bTab} setTab={setBTab} />
        : <Sidebar tab={tab} setTab={setTab} state={state} subs={subs} strategies={strategies} />}
      <div className="main">
        <Header state={state} stale={stale} error={error} mode={mode} />
        <ModeSwitcher mode={mode} setMode={setMode} />
        {mode === "binance" ? (
          <>
            {bTab === "overview"   && <BinanceOverviewPanel />}
            {bTab === "positions"  && <BinancePositionsPanel />}
            {bTab === "external"   && <BinanceExternalPanel />}
            {bTab === "trades"     && <BinanceTradesPanel />}
            {bTab === "strategies" && <BinanceStrategiesPanel />}
            {bTab === "hf"         && <BinanceHFPanel />}
            {bTab === "paper"      && <BinancePaperPanel />}
            {bTab === "logs"       && <BinanceLogsPanel />}
            {bTab === "settings"   && <BinanceSettingsPanel pending={actionPending} />}
          </>
        ) : (
          <>
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
                {tab === "fast4"      && <Fast4Panel state={state} doAction={doAction} pending={actionPending} />}
                {tab === "adaptive"   && <AdaptivePanel state={state} doAction={doAction} pending={actionPending} />}
                {tab === "logs"       && <LogsPanel />}
                {tab === "settings"   && <SettingsPanel state={state} doAction={doAction} pending={actionPending} />}
              </>
            )}
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
          <div
            className="nav-item"
            style={{ cursor: "pointer", marginTop: 8, color: "#d4a35f" }}
            onClick={async () => {
              if (!confirm("Sign out?")) return;
              await fetch("/api/auth/logout", { method: "POST" });
              window.location.reload();
            }}
          >
            <span className="nav-item-icon">⎋</span>
            <span>Sign out</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Header({ state, stale, error, mode }: { state: StateResp | null; stale: boolean; error: string | null; mode: Mode }) {
  const live = state?.health.wsConnected && state?.health.authorized;
  const status = error ? "dead" : stale ? "stale" : live ? "live" : "stale";
  const account = state?.account;
  // In Binance mode: hide all Deriv-side pills (WS UP/DOWN, ACTIVE/PAUSED,
  // stale/live refresh) — they describe the Deriv WebSocket which is irrelevant
  // here — and show a Binance-specific status strip instead.
  if (mode === "binance") return <BinanceHeader />;
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

/** Binance-mode header: shows engine ●/○, hasCreds, today's bot P&L,
 *  open count (bot-tracked + external), and live/network/testnet pills.
 *  Polls /api/binance/state every 3s. */
function BinanceHeader() {
  const [bs, setBs] = useState<any>(null);
  const [ext, setExt] = useState<{ positions: any[] } | null>(null);
  // Wallet-truth P&L (from Binance income endpoint). Tells us the REAL story —
  // bot's local `closed[]` misses external cancellations and doesn't include
  // unrealized P&L, which is how the UI used to show +$0.74 while wallet was -$11.
  const [wallet, setWallet] = useState<{ realized: number; commission: number; unrealized: number; wallet: number; events: number; sinceMs: number } | null>(null);
  const [lastFetch, setLastFetch] = useState(Date.now());
  useEffect(() => {
    const refresh = async () => {
      try { setBs(await api.binanceState()); setLastFetch(Date.now()); } catch {}
      try { setExt(await api.binanceExternalPositions()); } catch {}
      try { setWallet(await api.binanceWalletPnl()); } catch {}
    };
    refresh();
    const id = setInterval(refresh, 5000);  // wallet-truth poll is slightly slower to ease API weight
    return () => clearInterval(id);
  }, []);
  const stale = Date.now() - lastFetch > 8000;
  const hasCreds = !!bs?.hasCreds;
  const running = !!bs?.running;
  const testnet = !!bs?.testnet;
  const botOpen = bs?.state?.open?.length ?? 0;
  const extOpen = ext?.positions?.length ?? 0;
  const dailyCapHit = !!bs?.state?.daily?.capHit;
  const realized = wallet ? wallet.realized + wallet.commission : 0;  // net realized after fees
  const unreal = wallet?.unrealized ?? 0;
  const total = realized + unreal;
  const fmt = (n: number) => `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
  return (
    <div className="header">
      <div className="header-left">
        <h1>Binance Futures</h1>
        <div className="subtitle">
          {!hasCreds ? "no credentials" :
           !wallet ? `${botOpen} bot trades · ${extOpen} external · engine ${running ? "on" : "off"}` :
           <>
             wallet <strong>${wallet.wallet.toFixed(2)}</strong>
             {" · "}
             <span style={{ color: realized >= 0 ? "#0ecb81" : "#f6465d" }}>realized {fmt(realized)}</span>
             {" · "}
             <span style={{ color: unreal >= 0 ? "#0ecb81" : "#f6465d" }}>unrealized {fmt(unreal)}</span>
             {" · "}
             <span style={{ color: total >= 0 ? "#0ecb81" : "#f6465d", fontWeight: 600 }}>total {fmt(total)}</span>
           </>}
          {testnet ? " · TESTNET" : ""}
        </div>
      </div>
      <div className="row">
        {dailyCapHit && (
          <span className="pill pill-red"><span className="pill-dot" />DAILY CAP HIT</span>
        )}
        <span className={`pill ${running ? "pill-green" : "pill-amber"}`}>
          <span className="pill-dot" />
          {running ? "ENGINE ●" : "ENGINE ○"}
        </span>
        <span className={`pill ${hasCreds ? "pill-green" : "pill-red"}`}>
          <span className="pill-dot" />
          {hasCreds ? "API READY" : "NO CREDS"}
        </span>
        <span className={`refresh ${stale ? "stale" : "live"}`}>{stale ? "stale" : "live"}</span>
      </div>
    </div>
  );
}

function titleForTab() {
  return "Dashboard";
}

function BinanceSidebar({ tab, setTab }: { tab: BinanceTabId; setTab: (t: BinanceTabId) => void }) {
  return (
    <div className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-icon">₿</div>
        <div className="brand-text"><div className="brand-title">Binance</div><div className="brand-sub">Futures crypto</div></div>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-title">Navigation</div>
        {BINANCE_TABS.map((t) => (
          <div key={t.id} className={`nav-item ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            <span className="nav-item-icon">{t.icon}</span>
            <span>{t.label}</span>
          </div>
        ))}
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-title">Reference</div>
        <div className="nav-item" style={{ cursor: "default" }}>
          <span className="nav-item-icon">📊</span>
          <span className="muted">15 assets · 3 patterns</span>
        </div>
        <div className="nav-item" style={{ cursor: "default" }}>
          <span className="nav-item-icon">⚡</span>
          <span className="muted">30× leverage</span>
        </div>
        <div className="nav-item" style={{ cursor: "default" }}>
          <span className="nav-item-icon">$</span>
          <span className="muted">$15 flat stake</span>
        </div>
      </div>
      <div className="sidebar-section">
        <div className="sidebar-section-title">Account</div>
        <div className="nav-item" style={{ cursor: "pointer", color: "#d4a35f" }}
          onClick={async () => {
            if (!confirm("Sign out?")) return;
            await fetch("/api/auth/logout", { method: "POST" });
            window.location.reload();
          }}>
          <span className="nav-item-icon">⎋</span>
          <span>Sign out</span>
        </div>
      </div>
    </div>
  );
}

function ModeSwitcher({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const baseStyle: React.CSSProperties = {
    padding: "8px 18px", borderRadius: 8, border: "1px solid #1e2842",
    background: "#0f1626", color: "#8a95b8", cursor: "pointer",
    fontSize: 14, fontWeight: 600,
  };
  // Binance active = Binance-gold pill with black text; Deriv active = blue
  const derivActiveStyle: React.CSSProperties = {
    ...baseStyle, background: "#4a89e0", color: "#fff", border: "1px solid #4a89e0",
  };
  const binanceActiveStyle: React.CSSProperties = {
    ...baseStyle, background: "#fcd535", color: "#0c0c0c", border: "1px solid #fcd535",
  };
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 16, paddingBottom: 12, borderBottom: "1px solid #1e2842" }}>
      <button style={mode === "deriv" ? derivActiveStyle : baseStyle} onClick={() => setMode("deriv")}>
        Deriv
      </button>
      <button style={mode === "binance" ? binanceActiveStyle : baseStyle} onClick={() => setMode("binance")}>
        Binance
      </button>
    </div>
  );
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

import { NavLink } from "react-router-dom";
import { useStore } from "../store";

export function Nav() {
  const status = useStore((s) => s.status);
  const real = useStore((s) => s.real);
  const account = status.account;

  const modeLabel = status.realModeEnabled ? "REAL" : "PAPER";
  const modeColor = status.realModeEnabled
    ? (account?.isVirtual ? "#d4a35f" : "#e05f8a")
    : "#5fd4a4";

  return (
    <nav className="nav">
      <div className="nav-title">
        <span style={{ fontSize: 20 }}>📊</span> Trader Assistant
      </div>
      <NavLink to="/" end className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
        Live
      </NavLink>
      <NavLink to="/backtest" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
        Backtest
      </NavLink>
      <NavLink to="/history" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
        History
      </NavLink>
      <NavLink to="/settings" className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`}>
        Settings
      </NavLink>
      <div className="nav-footer">
        <div className="status-row">
          <span>WebSocket</span>
          <span>
            <span className={`status-dot ${status.wsConnected ? "ok" : ""}`} />{" "}
            {status.wsConnected ? "live" : "offline"}
          </span>
        </div>
        <div className="status-row">
          <span>Watcher</span>
          <span>
            <span className={`status-dot ${status.watching ? "ok" : "off"}`} />{" "}
            {status.watching ? "running" : "stopped"}
          </span>
        </div>
        {account && (
          <div className="status-row">
            <span>{account.isVirtual ? "DEMO" : "REAL acct"}</span>
            <span style={{ color: account.isVirtual ? "#d4a35f" : "#e05f8a", fontWeight: 700 }}>
              {account.balance.toFixed(2)} {account.currency}
            </span>
          </div>
        )}
        <div className="status-row">
          <span>Mode</span>
          <span style={{ color: modeColor, fontWeight: 700 }}>{modeLabel}</span>
        </div>
        {real && real.stats.totalClosed > 0 && (
          <div className="status-row">
            <span>Real P&L today</span>
            <span style={{ color: real.daily.profit >= 0 ? "#5fd4a4" : "#e05f8a", fontWeight: 700 }}>
              {real.daily.profit >= 0 ? "+" : ""}{real.daily.profit.toFixed(2)}
            </span>
          </div>
        )}
      </div>
    </nav>
  );
}

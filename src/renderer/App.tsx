import { useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { Nav } from "./components/Nav";
import LiveRoute from "./routes/live";
import BacktestRoute from "./routes/backtest";
import HistoryRoute from "./routes/history";
import SettingsRoute from "./routes/settings";
import { useStore } from "./store";

export default function App() {
  const init = useStore((s) => s.init);
  const wireEvents = useStore((s) => s.wireEvents);
  const realErrors = useStore((s) => s.realErrors);
  const dismissRealError = useStore((s) => s.dismissRealError);

  useEffect(() => {
    init();
    const off = wireEvents();
    return () => off();
  }, [init, wireEvents]);

  return (
    <HashRouter>
      <div className="app">
        <Nav />
        <main className="main">
          {realErrors.length > 0 && (
            <div style={{
              position: "sticky", top: 0, zIndex: 10,
              padding: "8px 16px", display: "flex", flexDirection: "column", gap: 4,
              background: "#0b0f1a",
            }}>
              {realErrors.slice(-4).map((e) => (
                <div key={e.id} style={{
                  background: "#4a1e2e", border: "1px solid #e05f8a", color: "#e05f8a",
                  padding: "8px 12px", borderRadius: 6, fontSize: 12, display: "flex", alignItems: "center",
                }}>
                  <span>⚠ {e.message}</span>
                  <button
                    style={{ marginLeft: "auto", background: "transparent", border: "none", color: "#e05f8a", cursor: "pointer", fontSize: 14 }}
                    onClick={() => dismissRealError(e.id)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <Routes>
            <Route path="/" element={<LiveRoute />} />
            <Route path="/backtest" element={<BacktestRoute />} />
            <Route path="/history" element={<HistoryRoute />} />
            <Route path="/settings" element={<SettingsRoute />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}

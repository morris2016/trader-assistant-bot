import React, { useEffect, useState } from "react";
import { api, type StateResp } from "../api";

const STAKE_LADDER = [1.0, 1.0, 0.5, 0.25, 0.15];
const SIDE_WINDOW = 3;

export function AdaptivePanel({ state, doAction, pending }: {
  state: StateResp;
  doAction: (label: string, fn: () => Promise<unknown>) => void;
  pending: string | null;
}) {
  const a = state.adaptiveShift;
  const ladderIdx = Math.min(a.consecLosses, STAKE_LADDER.length - 1);
  const currentMult = STAKE_LADDER[ladderIdx];

  const buyRecent = a.buyHistory.slice(-SIDE_WINDOW);
  const sellRecent = a.sellHistory.slice(-SIDE_WINDOW);
  const buyLosses = buyRecent.filter((o) => o === "L").length;
  const sellLosses = sellRecent.filter((o) => o === "L").length;
  const buyBias = buyRecent.length >= SIDE_WINDOW && buyLosses >= 2;
  const sellBias = sellRecent.length >= SIDE_WINDOW && sellLosses >= 2;

  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const metalsThrottleSec = Math.max(0, Math.floor((a.metalsThrottleUntil - now) / 1000));
  const metalsThrottled = metalsThrottleSec > 0;

  return (
    <>
      <div className="grid grid-3">
        <div className="card card-padded">
          <div className="card-title">Status</div>
          <div className="card-value" style={{ fontSize: 18 }}>
            {state.adaptiveShiftDescription === "normal" ? <span className="pos">Normal operation</span> : <span className="amber">{state.adaptiveShiftDescription}</span>}
          </div>
          <div className="card-sub">
            Stake multiplier: <span className="bold">{(currentMult * 100).toFixed(0)}%</span>
            {currentMult < 1 && " — protective mode"}
          </div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Consecutive Losses</div>
          <div className={`card-value ${a.consecLosses >= 2 ? "neg" : "muted"}`}>{a.consecLosses}</div>
          <div className="card-sub">resets on first win</div>
        </div>
        <div className="card card-padded">
          <div className="card-title">Metals Throttle</div>
          <div className={`card-value ${metalsThrottled ? "amber" : "muted"}`} style={{ fontSize: 18 }}>
            {metalsThrottled ? `${formatRemaining(metalsThrottleSec)} left` : "inactive"}
          </div>
          <div className="card-sub">2 metals losses within 4h → 50% stake for 12h</div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Stake Ladder</div>
          <div className="section-sub">Consecutive-loss multiplier — current position highlighted</div>
        </div>
        <div className="card card-padded">
          <div className="ladder">
            {STAKE_LADDER.map((mult, idx) => {
              const isLast = idx === STAKE_LADDER.length - 1;
              const isActive = ladderIdx === idx || (idx === STAKE_LADDER.length - 1 && a.consecLosses >= idx);
              return (
                <div key={idx} className={`ladder-step ${isActive ? "active" : ""}`}>
                  <strong>{(mult * 100).toFixed(0)}%</strong>
                  <div>{idx}{isLast ? "+" : ""}L</div>
                </div>
              );
            })}
          </div>
          <div className="card-sub" style={{ marginTop: 12 }}>
            First loss is normal variance — no penalty. Pattern triggers (≥2 consec L) reduce stake.
            One win resets to 100%.
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Side Bias</div>
          <div className="section-sub">Last 3 trades per side — 2/3 losses → that side at 30% stake</div>
        </div>
        <div className="grid grid-2">
          <div className="card card-padded">
            <div className="row">
              <span className="card-title" style={{ marginBottom: 0 }}>BUY history</span>
              <span className="spacer" />
              {buyBias && <span className="pill pill-amber"><span className="pill-dot" />BIAS ACTIVE</span>}
            </div>
            <div className="history-cells">
              {Array.from({ length: 5 }).map((_, i) => {
                const cell = a.buyHistory[a.buyHistory.length - 5 + i];
                return <div key={i} className={`history-cell ${cell ?? "empty"}`}>{cell ?? "·"}</div>;
              })}
            </div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              {a.buyHistory.length} BUY trades · {buyBias ? `${(0.30 * 100).toFixed(0)}% stake until next BUY win` : "no bias"}
            </div>
          </div>
          <div className="card card-padded">
            <div className="row">
              <span className="card-title" style={{ marginBottom: 0 }}>SELL history</span>
              <span className="spacer" />
              {sellBias && <span className="pill pill-amber"><span className="pill-dot" />BIAS ACTIVE</span>}
            </div>
            <div className="history-cells">
              {Array.from({ length: 5 }).map((_, i) => {
                const cell = a.sellHistory[a.sellHistory.length - 5 + i];
                return <div key={i} className={`history-cell ${cell ?? "empty"}`}>{cell ?? "·"}</div>;
              })}
            </div>
            <div className="card-sub" style={{ marginTop: 8 }}>
              {a.sellHistory.length} SELL trades · {sellBias ? `${(0.30 * 100).toFixed(0)}% stake until next SELL win` : "no bias"}
            </div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-header">
          <div className="section-title">Reset Adaptive State</div>
          <div className="section-sub">Clears loss-streak, side bias, and metals throttle. Use carefully.</div>
        </div>
        <div className="card card-padded">
          <button className="btn btn-warn" disabled={pending !== null} onClick={() => doAction("Reset adaptive shift state to clean", () => api.resetAdaptive())}>
            ⟳ Reset Adaptive Shift to Normal
          </button>
        </div>
      </div>
    </>
  );
}

function formatRemaining(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

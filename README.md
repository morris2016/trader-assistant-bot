# trader-assistant-desktop

Desktop trader assistant for **Deriv** — connects to the Deriv public WebSocket API, builds live candles, runs SMC / TA detectors, paints them on the chart, and places paper or real trades.

## Stack

- **Electron 33** + **React 18** + **TypeScript** + **Vite** (via `electron-vite`)
- **lightweight-charts v5** for candles + Primitives API for OB / FVG / BOS overlays
- **ws** — Deriv WebSocket client (runs in the main process, single persistent connection)
- **zustand** — renderer state
- **electron-store** + Electron `safeStorage` — settings + encrypted API token

## What v0 ships with

- Live WS connection to `wss://ws.derivws.com/websockets/v3`
- Tick stream + live candle aggregation for synthetics (R_10 / R_25 / R_50 / R_75 / R_100)
- Live chart with bar-by-bar updates
- Detector framework with **EMA 9/21 cross** and **bullish/bearish Order Blocks**
- Route skeletons for Backtest / History / Settings
- Paper-trade engine stub (open/close on signal, track P&L)
- Settings screen for API token (encrypted via Electron `safeStorage`)

## What's next (not in v0)

- SMC pack: FVG, BOS, CHoCH, liquidity sweeps, supply/demand zones
- Backtest tab: `ticks_history` replay with speed control
- Real trading: Rise/Fall contracts with guardrails (per-trade max, daily max loss, explicit "real money" switch)
- SQLite trade journal (currently JSON via electron-store)

## Run

```
npm install
npm run dev
```

The dev window opens with DevTools. The WS client auto-connects to Deriv (public `app_id=1089`) on boot — no token required for market data.

## Build

```
npm run build
```

## Layout

```
src/
├─ main/                    # Electron main process
│   ├─ index.ts
│   ├─ deriv/               # WS client + types
│   ├─ engine/
│   │   ├─ candles.ts       # tick -> candle aggregator
│   │   ├─ detectors/       # detector implementations
│   │   ├─ runner.ts        # orchestrates detectors per symbol
│   │   └─ paper.ts         # paper-trade engine
│   ├─ storage/             # electron-store + safeStorage
│   └─ ipc/                 # channel names + handlers
├─ preload/                 # contextBridge: exposes typed window.api
├─ renderer/                # React UI
│   ├─ routes/{live,backtest,history,settings}/
│   ├─ components/Chart.tsx # lightweight-charts wrapper
│   └─ store/               # zustand
└─ shared/                  # types used by both sides
```

## Deriv API notes

- Endpoint: `wss://ws.derivws.com/websockets/v3?app_id=<APP_ID>` — uses `1089` by default (Deriv's public demo id). Create your own at [api.deriv.com](https://api.deriv.com) for production.
- Market data (ticks, ohlc, ticks_history) is unauthenticated.
- Any account action (balance, buy, sell) requires `authorize` with an API token.
- Synthetic indices (R_10 etc.) run 24/7 — good for always-on scalping dev.

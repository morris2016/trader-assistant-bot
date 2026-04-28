import React, { useEffect, useRef, useState } from "react";
import { createChart, CandlestickSeries, type IChartApi, type ISeriesApi, ColorType } from "lightweight-charts";
import { api, fmtGranularity, type Candle, type Subscription } from "../api";

export function ChartsPanel({ subs }: { subs: Subscription[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    if (subs.length > 0 && !active) {
      setActive(`${subs[0].symbol}|${subs[0].granularity}`);
    }
  }, [subs, active]);

  if (subs.length === 0) {
    return <div className="card empty"><span className="empty-emoji">📊</span>No subscriptions yet — bot is still initializing.</div>;
  }

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div className="chart-header">
        <div className="chart-tabs">
          {subs.map((s) => {
            const key = `${s.symbol}|${s.granularity}`;
            return (
              <div
                key={key}
                className={`chart-tab ${active === key ? "active" : ""}`}
                onClick={() => setActive(key)}
              >
                {s.symbol} <span className="faint" style={{ marginLeft: 4 }}>{fmtGranularity(s.granularity)}</span>
              </div>
            );
          })}
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          {active && (() => {
            const s = subs.find((x) => `${x.symbol}|${x.granularity}` === active);
            return s ? `${s.bars} bars in memory` : "";
          })()}
        </div>
      </div>
      {active && <ChartCanvas symbolKey={active} />}
    </div>
  );
}

function ChartCanvas({ symbolKey }: { symbolKey: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 460,
      layout: {
        background: { type: ColorType.Solid, color: "#11161f" },
        textColor: "#8b96a6",
      },
      grid: {
        vertLines: { color: "#1f2733" },
        horzLines: { color: "#1f2733" },
      },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: "#2a3343" },
      rightPriceScale: { borderColor: "#2a3343" },
      crosshair: { mode: 0 },
    });
    // lightweight-charts v5 API: addSeries(SeriesType, options)
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#3fb950",
      downColor: "#f85149",
      borderUpColor: "#3fb950",
      borderDownColor: "#f85149",
      wickUpColor: "#3fb950",
      wickDownColor: "#f85149",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.remove();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollTimer: number | undefined;
    const [sym, grStr] = symbolKey.split("|");
    const gr = Number(grStr);
    const load = async () => {
      try {
        setLoading(true);
        const r = await api.candles(sym, gr, 500);
        if (cancelled) return;
        const data = r.candles.map(toLwc);
        if (seriesRef.current) seriesRef.current.setData(data);
        if (chartRef.current && data.length > 0) chartRef.current.timeScale().fitContent();
        setLoading(false);
        setError(null);
      } catch (e) {
        if (!cancelled) { setError((e as Error).message); setLoading(false); }
      }
    };
    load();
    pollTimer = window.setInterval(load, 5000) as unknown as number;
    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [symbolKey]);

  return (
    <div style={{ position: "relative" }}>
      {loading && <div className="empty" style={{ position: "absolute", inset: 0, zIndex: 1 }}>Loading…</div>}
      {error && <div className="banner banner-danger" style={{ margin: 12 }}>⚠ {error}</div>}
      <div ref={containerRef} style={{ width: "100%", height: 460 }} />
    </div>
  );
}

function toLwc(c: Candle) {
  return { time: c.epoch, open: c.open, high: c.high, low: c.low, close: c.close } as any;
}

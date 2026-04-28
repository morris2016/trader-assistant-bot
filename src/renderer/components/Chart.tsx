import { useEffect, useMemo, useRef } from "react";
import {
  createChart,
  CandlestickSeries,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type UTCTimestamp,
  type Time,
  type SeriesMarker,
  type IPrimitivePaneView,
  type IPrimitivePaneRenderer,
  type ISeriesPrimitive,
  type SeriesAttachedParameter,
  type Coordinate,
} from "lightweight-charts";
import type { Candle, LiquidityPool, OrderBlock, Signal, StructureMark, SymbolCode, SymbolMeta } from "@shared/types";
import { symbolDigits } from "@shared/symbols";
import { theme } from "../theme";

type Props = {
  candles: Candle[];
  orderBlocks: OrderBlock[];
  signals: Signal[];
  structureMarks?: StructureMark[];
  liquidityPools?: LiquidityPool[];
  /** The symbol the candles belong to — used for price-axis precision. */
  symbol?: SymbolCode;
  /** Authoritative symbol metadata from Deriv (pip_size + display_decimals). */
  symbolMeta?: SymbolMeta | null;
  height?: number;
};

export function Chart({ candles, orderBlocks, signals, structureMarks, liquidityPools, symbol, symbolMeta, height = 500 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const obPrimitiveRef = useRef<OrderBlockPrimitive | null>(null);
  const structurePrimitiveRef = useRef<StructurePrimitive | null>(null);
  const poolPrimitiveRef = useRef<LiquidityPoolPrimitive | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  // --- init chart ----------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: theme.bgPanel },
        textColor: theme.textMuted,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "#1a2240" },
        horzLines: { color: "#1a2240" },
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        borderColor: theme.border,
      },
      rightPriceScale: {
        borderColor: theme.border,
      },
      crosshair: {
        vertLine: { color: theme.border, labelBackgroundColor: theme.bgPanel },
        horzLine: { color: theme.border, labelBackgroundColor: theme.bgPanel },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: theme.bull,
      downColor: theme.bear,
      borderUpColor: theme.bull,
      borderDownColor: theme.bear,
      wickUpColor: theme.bull,
      wickDownColor: theme.bear,
    });


    const ob = new OrderBlockPrimitive([]);
    series.attachPrimitive(ob);
    const structurePrim = new StructurePrimitive([]);
    series.attachPrimitive(structurePrim);
    const poolPrim = new LiquidityPoolPrimitive([]);
    series.attachPrimitive(poolPrim);
    const markers = createSeriesMarkers(series, []);

    chartRef.current = chart;
    seriesRef.current = series;
    obPrimitiveRef.current = ob;
    structurePrimitiveRef.current = structurePrim;
    poolPrimitiveRef.current = poolPrim;
    markersRef.current = markers;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      obPrimitiveRef.current = null;
      structurePrimitiveRef.current = null;
      poolPrimitiveRef.current = null;
      markersRef.current = null;
    };
  }, []);

  // Track whether the series is empty so we only force-fit on initial load
  // or after a symbol/TF reset (not on every live-tick append).
  const wasEmptyRef = useRef(true);

  // --- apply per-symbol price precision, adaptive to visible range -------
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    // Prefer Deriv's authoritative pipSize; fall back to static digits table.
    const baseDigits = symbolMeta
      ? symbolMeta.displayDecimals
      : symbol ? symbolDigits(symbol) : 3;
    let digits = baseDigits;

    if (candles.length > 1) {
      let lo = Infinity, hi = -Infinity;
      for (const c of candles) {
        if (c.low < lo) lo = c.low;
        if (c.high > hi) hi = c.high;
      }
      const range = hi - lo;
      while (range > 0 && range < Math.pow(10, -digits) * 8 && digits < 10) {
        digits++;
      }
    }

    const minMove = symbolMeta?.pipSize ?? Math.pow(10, -digits);
    s.applyOptions({
      priceFormat: {
        type: "price",
        precision: digits,
        minMove,
      },
    });
  }, [symbol, symbolMeta, candles]);

  // --- update candles ------------------------------------------------------
  useEffect(() => {
    const s = seriesRef.current;
    const chart = chartRef.current;
    if (!s || !chart) return;
    s.setData(candles.map(toCandlestick));
    // After an empty → populated transition (boot, symbol change, TF change),
    // fit the time scale so all loaded bars are visible. Don't re-fit on
    // normal live-tick appends (would cause zoom jitter).
    if (wasEmptyRef.current && candles.length > 0) {
      chart.timeScale().fitContent();
      wasEmptyRef.current = false;
    }
    if (candles.length === 0) wasEmptyRef.current = true;
  }, [candles]);

  // --- update order-block overlay -----------------------------------------
  useEffect(() => {
    const ob = obPrimitiveRef.current;
    if (!ob) return;
    // Cap rightmost endEpoch to the latest candle time so boxes extend to "now".
    const lastEpoch = candles[candles.length - 1]?.epoch ?? Math.floor(Date.now() / 1000);
    ob.setBlocks(orderBlocks, lastEpoch);
  }, [orderBlocks, candles]);

  // --- update structure-mark overlay (BOS / CHoCH lines) ------------------
  useEffect(() => {
    const prim = structurePrimitiveRef.current;
    if (!prim) return;
    prim.setMarks(structureMarks ?? []);
  }, [structureMarks]);

  // --- update liquidity-pool overlay --------------------------------------
  useEffect(() => {
    const prim = poolPrimitiveRef.current;
    if (!prim) return;
    const lastEpoch = candles[candles.length - 1]?.epoch ?? Math.floor(Date.now() / 1000);
    prim.setPools(liquidityPools ?? [], lastEpoch);
  }, [liquidityPools, candles]);

  // --- update signal markers ----------------------------------------------
  useEffect(() => {
    const api = markersRef.current;
    if (!api) return;
    const markers: SeriesMarker<Time>[] = signals
      .slice()
      .reverse()
      .map((sig) => ({
        time: Math.floor(sig.ts / 1000) as UTCTimestamp,
        position: sig.action === "BUY" ? "belowBar" : "aboveBar",
        color: sig.action === "BUY" ? theme.bull : theme.bear,
        shape: sig.action === "BUY" ? "arrowUp" : "arrowDown",
        text: `${sig.action} · ${sig.detector}`,
      }));
    api.setMarkers(markers);
  }, [signals]);

  const priceDisplay = useMemo(() => {
    const last = candles[candles.length - 1];
    if (!last) return "—";
    const digits = symbol ? symbolDigits(symbol) : getPrecision(last.close);
    return last.close.toFixed(digits);
  }, [candles, symbol]);

  const rangeDebug = useMemo(() => {
    if (candles.length < 2) return null;
    let lo = Infinity, hi = -Infinity;
    for (const c of candles) {
      if (c.low < lo) lo = c.low;
      if (c.high > hi) hi = c.high;
    }
    const digits = symbolMeta?.displayDecimals ?? (symbol ? symbolDigits(symbol) : 3);
    const pipSize = symbolMeta?.pipSize;
    return {
      lo: lo.toFixed(digits),
      hi: hi.toFixed(digits),
      range: (hi - lo).toFixed(digits),
      bars: candles.length,
      digits,
      pipSize: pipSize != null ? pipSize.toString() : "—",
      source: symbolMeta ? "Deriv" : "static",
    };
  }, [candles, symbol, symbolMeta]);

  return (
    <div className="chart-wrap" style={{ height }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      <div className="chart-price-tag">
        <span className="sym">PRICE</span>
        {priceDisplay}
      </div>
      {rangeDebug && (
        <div style={{
          position: "absolute", bottom: 10, left: 14, pointerEvents: "none",
          background: "rgba(11,15,26,0.75)", border: "1px solid #1e2842",
          padding: "4px 8px", borderRadius: 4,
          color: "#8a95b8", fontSize: 10, fontFamily: "monospace",
          lineHeight: 1.4,
        }}>
          <div>lo {rangeDebug.lo} · hi {rangeDebug.hi} · range {rangeDebug.range}</div>
          <div>{rangeDebug.digits}d · pip {rangeDebug.pipSize} ({rangeDebug.source}) · {rangeDebug.bars} bars</div>
        </div>
      )}
    </div>
  );
}

function toCandlestick(c: Candle) {
  return {
    time: c.epoch as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

function getPrecision(v: number) {
  if (v < 1) return 4;
  if (v < 100) return 3;
  return 2;
}

// ---------------------------------------------------------------------------
// OrderBlockPrimitive — draws shaded rectangles on the chart for each OB.
// Uses lightweight-charts v5 Primitives API.
// ---------------------------------------------------------------------------

class OrderBlockPaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly boxes: Array<{ x1: Coordinate | null; x2: Coordinate | null; y1: Coordinate | null; y2: Coordinate | null; side: "BULL" | "BEAR"; kind: "ob" | "fvg" }>,
  ) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const { horizontalPixelRatio: hPR, verticalPixelRatio: vPR } = scope;
      for (const b of this.boxes) {
        if (b.x1 == null || b.x2 == null || b.y1 == null || b.y2 == null) continue;
        const x1 = Math.round(b.x1 * hPR);
        const x2 = Math.round(b.x2 * hPR);
        const yTop = Math.round(Math.min(b.y1, b.y2) * vPR);
        const yBot = Math.round(Math.max(b.y1, b.y2) * vPR);
        const w = Math.max(1, x2 - x1);
        const h = Math.max(1, yBot - yTop);

        const fill = b.kind === "fvg"
          ? (b.side === "BULL" ? theme.fvgBull : theme.fvgBear)
          : (b.side === "BULL" ? theme.obBull : theme.obBear);
        const stroke = b.kind === "fvg"
          ? (b.side === "BULL" ? theme.fvgBullBorder : theme.fvgBearBorder)
          : (b.side === "BULL" ? theme.obBullBorder : theme.obBearBorder);

        ctx.fillStyle = fill;
        ctx.fillRect(x1, yTop, w, h);
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1;
        if (b.kind === "fvg") ctx.setLineDash([4, 3]);
        else ctx.setLineDash([]);
        ctx.strokeRect(x1 + 0.5, yTop + 0.5, w - 1, h - 1);
        ctx.setLineDash([]);
      }
    });
  }
}

class OrderBlockPaneView implements IPrimitivePaneView {
  constructor(private readonly host: OrderBlockPrimitive) {}

  renderer() {
    const chart = this.host.chart;
    const series = this.host.series;
    if (!chart || !series) return new OrderBlockPaneRenderer([]);
    const timeScale = chart.timeScale();
    const rightEdgeEpoch = this.host.rightEdgeEpoch;
    const boxes = this.host.blocks.map((b) => {
      const startTime = b.startEpoch as UTCTimestamp;
      const endTime = (b.endEpoch ?? rightEdgeEpoch) as UTCTimestamp;
      const x1 = timeScale.timeToCoordinate(startTime);
      const x2 = timeScale.timeToCoordinate(endTime);
      const y1 = series.priceToCoordinate(b.top);
      const y2 = series.priceToCoordinate(b.bottom);
      return { x1, x2, y1, y2, side: b.side, kind: (b.kind ?? "ob") as "ob" | "fvg" };
    });
    return new OrderBlockPaneRenderer(boxes);
  }
}

class OrderBlockPrimitive implements ISeriesPrimitive<Time> {
  public blocks: OrderBlock[];
  public rightEdgeEpoch: number = 0;
  public chart: IChartApi | null = null;
  public series: ISeriesApi<"Candlestick"> | null = null;
  private view: OrderBlockPaneView;

  constructor(blocks: OrderBlock[]) {
    this.blocks = blocks;
    this.view = new OrderBlockPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<"Candlestick">;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  updateAllViews() {
    // view state derives from blocks directly — nothing to do here
  }

  paneViews(): IPrimitivePaneView[] {
    return [this.view];
  }

  setBlocks(blocks: OrderBlock[], rightEdgeEpoch: number) {
    this.blocks = blocks;
    this.rightEdgeEpoch = rightEdgeEpoch;
  }
}

// ---------------------------------------------------------------------------
// StructurePrimitive — draws BOS / CHoCH horizontal lines + labels.
// ---------------------------------------------------------------------------

type StructureBox = {
  x1: Coordinate | null;
  x2: Coordinate | null;
  y: Coordinate | null;
  kind: "BOS" | "CHoCH";
  side: "up" | "down";
};

class StructurePaneRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly boxes: StructureBox[]) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const { horizontalPixelRatio: hPR, verticalPixelRatio: vPR } = scope;
      ctx.save();
      ctx.font = `${Math.round(10 * vPR)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      for (const b of this.boxes) {
        if (b.x1 == null || b.x2 == null || b.y == null) continue;
        const x1 = Math.round(b.x1 * hPR);
        const x2 = Math.round(b.x2 * hPR);
        const y = Math.round(b.y * vPR);

        const color = b.kind === "BOS"
          ? (b.side === "up" ? theme.bull : theme.bear)
          : theme.warn;

        // The line itself — BOS solid, CHoCH dashed.
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(1.2 * vPR));
        ctx.setLineDash(b.kind === "CHoCH" ? [Math.round(4 * hPR), Math.round(3 * hPR)] : []);
        ctx.beginPath();
        ctx.moveTo(x1, y + 0.5);
        ctx.lineTo(x2, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // Label just past the break point.
        const label = b.kind === "BOS" ? "BOS" : "CHoCH";
        const textWidth = ctx.measureText(label).width;
        const padX = 4 * hPR;
        const padY = 3 * vPR;
        const textH = 10 * vPR;
        const boxX = x2 + 2 * hPR;
        const boxY = y - textH / 2 - padY;
        ctx.fillStyle = "rgba(11, 15, 26, 0.92)";
        ctx.fillRect(boxX, boxY, textWidth + padX * 2, textH + padY * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, textWidth + padX * 2 - 1, textH + padY * 2 - 1);
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.fillText(label, boxX + padX, boxY + textH / 2 + padY);
      }
      ctx.restore();
    });
  }
}

class StructurePaneView implements IPrimitivePaneView {
  constructor(private readonly host: StructurePrimitive) {}
  renderer() {
    const chart = this.host.chart;
    const series = this.host.series;
    if (!chart || !series) return new StructurePaneRenderer([]);
    const timeScale = chart.timeScale();
    const boxes: StructureBox[] = this.host.marks.map((m) => ({
      x1: timeScale.timeToCoordinate(m.swingEpoch as UTCTimestamp),
      x2: timeScale.timeToCoordinate(m.breakEpoch as UTCTimestamp),
      y: series.priceToCoordinate(m.price),
      kind: m.kind,
      side: m.side,
    }));
    return new StructurePaneRenderer(boxes);
  }
}

class StructurePrimitive implements ISeriesPrimitive<Time> {
  public marks: StructureMark[];
  public chart: IChartApi | null = null;
  public series: ISeriesApi<"Candlestick"> | null = null;
  private view: StructurePaneView;

  constructor(marks: StructureMark[]) {
    this.marks = marks;
    this.view = new StructurePaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<"Candlestick">;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  updateAllViews() {
    // derived from marks directly
  }

  paneViews(): IPrimitivePaneView[] {
    return [this.view];
  }

  setMarks(marks: StructureMark[]) {
    this.marks = marks;
  }
}

// ---------------------------------------------------------------------------
// LiquidityPoolPrimitive — draws EQH / EQL horizontal lines with taps marks
// and an arrow at the sweep bar (if swept).
// ---------------------------------------------------------------------------

type PoolBox = {
  x1: Coordinate | null;
  xRight: Coordinate | null;
  xSwept: Coordinate | null;
  y: Coordinate | null;
  side: "EQH" | "EQL";
  taps: number;
  swept: boolean;
};

class LiquidityPoolPaneRenderer implements IPrimitivePaneRenderer {
  constructor(private readonly boxes: PoolBox[]) {}

  draw(target: Parameters<IPrimitivePaneRenderer["draw"]>[0]) {
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const { horizontalPixelRatio: hPR, verticalPixelRatio: vPR } = scope;
      ctx.save();
      ctx.font = `${Math.round(9 * vPR)}px -apple-system, "Segoe UI", Roboto, sans-serif`;
      for (const b of this.boxes) {
        if (b.x1 == null || b.xRight == null || b.y == null) continue;
        const x1 = Math.round(b.x1 * hPR);
        const x2 = Math.round(b.xRight * hPR);
        const y = Math.round(b.y * vPR);

        const color = b.side === "EQH"
          ? (b.swept ? theme.eqhLineSwept : theme.eqhLine)
          : (b.swept ? theme.eqlLineSwept : theme.eqlLine);

        // Dashed liquidity line spanning the pool's active range.
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(1, Math.round(1.2 * vPR));
        ctx.setLineDash([Math.round(6 * hPR), Math.round(4 * hPR)]);
        ctx.beginPath();
        ctx.moveTo(x1, y + 0.5);
        ctx.lineTo(x2, y + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrow at the sweep bar (if swept).
        if (b.swept && b.xSwept != null) {
          const xs = Math.round(b.xSwept * hPR);
          const size = Math.round(7 * vPR);
          ctx.fillStyle = color;
          ctx.beginPath();
          if (b.side === "EQH") {
            // Down-pointing arrow just above the line (bearish sweep).
            ctx.moveTo(xs - size, y - size);
            ctx.lineTo(xs + size, y - size);
            ctx.lineTo(xs, y);
          } else {
            // Up-pointing arrow just below the line (bullish sweep).
            ctx.moveTo(xs - size, y + size);
            ctx.lineTo(xs + size, y + size);
            ctx.lineTo(xs, y);
          }
          ctx.closePath();
          ctx.fill();
        }

        // Label at right edge: "EQH ×3" (taps count if > 2).
        const label = b.taps > 2 ? `${b.side} ×${b.taps}` : b.side;
        const textWidth = ctx.measureText(label).width;
        const padX = 4 * hPR;
        const padY = 2 * vPR;
        const textH = 9 * vPR;
        const boxX = x2 + 4 * hPR;
        const boxY = y - textH / 2 - padY;
        ctx.fillStyle = "rgba(11, 15, 26, 0.9)";
        ctx.fillRect(boxX, boxY, textWidth + padX * 2, textH + padY * 2);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.strokeRect(boxX + 0.5, boxY + 0.5, textWidth + padX * 2 - 1, textH + padY * 2 - 1);
        ctx.fillStyle = color;
        ctx.textBaseline = "middle";
        ctx.fillText(label, boxX + padX, boxY + textH / 2 + padY);
      }
      ctx.restore();
    });
  }
}

class LiquidityPoolPaneView implements IPrimitivePaneView {
  constructor(private readonly host: LiquidityPoolPrimitive) {}
  renderer() {
    const chart = this.host.chart;
    const series = this.host.series;
    if (!chart || !series) return new LiquidityPoolPaneRenderer([]);
    const timeScale = chart.timeScale();
    const rightEdge = this.host.rightEdgeEpoch;
    const boxes: PoolBox[] = this.host.pools.map((p) => ({
      x1: timeScale.timeToCoordinate(p.firstEpoch as UTCTimestamp),
      // Swept pool's line stops at sweep; active pool extends to the right edge.
      xRight: timeScale.timeToCoordinate((p.sweptEpoch ?? rightEdge) as UTCTimestamp),
      xSwept: p.sweptEpoch != null ? timeScale.timeToCoordinate(p.sweptEpoch as UTCTimestamp) : null,
      y: series.priceToCoordinate(p.price),
      side: p.side,
      taps: p.taps,
      swept: p.sweptEpoch != null,
    }));
    return new LiquidityPoolPaneRenderer(boxes);
  }
}

class LiquidityPoolPrimitive implements ISeriesPrimitive<Time> {
  public pools: LiquidityPool[];
  public rightEdgeEpoch: number = 0;
  public chart: IChartApi | null = null;
  public series: ISeriesApi<"Candlestick"> | null = null;
  private view: LiquidityPoolPaneView;

  constructor(pools: LiquidityPool[]) {
    this.pools = pools;
    this.view = new LiquidityPoolPaneView(this);
  }

  attached(param: SeriesAttachedParameter<Time>) {
    this.chart = param.chart;
    this.series = param.series as ISeriesApi<"Candlestick">;
  }

  detached() {
    this.chart = null;
    this.series = null;
  }

  updateAllViews() {
    // derived from pools directly
  }

  paneViews(): IPrimitivePaneView[] {
    return [this.view];
  }

  setPools(pools: LiquidityPool[], rightEdgeEpoch: number) {
    this.pools = pools;
    this.rightEdgeEpoch = rightEdgeEpoch;
  }
}

import type { Candle, DetectorDiagnostics, LiquidityPool, OrderBlock, Signal, StructureMark, SymbolCode } from "@shared/types";

export type DetectorContext = {
  symbol: SymbolCode;
  candles: Candle[];
  params: Record<string, number>;
  /** Opaque per-run state bag. Detectors should read/write arbitrary keys here. */
  state: Record<string, unknown>;
};

export type DetectorOutput = {
  signals: Signal[];
  orderBlocks?: OrderBlock[];
  mitigatedBlockIds?: string[];
  structureMarks?: StructureMark[];
  liquidityPools?: LiquidityPool[];
  liquidityPoolsSwept?: Array<{ id: string; sweptEpoch: number }>;
  liquidityPoolsRemoved?: string[];
  diagnostics?: Omit<DetectorDiagnostics, "symbol">;
};

export type Detector = {
  id: string;
  label: string;
  defaultParams: Record<string, number>;
  /**
   * Called whenever a new candle closes. Implementations should read the full
   * candle history from ctx.candles and emit any signals / overlays triggered
   * by the newly-closed bar (ctx.candles[ctx.candles.length - 1]).
   * Any state that must persist between calls (e.g. active order blocks)
   * must live inside ctx.state.
   */
  onClose(ctx: DetectorContext): DetectorOutput;
};

import { ATR, ADX } from "technicalindicators";
import type { Candle } from "@shared/types";

export function atrSeries(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  return ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
}

export function latestAtr(candles: Candle[], period = 14): number {
  const s = atrSeries(candles, period);
  return s[s.length - 1] ?? 0;
}

export function adxSeries(candles: Candle[], period = 14): Array<{ adx: number; pdi: number; mdi: number }> {
  if (candles.length < period * 2) return [];
  const out = ADX.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  return out as Array<{ adx: number; pdi: number; mdi: number }>;
}

export type RegimeSample = {
  adx: number;
  pdi: number;
  mdi: number;
  trending: boolean;
  direction: "up" | "down" | "flat";
};

export function latestRegime(candles: Candle[], adxThreshold = 22, period = 14): RegimeSample {
  const s = adxSeries(candles, period);
  const last = s[s.length - 1];
  if (!last) return { adx: 0, pdi: 0, mdi: 0, trending: false, direction: "flat" };
  return {
    adx: last.adx,
    pdi: last.pdi,
    mdi: last.mdi,
    trending: last.adx >= adxThreshold,
    direction: last.pdi > last.mdi ? "up" : last.pdi < last.mdi ? "down" : "flat",
  };
}

export type Swing = {
  kind: "high" | "low";
  index: number;
  epoch: number;
  price: number;
};

/**
 * Confirmed-swing detector. A swing high at index i is a bar whose high is
 * strictly greater than the N bars on each side; swing low analogously. Bars
 * within `right` of the end of the array are still pending confirmation.
 */
export function detectSwings(candles: Candle[], left = 3, right = 3): Swing[] {
  const swings: Swing[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= c.high) isHigh = false;
      if (candles[j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) swings.push({ kind: "high", index: i, epoch: c.epoch, price: c.high });
    else if (isLow) swings.push({ kind: "low", index: i, epoch: c.epoch, price: c.low });
  }
  return swings;
}

import type { Candle } from "@shared/types";

export class CandleBuffer {
  private candles: Candle[] = [];

  constructor(private readonly maxSize = 2000) {}

  seed(initial: Candle[]) {
    this.candles = [...initial].sort((a, b) => a.epoch - b.epoch);
    this.trim();
  }

  /** Append or update the latest candle. Returns true if a new bar was added. */
  push(c: Candle): boolean {
    const last = this.candles[this.candles.length - 1];
    if (last && last.epoch === c.epoch) {
      this.candles[this.candles.length - 1] = c;
      return false;
    }
    this.candles.push(c);
    this.trim();
    return true;
  }

  get all(): Candle[] {
    return this.candles;
  }

  last(): Candle | undefined {
    return this.candles[this.candles.length - 1];
  }

  closes(n?: number): number[] {
    const arr = this.candles.map((c) => c.close);
    return n ? arr.slice(-n) : arr;
  }

  slice(from: number, to?: number): Candle[] {
    return this.candles.slice(from, to);
  }

  length(): number {
    return this.candles.length;
  }

  private trim() {
    if (this.candles.length > this.maxSize) {
      this.candles.splice(0, this.candles.length - this.maxSize);
    }
  }
}

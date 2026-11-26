export const MINUTE_MS = 60_000;

/** A 1-minute OHLC bar in USD cents per coin. */
export interface Candle {
  coin: string;
  /** The minute it covers, at a whole UTC minute. */
  start: Date;
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
}

export function minuteStart(at: number): number {
  return at - (((at % MINUTE_MS) + MINUTE_MS) % MINUTE_MS);
}

/** Builds each coin's current 1-minute candle from ticks, in memory, on the leader. */
export class CandleBuilder {
  private readonly current = new Map<string, Candle>();

  /**
   * Adds a tick. Returns the coin's previous candle when this tick is the first of a new
   * minute: that candle is complete and goes to the database.
   */
  add(coin: string, price: bigint, at: number): Candle | undefined {
    const start = minuteStart(at);
    const candle = this.current.get(coin);
    if (candle && candle.start.getTime() === start) {
      if (price > candle.high) candle.high = price;
      if (price < candle.low) candle.low = price;
      candle.close = price;
      return undefined;
    }
    this.current.set(coin, {
      coin,
      start: new Date(start),
      open: price,
      high: price,
      low: price,
      close: price,
    });
    return candle;
  }

  /** The candles in progress, removed: written when the leader stops, so its last minute isn't lost. */
  drain(): Candle[] {
    const candles = [...this.current.values()];
    this.current.clear();
    return candles;
  }
}

/**
 * One candle per (coin, start), merged in order: the first open, the widest range, the last
 * close. An INSERT … ON CONFLICT can't touch the same row twice in one statement.
 */
export function mergeCandles(candles: Candle[]): Candle[] {
  const merged = new Map<string, Candle>();
  for (const candle of candles) {
    const key = `${candle.coin}@${candle.start.getTime()}`;
    const seen = merged.get(key);
    merged.set(
      key,
      seen
        ? {
            ...seen,
            high: candle.high > seen.high ? candle.high : seen.high,
            low: candle.low < seen.low ? candle.low : seen.low,
            close: candle.close,
          }
        : { ...candle },
    );
  }
  return [...merged.values()];
}

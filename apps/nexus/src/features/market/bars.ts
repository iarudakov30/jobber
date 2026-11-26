import type { CandleRow } from './market-api';

/** One chart bar: `time` in UTC seconds (the minute's start), prices in dollars. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

const dollars = (cents: string | number) => Number(cents) / 100;

/** The API's candles (cents, ISO start) as chart bars. */
export function toBars(candles: CandleRow[]): Bar[] {
  return candles.map((c) => ({
    time: Math.floor(Date.parse(c.start) / 1000),
    open: dollars(c.open),
    high: dollars(c.high),
    low: dollars(c.low),
    close: dollars(c.close),
  }));
}

/**
 * The bar a live tick makes: the last bar widened and closed at the tick if the tick is in its
 * minute, else a new bar for the tick's minute. A tick older than the last bar changes nothing.
 */
export function applyTick(
  last: Bar | undefined,
  tick: { price: string; at: number },
): Bar | undefined {
  const time = Math.floor(tick.at / 60_000) * 60;
  const price = dollars(tick.price);
  if (last && time < last.time) {
    return undefined;
  }
  if (last && time === last.time) {
    return {
      ...last,
      high: Math.max(last.high, price),
      low: Math.min(last.low, price),
      close: price,
    };
  }
  return { time, open: price, high: price, low: price, close: price };
}

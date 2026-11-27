import { Candle, MINUTE_MS } from './candle-builder';
import { SimulatedCoin, simulated } from './coins';
import { gaussian, mulberry32, seedFor } from './random';

/**
 * Generated history: one day of 1-minute candles per simulated coin, for the `BackfillCandles` job
 * (`GenerateCandles`). The live simulator only knows the days it ran; this fills the charts'
 * past with prices that look like the same market.
 *
 * Everything is a function of the coin and the day alone (not of `MARKET_SEED`, which differs
 * between replicas when unset), so any replica, any repeat, generates the same candles.
 *
 * Two levels:
 *
 * - **Daily anchors.** The price at 00:00 UTC of each day since `BACKFILL_EPOCH`, from a walk in
 *   log price that is pulled back towards the coin's start price (an Ornstein–Uhlenbeck process
 *   with the coin's daily volatility). A plain random walk would drift for years and put WISP at
 *   a thousandth of a cent or at millions; this keeps the past within the range the live market
 *   starts from.
 * - **Within the day.** A one-second Brownian bridge from that day's anchor to the next day's,
 *   with the coin's volatility, so the day moves like the live market and its last second meets
 *   the next day's first.
 */

/** The first day that can be generated. */
export const BACKFILL_EPOCH = '2020-01-01';
const EPOCH_MS = Date.UTC(2020, 0, 1);
const DAY_MS = 86_400_000;
const SECONDS_PER_DAY = 86_400;
/** Fixed, unlike `MARKET_SEED`: generated history is the same on every replica. */
const BACKFILL_SEED = 20_200_101;
/** How fast the daily anchor returns to the start price: about 5% of the gap a day. */
const REVERSION_PER_DAY = 0.05;

export class BackfillDayError extends Error {
  override readonly name = 'BackfillDayError';
}

/**
 * The day's index since `BACKFILL_EPOCH`, after checking `day` is a real UTC date from the epoch
 * to yesterday. Today and later are the live simulator's.
 */
export function backfillDayIndex(day: string, now = Date.now()): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const ms = match
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : NaN;
  if (!match || new Date(ms).toISOString().slice(0, 10) !== day) {
    throw new BackfillDayError('day must be a date: YYYY-MM-DD');
  }
  if (ms < EPOCH_MS) {
    throw new BackfillDayError(`day must be ${BACKFILL_EPOCH} or later`);
  }
  if (ms >= Math.floor(now / DAY_MS) * DAY_MS) {
    throw new BackfillDayError(
      'day must be before today (UTC): today belongs to the live simulator',
    );
  }
  return (ms - EPOCH_MS) / DAY_MS;
}

/** Log prices of each coin's daily anchors, extended as later days are asked for. */
const anchorCache = new Map<SimulatedCoin, number[]>();

/** The log price at 00:00 UTC of day `index` (days since the epoch). */
export function anchorLogPrice(coin: SimulatedCoin, index: number): number {
  const { initialPrice, sigma } = simulated(coin);
  const home = Math.log(initialPrice);
  let anchors = anchorCache.get(coin);
  if (!anchors) {
    anchors = [home];
    anchorCache.set(coin, anchors);
  }
  if (anchors.length <= index) {
    // One stream per coin, read in order: anchor n always uses the n-th pair of draws.
    const random = mulberry32(seedFor(BACKFILL_SEED, `anchor:${coin}`));
    for (let i = 1; i < anchors.length; i++) {
      gaussian(random);
    }
    for (let i = anchors.length; i <= index; i++) {
      const previous = anchors[i - 1];
      anchors.push(
        previous +
          REVERSION_PER_DAY * (home - previous) +
          sigma * gaussian(random),
      );
    }
  }
  return anchors[index];
}

/** 1,440 candles for `coin` on `day` (`YYYY-MM-DD`, UTC), oldest first. */
export function generateDay(
  coin: SimulatedCoin,
  day: string,
  now = Date.now(),
): Candle[] {
  const index = backfillDayIndex(day, now);
  const from = anchorLogPrice(coin, index);
  const to = anchorLogPrice(coin, index + 1);
  const random = mulberry32(seedFor(BACKFILL_SEED, `${coin}:${day}`));
  const vol = simulated(coin).sigma / Math.sqrt(SECONDS_PER_DAY);

  // A free walk W, then the bridge X_t = W_t − (t/T)·W_T + (t/T)·(to − from): it starts at 0,
  // ends at the next anchor, and moves like W in between.
  const walk = new Float64Array(SECONDS_PER_DAY + 1);
  for (let t = 1; t <= SECONDS_PER_DAY; t++) {
    walk[t] = walk[t - 1] + vol * gaussian(random);
  }
  const end = walk[SECONDS_PER_DAY];
  const cents = (t: number): bigint => {
    const share = t / SECONDS_PER_DAY;
    const log = from + walk[t] - share * end + share * (to - from);
    return BigInt(Math.max(1, Math.round(Math.exp(log))));
  };

  const dayStart = EPOCH_MS + index * DAY_MS;
  const candles: Candle[] = [];
  for (let minute = 0; minute < 1_440; minute++) {
    const first = minute * 60;
    const open = cents(first);
    let high = open;
    let low = open;
    let close = open;
    for (let t = first + 1; t < first + 60; t++) {
      close = cents(t);
      if (close > high) high = close;
      if (close < low) low = close;
    }
    candles.push({
      coin,
      start: new Date(dayStart + minute * MINUTE_MS),
      open,
      high,
      low,
      close,
    });
  }
  return candles;
}

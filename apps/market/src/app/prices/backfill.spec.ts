import {
  BACKFILL_EPOCH,
  BackfillDayError,
  anchorLogPrice,
  backfillDayIndex,
  backfillDayStart,
  generateDay,
} from './backfill';
import { SIMULATED_COINS, simulated } from './coins';

const NOW = Date.UTC(2026, 10, 26, 15, 0, 0);

describe('generateDay', () => {
  it('gives every replica and every repeat the same 1,440 candles of that UTC day', () => {
    const first = generateDay('NXC', '2026-11-20', NOW);
    const again = generateDay('NXC', '2026-11-20', NOW);

    expect(again).toEqual(first);
    expect(first).toHaveLength(1_440);
    expect(first[0].start).toEqual(new Date('2026-11-20T00:00:00Z'));
    expect(first[1_439].start).toEqual(new Date('2026-11-20T23:59:00Z'));
    first.forEach((candle, i) =>
      expect(candle.start.getTime()).toBe(
        first[0].start.getTime() + i * 60_000,
      ),
    );
    // Another day, another coin: other prices.
    expect(generateDay('NXC', '2026-11-19', NOW)[0].close).not.toBe(
      first[0].close,
    );
    expect(generateDay('BLIP', '2026-11-20', NOW)[0].close).not.toBe(
      first[0].close,
    );
  });

  it('makes real candles that move, for every coin', () => {
    for (const coin of SIMULATED_COINS) {
      const day = generateDay(coin, '2025-06-01', NOW);
      for (const { open, high, low, close } of day) {
        expect(low).toBeGreaterThan(0n);
        expect(low <= open && low <= close).toBe(true);
        expect(high >= open && high >= close).toBe(true);
      }
      expect(new Set(day.map((c) => c.close)).size).toBeGreaterThan(50);
    }
  });

  it('joins one day to the next: the last minute closes where the next day opens', () => {
    for (const coin of SIMULATED_COINS) {
      const today = generateDay(coin, '2026-03-10', NOW);
      const tomorrow = generateDay(coin, '2026-03-11', NOW);
      const close = Number(today[1_439].close);
      const open = Number(tomorrow[0].open);
      // One second of movement at most, plus rounding to a cent.
      expect(Math.abs(close - open)).toBeLessThanOrEqual(
        Math.max(2, open * 0.01),
      );
    }
  });

  it('moves a day by about the coin’s daily volatility', () => {
    // Over 200 days, the open-to-close log change of a day has a spread close to sigma.
    for (const coin of ['NXC', 'WISP'] as const) {
      const changes: number[] = [];
      for (let d = 0; d < 200; d++) {
        const day = new Date(Date.UTC(2024, 0, 1) + d * 86_400_000)
          .toISOString()
          .slice(0, 10);
        const candles = generateDay(coin, day, NOW);
        changes.push(
          Math.log(Number(candles[1_439].close) / Number(candles[0].open)),
        );
      }
      const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
      const sd = Math.sqrt(
        changes.reduce((a, b) => a + (b - mean) ** 2, 0) / (changes.length - 1),
      );
      expect(sd).toBeGreaterThan(simulated(coin).sigma * 0.75);
      expect(sd).toBeLessThan(simulated(coin).sigma * 1.25);
    }
  });
});

describe('daily anchors', () => {
  it('stay within the range the live market starts from, over years', () => {
    for (const coin of SIMULATED_COINS) {
      const { initialPrice, sigma } = simulated(coin);
      // Stationary spread of the anchor's log price: sigma / sqrt(2θ − θ²), θ = 0.05.
      const spread = sigma / Math.sqrt(2 * 0.05 - 0.05 ** 2);
      for (let day = 0; day < 2_500; day += 7) {
        expect(
          Math.abs(anchorLogPrice(coin, day) - Math.log(initialPrice)),
        ).toBeLessThan(5 * spread);
      }
    }
  });

  it('don’t depend on which days were asked for first', () => {
    let isolated: number[] = [];
    jest.isolateModules(() => {
      // A fresh cache: ask for a late day first, then early ones.
      const fresh = jest.requireActual(
        './backfill',
      ) as typeof import('./backfill');
      fresh.anchorLogPrice('ORB', 900);
      isolated = [3, 300, 899, 900].map((d) => fresh.anchorLogPrice('ORB', d));
    });
    expect(isolated).toEqual(
      [3, 300, 899, 900].map((d) => anchorLogPrice('ORB', d)),
    );
  });
});

describe('backfillDayIndex', () => {
  it('counts days from the epoch', () => {
    expect(backfillDayIndex(BACKFILL_EPOCH, NOW)).toBe(0);
    expect(backfillDayIndex('2020-01-31', NOW)).toBe(30);
    expect(backfillDayIndex('2026-11-25', NOW)).toBe(2_520);
  });

  it.each([
    ['20261125', 'day must be a date: YYYY-MM-DD'],
    ['2026-02-30', 'day must be a date: YYYY-MM-DD'],
    ['2026-11-25T00:00:00Z', 'day must be a date: YYYY-MM-DD'],
    ['', 'day must be a date: YYYY-MM-DD'],
    ['2019-12-31', 'day must be 2020-01-01 or later'],
    [
      '2026-11-26',
      'day must be before today (UTC): today belongs to the live simulator',
    ],
    [
      '2027-01-01',
      'day must be before today (UTC): today belongs to the live simulator',
    ],
  ])('refuses %p', (day, message) => {
    expect(() => backfillDayIndex(day, NOW)).toThrow(
      new BackfillDayError(message),
    );
  });
});

describe('backfillDayStart with today allowed (live coins)', () => {
  it('takes today and earlier days', () => {
    expect(backfillDayStart('2026-11-26', NOW, true)).toBe(
      Date.UTC(2026, 10, 26),
    );
    expect(backfillDayStart('2026-11-25', NOW, true)).toBe(
      Date.UTC(2026, 10, 25),
    );
  });

  it.each([
    ['2026-11-27', 'day must not be after today (UTC)'],
    ['2019-12-31', 'day must be 2020-01-01 or later'],
    ['2026-02-30', 'day must be a date: YYYY-MM-DD'],
  ])('refuses %p', (day, message) => {
    expect(() => backfillDayStart(day, NOW, true)).toThrow(
      new BackfillDayError(message),
    );
  });
});

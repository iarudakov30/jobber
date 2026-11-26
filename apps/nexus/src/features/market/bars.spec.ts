import { applyTick, toBars } from './bars';

const MINUTE = Date.UTC(2026, 10, 26, 12, 0);

describe('chart bars', () => {
  it('turns candles in cents into bars in dollars, by the minute in seconds', () => {
    expect(
      toBars([
        {
          start: new Date(MINUTE).toISOString(),
          open: '4200',
          high: '4250',
          low: '4190',
          close: '4210',
        },
      ]),
    ).toEqual([
      { time: MINUTE / 1000, open: 42, high: 42.5, low: 41.9, close: 42.1 },
    ]);
  });

  it('widens and closes the last bar with a tick in its minute', () => {
    const last = {
      time: MINUTE / 1000,
      open: 42,
      high: 42.5,
      low: 41.9,
      close: 42.1,
    };
    expect(applyTick(last, { price: '4300', at: MINUTE + 30_000 })).toEqual({
      ...last,
      high: 43,
      close: 43,
    });
    expect(applyTick(last, { price: '4100', at: MINUTE + 59_999 })).toEqual({
      ...last,
      low: 41,
      close: 41,
    });
  });

  it('starts the next bar with a tick in a later minute, and ignores an older one', () => {
    const last = {
      time: MINUTE / 1000,
      open: 42,
      high: 42,
      low: 42,
      close: 42,
    };
    expect(applyTick(last, { price: '4250', at: MINUTE + 60_000 })).toEqual({
      time: MINUTE / 1000 + 60,
      open: 42.5,
      high: 42.5,
      low: 42.5,
      close: 42.5,
    });
    expect(applyTick(last, { price: '4250', at: MINUTE - 1 })).toBeUndefined();
    expect(applyTick(undefined, { price: '100', at: MINUTE })?.open).toBe(1);
  });
});

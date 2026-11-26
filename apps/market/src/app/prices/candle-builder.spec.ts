import { CandleBuilder, mergeCandles, minuteStart } from './candle-builder';

const T0 = Date.UTC(2026, 10, 26, 12, 0, 0);
const sec = (s: number) => T0 + s * 1_000;

describe('CandleBuilder', () => {
  it('aggregates a minute of ticks and hands the candle over when the next minute starts', () => {
    const builder = new CandleBuilder();
    expect(builder.add('NXC', 100n, sec(0))).toBeUndefined();
    expect(builder.add('NXC', 105n, sec(10))).toBeUndefined();
    expect(builder.add('NXC', 97n, sec(30))).toBeUndefined();
    expect(builder.add('NXC', 101n, sec(59.999))).toBeUndefined();

    expect(builder.add('NXC', 102n, sec(60))).toEqual({
      coin: 'NXC',
      start: new Date(T0),
      open: 100n,
      high: 105n,
      low: 97n,
      close: 101n,
    });
    expect(builder.drain()).toEqual([
      {
        coin: 'NXC',
        start: new Date(sec(60)),
        open: 102n,
        high: 102n,
        low: 102n,
        close: 102n,
      },
    ]);
    expect(builder.drain()).toEqual([]);
  });

  it('keeps coins apart', () => {
    const builder = new CandleBuilder();
    builder.add('NXC', 100n, sec(1));
    builder.add('ORB', 9_000n, sec(2));
    builder.add('NXC', 110n, sec(3));
    expect(builder.add('ORB', 9_100n, sec(61))?.close).toBe(9_000n);
    expect(builder.add('NXC', 120n, sec(62))?.close).toBe(110n);
  });

  it('starts a fresh candle after a gap of several minutes', () => {
    const builder = new CandleBuilder();
    builder.add('NXC', 100n, sec(5));
    const finished = builder.add('NXC', 200n, sec(5 * 60 + 5));
    expect(finished?.start).toEqual(new Date(T0));
    expect(builder.drain()[0].start).toEqual(new Date(sec(300)));
  });

  it('puts a tick in the whole UTC minute it falls in', () => {
    expect(minuteStart(sec(59.5))).toBe(T0);
    expect(minuteStart(sec(60))).toBe(sec(60));
  });
});

describe('mergeCandles', () => {
  it('merges candles of the same coin and minute in order, and keeps others', () => {
    const start = new Date(T0);
    const merged = mergeCandles([
      { coin: 'NXC', start, open: 100n, high: 110n, low: 95n, close: 105n },
      { coin: 'ORB', start, open: 9n, high: 9n, low: 9n, close: 9n },
      { coin: 'NXC', start, open: 104n, high: 120n, low: 99n, close: 101n },
    ]);
    expect(merged).toEqual([
      { coin: 'NXC', start, open: 100n, high: 120n, low: 95n, close: 101n },
      { coin: 'ORB', start, open: 9n, high: 9n, low: 9n, close: 9n },
    ]);
  });
});

import { Logger } from '@nestjs/common';
import { Candle, MINUTE_MS } from '../candle-builder';
import { CandleStore } from '../candle.store';
import { LiveCoin } from '../coins';
import { PriceProvider, ProviderError } from '../providers/price-provider';
import { HistoryUnavailableError, LiveHistory } from './live-history';
import { LivePrices } from './live-prices';

// The decisions around the providers and the store, with both stubbed: which range is asked
// for, which provider answers, what is logged. The REST and SQL sides have their own tests
// (providers/*.spec.ts, backfill.api.spec.ts, live-prices.api.spec.ts).

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 28, 12, 30, 15);
const TO = Date.UTC(2026, 10, 28, 12, 30);
const FROM = TO - DAY_MS;

const candle = (coin: LiveCoin, start: number): Candle => ({
  coin,
  start: new Date(start),
  open: 100n,
  high: 100n,
  low: 100n,
  close: 100n,
});

/** Every minute of the window except `missing` (epoch ms), for each coin. */
function storeWithout(missing: number[]) {
  const inserted: Candle[] = [];
  const store = {
    range: async (coin: LiveCoin, from: Date, to: Date) => {
      const rows: Candle[] = [];
      for (let t = from.getTime(); t < to.getTime(); t += MINUTE_MS) {
        if (!missing.includes(t)) rows.push(candle(coin, t));
      }
      return rows;
    },
    insertMissing: async (rows: Candle[]) => {
      inserted.push(...rows);
      return rows.filter((r) => missing.includes(r.start.getTime())).length;
    },
  } as unknown as CandleStore;
  return { store, inserted };
}

function provider(
  name: 'binance' | 'coinbase',
  answer: (coin: LiveCoin, from: Date, to: Date) => Promise<Candle[]>,
) {
  const calls: { coin: LiveCoin; from: number; to: number }[] = [];
  const stub = {
    name,
    candles: (coin: LiveCoin, from: Date, to: Date) => {
      calls.push({ coin, from: from.getTime(), to: to.getTime() });
      return answer(coin, from, to);
    },
  } as unknown as PriceProvider;
  return { stub, calls };
}

/** Candles for every minute asked for. */
const everyMinute = async (coin: LiveCoin, from: Date, to: Date) => {
  const rows: Candle[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += MINUTE_MS) {
    rows.push(candle(coin, t));
  }
  return rows;
};

const live = (providers: PriceProvider[], enabled = true) =>
  ({ enabled, providers }) as unknown as LivePrices;

let log: jest.SpyInstance;
let warn: jest.SpyInstance;
beforeEach(() => {
  log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
  warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

describe('fillRecent', () => {
  it('asks nothing when no minute is missing, and says so once', async () => {
    const binance = provider('binance', everyMinute);
    const { store, inserted } = storeWithout([]);

    await new LiveHistory(live([binance.stub]), store).fillRecent(NOW);

    expect(binance.calls).toEqual([]);
    expect(inserted).toEqual([]);
    expect(log.mock.calls).toEqual([
      ['No minute of the last 24 h missing for BTC, ETH, HYPE, ZEC'],
    ]);
  });

  it('asks for one range, from the first missing minute to the last, up to the current minute', async () => {
    const gap = [FROM + 5 * MINUTE_MS, TO - 3 * MINUTE_MS, TO - MINUTE_MS];
    const binance = provider('binance', everyMinute);
    const { store } = storeWithout(gap);

    await new LiveHistory(live([binance.stub]), store).fillRecent(NOW);

    expect(binance.calls.map((c) => c.coin)).toEqual([
      'BTC',
      'ETH',
      'HYPE',
      'ZEC',
    ]);
    for (const call of binance.calls) {
      expect(call).toMatchObject({ from: gap[0], to: TO });
    }
    expect(log).toHaveBeenCalledWith(
      'BTC: filled 3 of 3 missing minute(s) of the last 24 h from binance',
    );
  });

  it('takes the next provider when one refuses, and only logs when all do', async () => {
    const gap = [TO - MINUTE_MS];
    const binance = provider('binance', async () => {
      throw new ProviderError('binance', 'HTTP 451', 451);
    });
    const coinbase = provider('coinbase', async (coin, from, to) =>
      coin === 'ZEC'
        ? Promise.reject(new ProviderError('coinbase', 'HTTP 429', 429))
        : everyMinute(coin, from, to),
    );
    const { store } = storeWithout(gap);

    await expect(
      new LiveHistory(live([binance.stub, coinbase.stub]), store).fillRecent(
        NOW,
      ),
    ).resolves.toBeUndefined();

    expect(log).toHaveBeenCalledWith(
      'ETH: filled 1 of 1 missing minute(s) of the last 24 h from coinbase',
    );
    expect(warn).toHaveBeenCalledWith(
      "ZEC: the last 24 h weren't filled: no exchange gave ZEC's candles: binance: HTTP 451; coinbase: HTTP 429",
    );
  });

  it('runs one fill at a time', async () => {
    let release: () => void = () => undefined;
    const binance = provider(
      'binance',
      (coin, from, to) =>
        new Promise((resolve) => {
          release = () => resolve(everyMinute(coin, from, to));
        }),
    );
    const { store } = storeWithout([TO - MINUTE_MS]);
    const history = new LiveHistory(live([binance.stub]), store);

    const first = history.fillRecent(NOW);
    const second = history.fillRecent(NOW);
    expect(second).toBe(first);
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      release();
    }
    await first;
    expect(binance.calls).toHaveLength(4);
  });

  it('does nothing while live prices are off', async () => {
    const binance = provider('binance', everyMinute);
    const { store } = storeWithout([TO - MINUTE_MS]);

    await new LiveHistory(live([binance.stub], false), store).fillRecent(NOW);

    expect(binance.calls).toEqual([]);
  });
});

describe('loadDay', () => {
  it('stops today at the last completed minute', async () => {
    const binance = provider('binance', everyMinute);
    const { store } = storeWithout([]);

    const loaded = await new LiveHistory(live([binance.stub]), store).loadDay(
      'BTC',
      '2026-11-28',
      NOW,
    );

    expect(binance.calls).toEqual([
      { coin: 'BTC', from: Date.UTC(2026, 10, 28), to: TO },
    ]);
    expect(loaded).toEqual({
      written: 0,
      candles: 12 * 60 + 30,
      provider: 'binance',
    });
  });

  it('throws HistoryUnavailableError when every provider refuses', async () => {
    const refuse = async () => {
      throw new ProviderError('binance', 'unreachable');
    };
    const { store } = storeWithout([]);

    await expect(
      new LiveHistory(live([provider('binance', refuse).stub]), store).loadDay(
        'ETH',
        '2026-11-27',
        NOW,
      ),
    ).rejects.toBeInstanceOf(HistoryUnavailableError);
  });
});

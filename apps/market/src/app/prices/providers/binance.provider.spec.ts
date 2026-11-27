import { FakeBinance, fakeDay } from '../../../testing/fake-exchanges';
import { sleep, waitFor } from '../../../testing/wait-for';
import { LIVE_COINS, LiveCoin } from '../coins';
import { BinanceProvider } from './binance.provider';
import { ProviderError, ProviderOptions } from './price-provider';

describe('BinanceProvider', () => {
  let fake: FakeBinance;
  let provider: BinanceProvider;
  let prices: { coin: LiveCoin; price: number; at: number }[];

  const options = (
    overrides: Partial<ProviderOptions> = {},
  ): ProviderOptions => ({
    wsUrl: fake.wsUrl,
    restUrl: fake.restUrl,
    aliveWindowMs: 500,
    stallTimeoutMs: 1_500,
    backoff: { minMs: 100, maxMs: 400 },
    ...overrides,
  });

  beforeEach(async () => {
    fake = await FakeBinance.start(100);
    provider = new BinanceProvider(options());
    prices = [];
  });

  afterEach(async () => {
    await provider.disconnect();
    await fake.stop();
  });

  const connect = () =>
    provider.connect(LIVE_COINS, (coin, price, at) =>
      prices.push({ coin, price, at }),
    );

  describe('stream', () => {
    it('opens one combined stream of mini-tickers and reports each symbol in cents', async () => {
      fake.setPrice('BTCUSDT', '60490.12');
      fake.setPrice('HYPEUSDT', '35.1');
      connect();

      await waitFor(
        () =>
          prices.some((p) => p.coin === 'BTC') &&
          prices.some((p) => p.coin === 'HYPE'),
        2_000,
        'BTC and HYPE',
      );
      expect(fake.streamQueries).toEqual([
        'btcusdt@miniTicker/ethusdt@miniTicker/hypeusdt@miniTicker/zecusdt@miniTicker',
      ]);
      const btc = prices.find((p) => p.coin === 'BTC');
      expect(btc?.price).toBeCloseTo(6049012, 6);
      expect(Math.abs((btc?.at ?? 0) - Date.now())).toBeLessThan(1_000);
      expect(prices.find((p) => p.coin === 'HYPE')?.price).toBeCloseTo(3510, 6);
      expect(prices.some((p) => p.coin === 'ETH' || p.coin === 'ZEC')).toBe(
        false,
      );
      expect(provider.alive).toBe(true);
    });

    it('is not alive when the stream goes quiet, and replaces the connection', async () => {
      fake.setPrice('ETHUSDT', '3000');
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');

      fake.mute();
      await waitFor(() => !provider.alive, 1_000, 'not alive');
      await waitFor(() => fake.connections === 2, 3_000, 'a second connection');
      fake.unmute();
      await waitFor(() => provider.alive, 2_000, 'alive again');
    });

    it('reconnects after a drop, backing off while refused', async () => {
      fake.setPrice('ZECUSDT', '510');
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');

      fake.refuse(451);
      fake.drop();
      await waitFor(() => fake.refused >= 3, 3_000, 'three refused attempts');
      expect(provider.alive).toBe(false);

      fake.accept();
      await waitFor(() => provider.alive, 2_000, 'alive again');
      expect(fake.streamQueries).toHaveLength(2);
    });

    it('reconnects at once on serverShutdown, without waiting out the backoff', async () => {
      await provider.disconnect();
      provider = new BinanceProvider(
        options({ backoff: { minMs: 10_000, maxMs: 10_000 } }),
      );
      fake.setPrice('BTCUSDT', '60000');
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');

      fake.shutdownNotice();

      await waitFor(
        () => fake.connections === 2,
        1_000,
        'a new connection at once',
      );
      await waitFor(() => provider.alive, 1_000, 'alive again');
    });

    it('ignores messages it cannot use', async () => {
      connect();
      await waitFor(() => fake.open === 1, 2_000, 'connected');
      const ticker = (data: object) =>
        JSON.stringify({
          stream: 'x',
          data: { e: '24hrMiniTicker', E: Date.now(), ...data },
        });
      fake.sendRaw('not json');
      fake.sendRaw(ticker({ s: 'DOGEUSDT', c: '0.1' }));
      fake.sendRaw(ticker({ s: 'BTCUSDT', c: '-5' }));
      fake.sendRaw(ticker({ s: 'BTCUSDT', c: '60000', E: 'now' }));
      fake.sendRaw(JSON.stringify({ result: null, id: 1 }));
      fake.setPrice('ETHUSDT', '3001.5');

      await waitFor(() => prices.length > 0, 1_000, 'a price');
      expect(prices[0]).toMatchObject({ coin: 'ETH', price: 300150 });
      expect(prices.every((p) => p.coin === 'ETH')).toBe(true);
    });

    it('stops for good on disconnect', async () => {
      fake.setPrice('BTCUSDT', '60000');
      connect();
      await waitFor(() => prices.length > 0, 2_000, 'a price');
      await provider.disconnect();
      const seen = prices.length;

      await sleep(500);
      expect(prices).toHaveLength(seen);
      expect(fake.open).toBe(0);
      expect(fake.connections).toBe(1);
    });
  });

  describe('candles', () => {
    const day = Date.parse('2026-11-25T00:00:00Z');
    const minute = 60_000;

    it('loads a day in two requests of 1,000, in cents, oldest first', async () => {
      fake.setCandles('BTCUSDT', fakeDay('2026-11-25', 60_000));

      const candles = await provider.candles(
        'BTC',
        new Date(day),
        new Date(day + 1_440 * minute),
      );

      expect(candles).toHaveLength(1_440);
      expect(candles[0]).toEqual({
        coin: 'BTC',
        start: new Date(day),
        open: 6_000_000n,
        high: 6_000_150n,
        low: 5_999_900n,
        close: 6_000_050n,
      });
      expect(candles[1_000].start).toEqual(new Date(day + 1_000 * minute));
      expect(fake.restRequests).toEqual([
        `/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${day}&endTime=${day + 1_440 * minute - 1}&limit=1000`,
        `/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${day + 1_000 * minute}&endTime=${day + 1_440 * minute - 1}&limit=1000`,
      ]);
    });

    it('keeps to the range and stops at the end of the data', async () => {
      fake.setCandles('ETHUSDT', fakeDay('2026-11-25', 3_000).slice(0, 20));

      const candles = await provider.candles(
        'ETH',
        new Date(day + 10 * minute + 1),
        new Date(day + 60 * minute),
      );

      expect(candles.map((c) => (c.start.getTime() - day) / minute)).toEqual([
        11, 12, 13, 14, 15, 16, 17, 18, 19,
      ]);
      expect(fake.restRequests).toHaveLength(1);
    });

    it('throws a ProviderError with the status when refused (451: a restricted region)', async () => {
      fake.failRest(451);

      const error = await provider
        .candles('BTC', new Date(day), new Date(day + minute))
        .catch((e) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ provider: 'binance', status: 451 });
      expect(error.message).toContain(
        'binance: GET /api/v3/klines?symbol=BTCUSDT',
      );
    });
  });
});

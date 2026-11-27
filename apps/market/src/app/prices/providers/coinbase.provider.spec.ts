import { FakeCoinbase, fakeDay } from '../../../testing/fake-exchanges';
import { sleep, waitFor } from '../../../testing/wait-for';
import { LIVE_COINS, LiveCoin } from '../coins';
import { CoinbaseProvider } from './coinbase.provider';
import { ProviderError } from './price-provider';

describe('CoinbaseProvider', () => {
  let fake: FakeCoinbase;
  let provider: CoinbaseProvider;
  let prices: { coin: LiveCoin; price: number; at: number }[];

  beforeEach(async () => {
    fake = await FakeCoinbase.start(100);
    provider = new CoinbaseProvider({
      wsUrl: fake.wsUrl,
      restUrl: fake.restUrl,
      aliveWindowMs: 500,
      stallTimeoutMs: 1_500,
      backoff: { minMs: 100, maxMs: 400 },
    });
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
    it('subscribes to ticker and heartbeat for every live coin and reports trades in cents', async () => {
      fake.setPrice('BTC-USD', '60510.855');
      connect();

      const [first] = await waitFor(
        () => prices.length > 0 && prices,
        2_000,
        'the first price',
      );
      expect(fake.subscriptions).toEqual([
        {
          type: 'subscribe',
          product_ids: ['BTC-USD', 'ETH-USD', 'HYPE-USD', 'ZEC-USD'],
          channels: ['ticker', 'heartbeat'],
        },
      ]);
      // The current ticker comes right after subscribing.
      expect(first.coin).toBe('BTC');
      expect(first.price).toBeCloseTo(6051085.5, 6);
      expect(Math.abs(first.at - Date.now())).toBeLessThan(1_000);

      fake.setPrice('ZEC-USD', '512.30');
      await waitFor(() => prices.find((p) => p.coin === 'ZEC'), 1_000, 'ZEC');
      expect(prices.map((p) => p.coin)).toEqual(['BTC', 'ZEC']);
    });

    it('stays alive on heartbeats with no trades, reporting them per coin; a connection gone quiet is not alive, then replaced', async () => {
      const beats: LiveCoin[] = [];
      provider.connect(
        LIVE_COINS,
        (coin, price, at) => prices.push({ coin, price, at }),
        (coin) => beats.push(coin),
      );
      await waitFor(() => provider.alive, 2_000, 'alive');
      fake.silence('ZEC-USD');
      await sleep(700); // longer than the alive window: heartbeats alone keep it alive
      expect(provider.alive).toBe(true);
      expect(prices).toEqual([]);
      const recent = beats.slice(-6);
      expect(new Set(recent)).toEqual(new Set(['BTC', 'ETH', 'HYPE']));

      fake.mute();
      await waitFor(() => !provider.alive, 1_000, 'not alive');
      // Nothing for the stall timeout: the provider drops the connection and opens another.
      await waitFor(() => fake.connections === 2, 3_000, 'a second connection');
      fake.unmute();
      await waitFor(() => provider.alive, 2_000, 'alive again');
      expect(fake.open).toBe(1);
    });

    it('reconnects and resubscribes after a drop, backing off while refused', async () => {
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');

      fake.refuse(503);
      fake.drop();
      await waitFor(() => !provider.alive, 1_000, 'not alive');
      await waitFor(() => fake.refused >= 3, 3_000, 'three refused attempts');
      expect(provider.alive).toBe(false);

      fake.accept();
      await waitFor(() => provider.alive, 2_000, 'alive again');
      expect(fake.subscriptions).toHaveLength(2);
      fake.setPrice('ETH-USD', '3012.40');
      await waitFor(() => prices.find((p) => p.coin === 'ETH'), 1_000, 'ETH');
    });

    it('ignores messages it cannot use', async () => {
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');
      const at = new Date().toISOString();
      fake.sendRaw('not json');
      fake.sendRaw(
        JSON.stringify({
          type: 'ticker',
          product_id: 'DOGE-USD',
          price: '0.1',
          time: at,
        }),
      );
      fake.sendRaw(
        JSON.stringify({
          type: 'ticker',
          product_id: 'BTC-USD',
          price: 'abc',
          time: at,
        }),
      );
      fake.sendRaw(
        JSON.stringify({
          type: 'ticker',
          product_id: 'BTC-USD',
          price: '0',
          time: at,
        }),
      );
      fake.sendRaw(
        JSON.stringify({
          type: 'ticker',
          product_id: 'BTC-USD',
          price: '1',
          time: 'soon',
        }),
      );
      fake.sendRaw(
        JSON.stringify({
          type: 'error',
          message: 'Failed to subscribe',
          reason: 'test',
        }),
      );
      fake.setPrice('HYPE-USD', '35.12');

      await waitFor(() => prices.length > 0, 1_000, 'a price');
      await sleep(200);
      expect(prices.map((p) => [p.coin, p.price])).toEqual([['HYPE', 3512]]);
      expect(provider.alive).toBe(true);
    });

    it('stops for good on disconnect', async () => {
      connect();
      await waitFor(() => provider.alive, 2_000, 'alive');
      await provider.disconnect();
      expect(provider.alive).toBe(false);

      fake.setPrice('BTC-USD', '60000');
      await sleep(600);
      expect(prices).toEqual([]);
      expect(fake.connections).toBe(1);
      expect(fake.open).toBe(0);
    });
  });

  describe('candles', () => {
    const day = Date.parse('2026-11-25T00:00:00Z');
    const minute = 60_000;

    it('loads a day in five requests of 300, in cents, oldest first', async () => {
      fake.setCandles('BTC-USD', fakeDay('2026-11-25', 60_000));

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
      expect(candles[1_439].start).toEqual(new Date(day + 1_439 * minute));
      const starts = candles.map((c) => c.start.getTime());
      expect(starts).toEqual([...starts].sort((a, b) => a - b));
      expect(fake.restRequests).toHaveLength(5);
      expect(fake.restRequests[0]).toBe(
        '/products/BTC-USD/candles?granularity=60&start=2026-11-25T00%3A00%3A00.000Z&end=2026-11-25T04%3A59%3A00.000Z',
      );
    });

    it('keeps to the range: whole minutes from `from`, before `to`', async () => {
      fake.setCandles('ETH-USD', fakeDay('2026-11-25', 3_000));

      const candles = await provider.candles(
        'ETH',
        new Date(day + 10 * minute + 30_000),
        new Date(day + 15 * minute),
      );

      expect(candles.map((c) => (c.start.getTime() - day) / minute)).toEqual([
        11, 12, 13, 14,
      ]);
    });

    it('skips candles the table would refuse', async () => {
      const [good, bad] = fakeDay('2026-11-25', 100);
      fake.setCandles('ZEC-USD', [good, { ...bad, low: '200.00' }]);

      const candles = await provider.candles(
        'ZEC',
        new Date(day),
        new Date(day + 2 * minute),
      );

      expect(candles.map((c) => c.start)).toEqual([new Date(day)]);
    });

    it('throws a ProviderError with the status when refused', async () => {
      fake.failRest(429);

      const error = await provider
        .candles('BTC', new Date(day), new Date(day + minute))
        .catch((e) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ provider: 'coinbase', status: 429 });
    });

    it('throws a ProviderError when the exchange is unreachable', async () => {
      const unreachable = new CoinbaseProvider({
        wsUrl: fake.wsUrl,
        restUrl: 'http://127.0.0.1:9', // discard: nothing listens
        requestTimeoutMs: 2_000,
      });

      const error = await unreachable
        .candles('BTC', new Date(day), new Date(day + minute))
        .catch((e) => e);

      expect(error).toBeInstanceOf(ProviderError);
      expect(error.status).toBeUndefined();
    });
  });
});

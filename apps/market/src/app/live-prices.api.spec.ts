import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ClientGrpcProxy,
  ClientProxyFactory,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { ChannelModel, connect } from 'amqplib';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import Redis from 'ioredis';
import { Observable, of, throwError } from 'rxjs';
import { GRPC_LOADER_OPTIONS, Packages, User } from '@jobber/grpc';
import {
  RabbitModule,
  REALTIME_EXCHANGE,
  RealtimePriceMessage,
} from '@jobber/rabbitmq';
import {
  FakeBinance,
  FakeCandle,
  FakeCoinbase,
  fakeCandles,
} from '../testing/fake-exchanges';
import { FakeWallet, WALLET_PROTO } from '../testing/fake-wallet';
import { TestDatabase, startTestDatabase } from '../testing/test-database';
import { TestRedis, startTestRedis } from '../testing/test-redis';
import { sleep, waitFor } from '../testing/wait-for';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { COIN_UNIT } from './market/pricing';
import { MarketModule } from './market/market.module';
import { STALE_PRICE_MS } from './market/market.service';
import { OrdersModule } from './orders/orders.module';
import { OrderRow, orders } from './orders/schema';
import { LIVE_COINS, LiveCoin, SIMULATED_COINS } from './prices/coins';
import {
  LIVE_PRICES_OPTIONS,
  LivePricesOptions,
} from './prices/live/live-prices';
import { SIMULATOR_SEED } from './prices/price-ticker';
import { ONE_MINUTE, candles } from './prices/schema';
import {
  DEFAULT_SIMULATOR_OPTIONS,
  SIMULATOR_OPTIONS,
} from './prices/simulator.service';
import { REDIS, RedisModule } from './redis/redis.module';
import { marketTopology } from './topology';

// Live prices end to end (phase 4.5, acceptance tests 2–6): one replica of the real app leads
// against Testcontainers PostgreSQL, Redis and RabbitMQ, with its providers pointed at the fake
// Coinbase and Binance (testing/fake-exchanges.ts) and orders settled by the fake wallet.
// Nothing reaches the internet. The windows are shortened: a price is stale after 2 s (10 s in
// production), failback waits 4 s (30 s), a connection is not alive after 1 s without a message
// (5 s). A test queue bound to `prices.#` receives what the realtime gateway would. Before the
// replica starts, the fakes get a day of BTC candles, for the fill a new leader does.

const STALE_MS = 2_000;
const FAILBACK_MS = 4_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

/** When the replica was started: it leads within a second or two. */
let startedAt: number;
/** The fake Coinbase's BTC candles, from 24 h 10 min before the start to 20 min after it. */
let coinbaseBtc: FakeCandle[];

let testDb: TestDatabase;
let redis: TestRedis;
let rabbit: StartedRabbitMQContainer;
let amqp: ChannelModel;
let coinbase: FakeCoinbase;
let binance: FakeBinance;
const wallet = new FakeWallet();
let app: INestApplication;
let url: string;
let walletClient: ClientGrpcProxy;

const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    const match = /^token-(\d+)$/.exec(token);
    return match
      ? of({ id: Number(match[1]), email: `user${match[1]}@example.com` })
      : throwError(() => new Error('bad token'));
  },
};
let lastUser = 0;
function newUser(): { id: number; token: string } {
  const id = ++lastUser;
  return { id, token: `token-${id}` };
}

// ---- ticks on RabbitMQ ------------------------------------------------------------------------

interface Received {
  message: RealtimePriceMessage;
  receivedAt: number;
}
const received: Received[] = [];
const ticksOf = (coin: string, since = 0) =>
  received.filter((r) => r.message.coin === coin && r.receivedAt >= since);
const lastTick = (coin: string) => ticksOf(coin).at(-1)?.message;

/** The longest wait between two ticks of `coin` from `since` to now. */
function longestGap(coin: string, since: number): number {
  const times = [
    since,
    ...ticksOf(coin, since).map((r) => r.receivedAt),
    Date.now(),
  ];
  return Math.max(...times.slice(1).map((t, i) => t - times[i]));
}

// ---- the exchanges -----------------------------------------------------------------------------

const BASE: Record<LiveCoin, string> = {
  BTC: '60000.00',
  ETH: '3000.00',
  HYPE: '35.00',
  ZEC: '500.00',
};
const coinbaseSymbol = (coin: LiveCoin) => `${coin}-USD`;
const binanceSymbol = (coin: LiveCoin) => `${coin}USDT`;

/** Both exchanges up, talking, at the base prices (Binance 0.02% higher). */
function healExchanges(): void {
  for (const fake of [coinbase, binance]) {
    fake.accept();
    fake.unmute();
  }
  for (const coin of LIVE_COINS) {
    coinbase.unsilence(coinbaseSymbol(coin));
    binance.unsilence(binanceSymbol(coin));
    coinbase.setPrice(coinbaseSymbol(coin), BASE[coin]);
    binance.setPrice(
      binanceSymbol(coin),
      (Number(BASE[coin]) * 1.0002).toFixed(2),
    );
  }
}

const allOn = (source: string) =>
  LIVE_COINS.every((coin) => lastTick(coin)?.source === source);

// ---- the replica -------------------------------------------------------------------------------

async function startReplica(): Promise<void> {
  walletClient = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      url: wallet.url,
      package: Packages.WALLET,
      protoPath: WALLET_PROTO,
      loader: GRPC_LOADER_OPTIONS,
    },
  }) as ClientGrpcProxy;
  const live: LivePricesOptions = {
    enabled: true,
    providers: ['coinbase', 'binance'],
    endpoints: {
      coinbase: { wsUrl: coinbase.wsUrl, restUrl: coinbase.restUrl },
      binance: { wsUrl: binance.wsUrl, restUrl: binance.restUrl },
    },
    connection: {
      aliveWindowMs: 1_000,
      stallTimeoutMs: 3_000,
      backoff: { minMs: 100, maxMs: 300 },
    },
    picker: { staleAfterMs: STALE_MS, failbackAfterMs: FAILBACK_MS },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      RedisModule,
      RabbitModule.forRoot({
        url: rabbit.getAmqpUrl(),
        topology: marketTopology(),
        minReconnectDelayMs: 100,
      }),
      MarketModule,
      OrdersModule,
      GraphQLModule.forRoot<ApolloDriverConfig>(graphQLOptions(true)),
    ],
  })
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    .overrideProvider(Packages.WALLET)
    .useValue(walletClient)
    .overrideProvider(SIMULATOR_SEED)
    .useValue(42)
    .overrideProvider(SIMULATOR_OPTIONS)
    .useValue(DEFAULT_SIMULATOR_OPTIONS)
    .overrideProvider(LIVE_PRICES_OPTIONS)
    .useValue(live)
    .compile();
  app = moduleRef.createNestApplication({ logger: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix('market');
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.listen(0);
  const redisClient = app.get<Redis>(REDIS);
  if (redisClient.status !== 'ready') {
    await new Promise((resolve) => redisClient.once('ready', resolve));
  }
  url = (await app.getUrl()).replace('[::1]', 'localhost');
}

beforeAll(async () => {
  [testDb, redis, rabbit, coinbase, binance] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    new RabbitMQContainer('rabbitmq:4-management')
      .withStartupTimeout(120_000)
      .start(),
    FakeCoinbase.start(200),
    FakeBinance.start(200),
    wallet.start(),
  ]);
  Object.assign(process.env, {
    DATABASE_URL: testDb.container.getConnectionUri(),
    REDIS_URL: redis.url,
    RABBITMQ_URL: rabbit.getAmqpUrl(),
    AUTH_GRPC_SERVICE_URL: 'localhost:1',
    WALLET_GRPC_SERVICE_URL: wallet.url,
  });

  amqp = await connect(rabbit.getAmqpUrl());
  const channel = await amqp.createChannel();
  await channel.assertExchange(REALTIME_EXCHANGE, 'topic', { durable: true });
  const { queue } = await channel.assertQueue('', { exclusive: true });
  await channel.bindQueue(queue, REALTIME_EXCHANGE, 'prices.#');
  await channel.consume(
    queue,
    (msg) => {
      if (msg) {
        received.push({
          message: JSON.parse(msg.content.toString()),
          receivedAt: Date.now(),
        });
      }
    },
    { noAck: true },
  );

  healExchanges();
  startedAt = Date.now();
  const firstMinute = Math.floor(startedAt / MINUTE_MS) * MINUTE_MS - DAY_MS;
  coinbaseBtc = fakeCandles(firstMinute - 10 * MINUTE_MS, 1_470, 61_000);
  coinbase.setCandles('BTC-USD', coinbaseBtc);
  binance.setCandles(
    'BTCUSDT',
    fakeCandles(firstMinute - 10 * MINUTE_MS, 1_470, 62_000),
  );
  // A minute an earlier leader built from its own ticks: the fill must leave it alone.
  await testDb.db.insert(candles).values({
    coin: 'BTC',
    interval: ONE_MINUTE,
    start: new Date(firstMinute + DAY_MS - 60 * MINUTE_MS),
    open: 1n,
    high: 3n,
    low: 1n,
    close: 2n,
  });
  await startReplica();
}, 180_000);

afterAll(async () => {
  await app?.close().catch(() => undefined);
  walletClient?.close();
  wallet.stop();
  await amqp?.close();
  await coinbase?.stop();
  await binance?.stop();
  redis?.client.disconnect();
  await testDb?.pool.end();
  await Promise.all([
    testDb?.container.stop(),
    redis?.container.stop(),
    rabbit?.stop(),
  ]);
});

beforeEach(async () => {
  healExchanges();
  await waitFor(
    () => allOn('coinbase'),
    FAILBACK_MS + 6_000,
    'every live coin on Coinbase',
  );
}, 20_000);

afterEach(() => {
  expect(wallet.checkBooks()).toEqual([]);
});

// ---- GraphQL ---------------------------------------------------------------------------------

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function gql<T>(
  token: string | null,
  query: string,
  variables?: Record<string, unknown>,
  key?: string,
): Promise<GqlResponse<T>> {
  const response = await fetch(`${url}/market`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `Authentication=${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return (await response.json()) as GqlResponse<T>;
}

function must<T>(response: GqlResponse<T>): T {
  expect(response.errors).toBeUndefined();
  return response.data as T;
}

async function quoteError(
  token: string,
  coin: string,
): Promise<string | undefined> {
  const response = await gql<unknown>(
    token,
    `mutation ($coin: String!) { quote(coin: $coin, side: BUY, qty: "100000") { id } }`,
    { coin },
  );
  return response.errors?.[0]?.extensions?.code;
}

async function placeLimitBuy(
  token: string,
  coin: string,
  limitPrice: bigint,
): Promise<string> {
  const response = await gql<{ placeOrder: { id: string; status: string } }>(
    token,
    `mutation ($input: PlaceOrderInput!) { placeOrder(input: $input) { id status } }`,
    {
      input: {
        type: 'LIMIT',
        coin,
        side: 'BUY',
        qty: (COIN_UNIT / 1_000n).toString(),
        limitPrice: limitPrice.toString(),
      },
    },
    randomUUID(),
  );
  const { placeOrder } = must(response);
  expect(placeOrder.status).toBe('OPEN');
  return placeOrder.id;
}

async function orderStatus(id: string): Promise<OrderRow> {
  const [row] = await testDb.db.select().from(orders).where(eq(orders.id, id));
  return row;
}

// ---- tests -----------------------------------------------------------------------------------

describe('live prices', () => {
  it('fills the last 24 h of missing live candles on becoming leader, from the preferred exchange (test 8)', async () => {
    // Every minute of the 24 h before the start (the one the leader started in is its own).
    const to = Math.floor(startedAt / MINUTE_MS) * MINUTE_MS;
    const from = to - DAY_MS + MINUTE_MS;
    const btc = () =>
      testDb.db
        .select()
        .from(candles)
        .where(
          and(
            eq(candles.coin, 'BTC'),
            gte(candles.start, new Date(from)),
            lt(candles.start, new Date(to)),
          ),
        )
        .orderBy(asc(candles.start));

    const stored = await waitFor(
      async () => {
        const rows = await btc();
        return rows.length === 1_439 && rows;
      },
      10_000,
      'the last 24 h of BTC candles',
    );

    const ticked = to - 60 * MINUTE_MS;
    const cents = (usd: string) => BigInt(Math.round(Number(usd) * 100));
    for (const row of stored) {
      const start = row.start.getTime();
      if (start === ticked) {
        expect([row.open, row.high, row.low, row.close]).toEqual([
          1n,
          3n,
          1n,
          2n,
        ]);
        continue;
      }
      const fake = coinbaseBtc.find((c) => c.start === start);
      expect(fake).toBeDefined();
      expect([row.open, row.high, row.low, row.close]).toEqual(
        [fake?.open, fake?.high, fake?.low, fake?.close].map((usd) =>
          cents(usd ?? '0'),
        ),
      );
    }
  });

  it('ticks the live coins once a second from Coinbase, in cents, next to the simulated ones', async () => {
    const since = Date.now();
    await sleep(3_200);

    for (const coin of LIVE_COINS) {
      const ticks = ticksOf(coin, since).map((r) => r.message);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(4);
      expect(ticks.every((t) => t.source === 'coinbase')).toBe(true);
    }
    expect(lastTick('BTC')?.price).toBe('6000000');
    expect(lastTick('HYPE')?.price).toBe('3500');
    for (const coin of SIMULATED_COINS) {
      expect(lastTick(coin)?.source).toBe('simulator');
    }

    const { coins } = must(
      await gql<{
        coins: {
          code: string;
          live: boolean;
          providers: string[];
          tick: { price: string; source: string } | null;
        }[];
      }>(null, '{ coins { code live providers tick { price source } } }'),
    );
    expect(coins.find((c) => c.code === 'ETH')).toEqual({
      code: 'ETH',
      live: true,
      providers: ['coinbase', 'binance'],
      tick: { price: '300000', source: 'coinbase' },
    });
    expect(coins.find((c) => c.code === 'NXC')?.providers).toEqual([]);
  });

  it('moves one silent coin to Binance, alone, with no repeated seq (test 2)', async () => {
    const silencedAt = Date.now();
    coinbase.silence('BTC-USD');

    await waitFor(
      () => lastTick('BTC')?.source === 'binance',
      STALE_MS + 5_000,
      'BTC from Binance',
    );
    const switchedAt = Date.now();
    await sleep(2_000);

    expect(switchedAt - silencedAt).toBeLessThan(STALE_MS + 2_500);
    const btc = ticksOf('BTC', silencedAt).map((r) => r.message);
    const seqs = btc.map((t) => t.seq);
    expect(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1])).toBe(true);
    expect(btc.at(-1)?.price).toBe('6001200'); // Binance's 60012.00
    expect(longestGap('BTC', silencedAt)).toBeLessThan(2_000);
    for (const coin of ['ETH', 'HYPE', 'ZEC'] as const) {
      expect(
        ticksOf(coin, silencedAt).every((r) => r.message.source === 'coinbase'),
      ).toBe(true);
    }
  });

  it('moves every live coin to Binance when Coinbase is gone, with no gap over 5 s (test 3)', async () => {
    const droppedAt = Date.now();
    coinbase.refuse(503);
    coinbase.drop();

    await waitFor(() => allOn('binance'), 5_000, 'every live coin on Binance');
    await sleep(3_000);

    for (const coin of LIVE_COINS) {
      expect(longestGap(coin, droppedAt)).toBeLessThan(2_000);
    }
    expect(coinbase.refused).toBeGreaterThan(3);
  });

  it('fails back once Coinbase is steadily healthy, not while it flaps (test 4)', async () => {
    coinbase.refuse(503);
    coinbase.drop();
    await waitFor(() => allOn('binance'), 5_000, 'every live coin on Binance');

    // Flapping: up 2 s, down 1.5 s, twice. Each time it would need 4 s.
    const flapStart = Date.now();
    for (let i = 0; i < 2; i++) {
      coinbase.accept();
      await sleep(2_000);
      coinbase.refuse(503);
      coinbase.drop();
      await sleep(1_500);
    }
    for (const coin of LIVE_COINS) {
      expect(
        ticksOf(coin, flapStart).every((r) => r.message.source === 'binance'),
      ).toBe(true);
    }

    // Steady: back on Coinbase after the failback window, not before.
    const steadyAt = Date.now();
    coinbase.accept();
    await waitFor(() => coinbase.open === 1, 2_000, 'Coinbase connected');
    await sleep(FAILBACK_MS - 1_000);
    expect(allOn('binance')).toBe(true);
    await waitFor(
      () => allOn('coinbase'),
      4_000,
      'every live coin back on Coinbase',
    );
    expect(Date.now() - steadyAt).toBeGreaterThanOrEqual(FAILBACK_MS);
  });

  it('gives no price when nobody is healthy: no ticks, no quotes, no fills (test 5)', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    coinbase.mute();
    binance.mute();
    const mutedAt = Date.now();

    // The providers' prices go stale and the live coins stop ticking.
    await sleep(STALE_MS + 2_000);
    const lastBtc = ticksOf('BTC').at(-1)?.receivedAt ?? 0;
    expect(lastBtc - mutedAt).toBeLessThan(STALE_MS + 1_500);
    // A limit buy above the last price would fill on the next tick, but there is none.
    const orderId = await placeLimitBuy(user.token, 'BTC', 7_000_000n);
    await sleep(2_000);
    for (const coin of LIVE_COINS) {
      expect(ticksOf(coin, lastBtc + 500)).toEqual([]);
    }
    expect(ticksOf('NXC', Date.now() - 1_500).length).toBeGreaterThan(0);
    expect((await orderStatus(orderId)).status).toBe('OPEN');

    // Once the last price is 10 s old, quotes refuse it.
    await waitFor(
      () => Date.now() - lastBtc > STALE_PRICE_MS + 200 && true,
      STALE_PRICE_MS + 2_000,
      'the last BTC price to be 10 s old',
    );
    expect(await quoteError(user.token, 'BTC')).toBe('PRICES_UNAVAILABLE');
    expect((await orderStatus(orderId)).status).toBe('OPEN');

    // Prices back: the order fills at its limit.
    healExchanges();
    await waitFor(
      async () => (await orderStatus(orderId)).status === 'FILLED',
      8_000,
      'the fill',
    ).catch(async () => {
      throw new Error(`order is ${(await orderStatus(orderId)).status}`);
    });
  }, 40_000);

  it('never publishes a single bad print or fills on it; a move confirmed by both is published and fills (test 6)', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    const orderId = await placeLimitBuy(user.token, 'BTC', 5_300_000n);
    const since = Date.now();

    // One Coinbase print 20% down, corrected at once.
    coinbase.setPrice('BTC-USD', '48000.00');
    coinbase.setPrice('BTC-USD', '60000.00');
    await sleep(3_000);

    const prices = ticksOf('BTC', since).map((r) => r.message.price);
    expect(prices.length).toBeGreaterThan(1);
    expect(prices.every((p) => p === '6000000')).toBe(true);
    expect((await orderStatus(orderId)).status).toBe('OPEN');

    // A real 12% fall, on both exchanges.
    const movedAt = Date.now();
    coinbase.setPrice('BTC-USD', '52800.00');
    binance.setPrice('BTCUSDT', '52810.00');

    await waitFor(
      () => lastTick('BTC')?.price === '5280000',
      2_500,
      'the confirmed move',
    );
    expect(ticksOf('BTC', movedAt).map((r) => r.message.source)).not.toContain(
      'binance',
    );
    const filled = await waitFor(
      async () => {
        const row = await orderStatus(orderId);
        return row.status === 'FILLED' && row;
      },
      5_000,
      'the fill',
    );
    expect(filled.fillPrice).toBe(5_300_000n);
  });
});

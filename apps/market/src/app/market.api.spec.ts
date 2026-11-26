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
import { ChannelModel, ConsumeMessage, connect } from 'amqplib';
import cookieParser from 'cookie-parser';
import { readFileSync, rmSync } from 'fs';
import Redis from 'ioredis';
import { tmpdir } from 'os';
import { join } from 'path';
import { Observable, of, throwError } from 'rxjs';
import { COINS } from '@jobber/money';
import { LIVE_COINS, SIMULATED_COINS } from './prices/coins';
import { GRPC_LOADER_OPTIONS, Packages, User } from '@jobber/grpc';
import {
  REALTIME_EXCHANGE,
  RabbitModule,
  RabbitPublisher,
  RealtimePriceMessage,
} from '@jobber/rabbitmq';
import { WALLET_PROTO } from '../testing/fake-wallet';
import { TestDatabase, startTestDatabase } from '../testing/test-database';
import { TestRedis, startTestRedis } from '../testing/test-redis';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { PricesUnavailableError } from './market/market.errors';
import { MarketModule } from './market/market.module';
import { OrdersModule } from './orders/orders.module';
import { MarketService, quoteKey } from './market/market.service';
import { COIN_UNIT, quoteAmounts } from './market/pricing';
import { CandleStore } from './prices/candle.store';
import { PriceStore } from './prices/price.store';
import { PriceTicker } from './prices/price-ticker';
import {
  DEFAULT_SIMULATOR_OPTIONS,
  LEADER_KEY,
  SIMULATOR_OPTIONS,
  SimulatorService,
} from './prices/simulator.service';
import { SIMULATOR_SEED } from './prices/price-ticker';
import { REDIS, RedisModule } from './redis/redis.module';
import { marketTopology } from './topology';

// The market service end to end: replicas of the real app against Testcontainers PostgreSQL,
// Redis and RabbitMQ, competing for the simulator lock with the production timings (5 s TTL,
// 2 s renewal, 1 s ticks). Only `auth` (gRPC) is faked; the wallet is never called here
// (orders are in orders.api.spec.ts). A test queue bound to `prices.#`
// receives what the realtime gateway will.

const schemaFile = join(tmpdir(), `market-schema-${process.pid}.gql`);

let testDb: TestDatabase;
let redis: TestRedis;
let rabbit: StartedRabbitMQContainer;
let amqp: ChannelModel;

// ---- auth ----------------------------------------------------------------------------------

const sessions = new Map<string, User>([
  ['token-1', { id: 1, email: 'user1@example.com' }],
]);
const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    const user = sessions.get(token);
    return user ? of(user) : throwError(() => new Error('bad token'));
  },
};

// ---- ticks on RabbitMQ ---------------------------------------------------------------------

interface Received {
  message: RealtimePriceMessage;
  routingKey: string;
  properties: ConsumeMessage['properties'];
  receivedAt: number;
}
const received: Received[] = [];

const ticksOf = (coin: string, since = 0) =>
  received.filter((r) => r.message.coin === coin && r.receivedAt >= since);

async function waitFor<T>(
  probe: () => T | undefined | false,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- replicas ------------------------------------------------------------------------------

interface Replica {
  name: string;
  app: INestApplication;
  url: string;
  simulator: SimulatorService;
}
const replicas: Replica[] = [];

async function startReplica(
  name: string,
  printSchema = false,
): Promise<Replica> {
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
      GraphQLModule.forRoot<ApolloDriverConfig>(
        graphQLOptions(printSchema ? schemaFile : true),
      ),
    ],
  })
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    // The real client needs the proto from the source tree (the build copies it elsewhere).
    .overrideProvider(Packages.WALLET)
    .useValue(walletClient())
    .overrideProvider(SIMULATOR_SEED)
    .useValue(42)
    .overrideProvider(SIMULATOR_OPTIONS)
    .useValue(DEFAULT_SIMULATOR_OPTIONS)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // What init() from @jobber/nestjs adds, minus the port and Swagger.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix('market');
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.listen(0);
  const replica = {
    name,
    app,
    url: (await app.getUrl()).replace('[::1]', 'localhost'),
    simulator: app.get(SimulatorService),
  };
  replicas.push(replica);
  return replica;
}

const walletClients: ClientGrpcProxy[] = [];
function walletClient(): ClientGrpcProxy {
  const client = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      url: 'localhost:1',
      package: Packages.WALLET,
      protoPath: WALLET_PROTO,
      loader: GRPC_LOADER_OPTIONS,
    },
  }) as ClientGrpcProxy;
  walletClients.push(client);
  return client;
}

const leaders = () => replicas.filter((r) => r.simulator.isLeader);

beforeAll(async () => {
  [testDb, redis, rabbit] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    new RabbitMQContainer('rabbitmq:4-management')
      // RabbitMQ boots slowly when several projects start one at once (nx affected).
      .withStartupTimeout(120_000)
      .start(),
  ]);
  Object.assign(process.env, {
    DATABASE_URL: testDb.container.getConnectionUri(),
    REDIS_URL: redis.url,
    RABBITMQ_URL: rabbit.getAmqpUrl(),
    AUTH_GRPC_SERVICE_URL: 'localhost:1',
    WALLET_GRPC_SERVICE_URL: 'localhost:1',
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
          routingKey: msg.fields.routingKey,
          properties: msg.properties,
          receivedAt: Date.now(),
        });
      }
    },
    { noAck: true },
  );

  await startReplica('a', true);
  await startReplica('b');
}, 180_000);

afterAll(async () => {
  for (const replica of replicas) {
    await replica.app.close().catch(() => undefined);
  }
  walletClients.forEach((client) => client.close());
  await amqp?.close();
  redis?.client.disconnect();
  await testDb?.pool.end();
  await Promise.all([
    testDb?.container.stop(),
    redis?.container.stop(),
    rabbit?.stop(),
  ]);
  rmSync(schemaFile, { force: true });
});

// ---- GraphQL -------------------------------------------------------------------------------

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function gql<T = Record<string, unknown>>(
  token: string | null,
  query: string,
  variables?: Record<string, unknown>,
  replica = replicas[0],
): Promise<GqlResponse<T>> {
  const response = await fetch(`${replica.url}/market`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `Authentication=${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

function must<T>(value: T | null | undefined): T {
  expect(value).toBeTruthy();
  return value as T;
}

// ---- the simulator -------------------------------------------------------------------------

describe('the simulator', () => {
  it('runs on exactly one replica, ticking every coin once a second', async () => {
    await waitFor(() => ticksOf('ORB').length >= 1, 10_000, 'the first tick');
    expect(leaders()).toHaveLength(1);
    expect(await redis.client.get(LEADER_KEY)).toBe(
      leaders()[0].simulator.instanceId,
    );

    const since = Date.now();
    await sleep(4_000);
    expect(leaders()).toHaveLength(1);
    for (const coin of SIMULATED_COINS) {
      const ticks = ticksOf(coin, since);
      // One a second, not two: the other replica isn't ticking.
      expect(ticks.length).toBeGreaterThanOrEqual(3);
      expect(ticks.length).toBeLessThanOrEqual(5);
      const seqs = ticks.map((t) => t.message.seq);
      seqs.forEach((seq, i) => i > 0 && expect(seq).toBe(seqs[i - 1] + 1));
    }
  });

  it('publishes ticks as short-lived, non-persistent messages on prices.<coin>', async () => {
    // Not the very last: the other coins of that tick may still be on their way.
    const [tick] = ticksOf('NXC').slice(-2);
    expect(tick.routingKey).toBe('prices.NXC');
    expect(tick.message).toEqual({
      type: 'price',
      coin: 'NXC',
      price: expect.stringMatching(/^[1-9]\d*$/),
      seq: expect.any(Number),
      at: expect.any(Number),
      source: 'simulator',
    });
    expect(tick.properties.expiration).toBe('5000');
    expect(tick.properties.deliveryMode).not.toBe(2);
    expect(tick.properties.messageId).toBe(`price-NXC-${tick.message.seq}`);
    // All simulated coins of one tick share its time; the live ones aren't the simulator's.
    const sameTick = received.filter((r) => r.message.at === tick.message.at);
    expect(sameTick.map((r) => r.message.coin).sort()).toEqual(
      [...SIMULATED_COINS].sort(),
    );
  });

  it('keeps the latest price of each coin in Redis', async () => {
    const latest = await replicas[0].app.get(PriceStore).latest();
    expect(latest.map((p) => p.coin)).toEqual(SIMULATED_COINS);
    for (const price of latest) {
      expect(price.source).toBe('simulator');
      expect(price.price).toBe(BigInt(Math.round(price.mid)));
      expect(Date.now() - price.at).toBeLessThan(3_000);
    }
  });
});

// ---- candles -------------------------------------------------------------------------------

describe('candles from ticks', () => {
  // A ticker of its own, driven with chosen times; the replicas' tickers keep running.
  function standaloneTicker(candleStore: CandleStore) {
    let seq = 0;
    const prices = {
      latest: async () => [],
      record: async (ticks: unknown[]) => ticks.map(() => ++seq),
    } as unknown as PriceStore;
    const publisher = {
      publish: async () => undefined,
    } as unknown as RabbitPublisher;
    return new PriceTicker(7, prices, candleStore, publisher);
  }

  async function candleRows(coin: string, from: Date) {
    const { rows } = await testDb.pool.query(
      `SELECT start, open::text, high::text, low::text, close::text FROM candles
        WHERE coin = $1 AND start >= $2 AND start < $2::timestamptz + interval '1 day' ORDER BY start`,
      [coin, from],
    );
    return rows as {
      start: Date;
      open: string;
      high: string;
      low: string;
      close: string;
    }[];
  }

  it('writes each finished minute, and the open one when leadership ends', async () => {
    const store = replicas[0].app.get(CandleStore);
    const ticker = standaloneTicker(store);
    const t0 = Date.UTC(2020, 0, 1, 0, 0, 0);
    const prices: string[] = [];
    for (let s = 0; s < 150; s++) {
      const messages = await ticker.tick(t0 + s * 1_000);
      prices.push(messages[0].price);
    }
    // 0:00 and 0:01 are complete; 0:02 is still open.
    let rows = await candleRows('NXC', new Date(t0));
    expect(rows.map((r) => r.start.getTime())).toEqual([t0, t0 + 60_000]);
    const minute = prices.slice(0, 60).map(BigInt);
    expect(rows[0]).toMatchObject({
      open: minute[0].toString(),
      close: minute[59].toString(),
      high: minute.reduce((a, b) => (b > a ? b : a)).toString(),
      low: minute.reduce((a, b) => (b < a ? b : a)).toString(),
    });

    await ticker.flush();
    rows = await candleRows('NXC', new Date(t0));
    expect(rows).toHaveLength(3);
    expect(rows[2].close).toBe(prices[149]);
    expect((await candleRows('WISP', new Date(t0))).length).toBe(3);
  });

  it('merges a minute written by two leaders into one candle', async () => {
    const store = replicas[0].app.get(CandleStore);
    const start = new Date(Date.UTC(2020, 0, 2, 0, 0, 0));
    await store.upsert([
      { coin: 'ORB', start, open: 100n, high: 120n, low: 90n, close: 110n },
    ]);
    await store.upsert([
      { coin: 'ORB', start, open: 111n, high: 115n, low: 80n, close: 105n },
    ]);
    expect(await candleRows('ORB', start)).toEqual([
      { start, open: '100', high: '120', low: '80', close: '105' },
    ]);
  });

  it('keeps finished candles while PostgreSQL refuses them and writes them later', async () => {
    const real = replicas[0].app.get(CandleStore);
    let down = true;
    const flaky = {
      upsert: (rows: Parameters<CandleStore['upsert']>[0]) =>
        down
          ? Promise.reject(new Error('connection refused'))
          : real.upsert(rows),
    } as CandleStore;
    const ticker = standaloneTicker(flaky);
    const t0 = Date.UTC(2020, 0, 3, 0, 0, 0);
    for (let s = 0; s < 125; s++) {
      await ticker.tick(t0 + s * 1_000);
    }
    expect(await candleRows('BLIP', new Date(t0))).toEqual([]);
    down = false;
    await ticker.tick(t0 + 125_000);
    expect(
      (await candleRows('BLIP', new Date(t0))).map((r) => r.start.getTime()),
    ).toEqual([t0, t0 + 60_000]);
  });
});

// ---- queries -------------------------------------------------------------------------------

const COINS_QUERY = `{ coins { code name live tick { price seq at source } open24h } }`;
const CANDLES_QUERY = `query ($coin: String!, $from: DateTime, $to: DateTime) {
  candles(coin: $coin, from: $from, to: $to) { start open high low close }
}`;

describe('coins', () => {
  it('lists every coin with its latest tick and the open 24 hours ago; live coins without a provider have none', async () => {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60_000 + 5 * 60_000);
    const minuteStart = new Date(
      dayAgo.getTime() - (dayAgo.getTime() % 60_000),
    );
    await replicas[0].app.get(CandleStore).upsert([
      {
        coin: 'BLIP',
        start: minuteStart,
        open: 1_111n,
        high: 1_200n,
        low: 1_000n,
        close: 1_150n,
      },
      {
        coin: 'BLIP',
        start: new Date(minuteStart.getTime() + 60_000),
        open: 2_222n,
        high: 2_222n,
        low: 2_222n,
        close: 2_222n,
      },
    ]);

    const { data, errors } = await gql<{
      coins: {
        code: string;
        name: string;
        live: boolean;
        tick: {
          price: string;
          seq: number;
          at: string;
          source: string;
        } | null;
        open24h: string | null;
      }[];
    }>(null, COINS_QUERY);
    expect(errors).toBeUndefined();
    const coins = must(data).coins;
    expect(coins.map((c) => c.code)).toEqual(COINS);
    expect(coins.map((c) => c.name)).toEqual([
      'Nexus Coin',
      'Blip',
      'Orb',
      'Wisp',
      'Bitcoin',
      'Ethereum',
      'Hyperliquid',
      'Zcash',
    ]);
    expect(coins.filter((c) => c.live).map((c) => c.code)).toEqual(LIVE_COINS);
    // No provider runs yet (phase 4.5 step 3): the real coins have no price.
    for (const coin of coins.filter((c) => c.live)) {
      expect(coin.tick).toBeNull();
    }
    const latest = await replicas[0].app.get(PriceStore).latest();
    for (const coin of coins.filter((c) => !c.live)) {
      const tick = must(coin.tick);
      expect(tick.source).toBe('simulator');
      expect(tick.price).toMatch(/^[1-9]\d*$/);
      // Read a moment apart, so within a tick or two of each other.
      const stored = must(latest.find((p) => p.coin === coin.code));
      expect(Math.abs(tick.seq - stored.seq)).toBeLessThanOrEqual(2);
    }
    expect(coins.find((c) => c.code === 'BLIP')?.open24h).toBe('1111');
  });
});

describe('candles', () => {
  it('returns the 1-minute candles in a range, oldest first', async () => {
    const store = replicas[0].app.get(CandleStore);
    const t0 = Date.UTC(2021, 5, 1, 10, 0, 0);
    await store.upsert(
      [2, 0, 1].map((i) => ({
        coin: 'WISP',
        start: new Date(t0 + i * 60_000),
        open: 300n + BigInt(i),
        high: 400n,
        low: 200n,
        close: 350n,
      })),
    );
    const { data, errors } = await gql<{
      candles: { start: string; open: string }[];
    }>(null, CANDLES_QUERY, {
      coin: 'WISP',
      from: new Date(t0).toISOString(),
      to: new Date(t0 + 2 * 60_000).toISOString(),
    });
    expect(errors).toBeUndefined();
    expect(must(data).candles).toEqual([
      {
        start: new Date(t0).toISOString(),
        open: '300',
        high: '400',
        low: '200',
        close: '350',
      },
      {
        start: new Date(t0 + 60_000).toISOString(),
        open: '301',
        high: '400',
        low: '200',
        close: '350',
      },
    ]);
  });

  it('defaults to the last 24 hours', async () => {
    const { data, errors } = await gql<{ candles: { open: string }[] }>(
      null,
      CANDLES_QUERY,
      {
        coin: 'BLIP',
      },
    );
    expect(errors).toBeUndefined();
    expect(
      must(data)
        .candles.map((c) => c.open)
        .slice(0, 2),
    ).toEqual(['1111', '2222']);
  });

  it.each([
    [{ coin: 'USD' }, 'coin must be one of: NXC, BLIP, ORB, WISP, BTC, ETH, HYPE, ZEC'],
    [
      { coin: 'NXC', from: '2021-01-02T00:00:00Z', to: '2021-01-01T00:00:00Z' },
      'from must be before to',
    ],
    [
      { coin: 'NXC', from: '2021-01-01T00:00:00Z', to: '2021-01-02T00:00:01Z' },
      'from must be at most 24 hours before to',
    ],
  ])('refuses %j', async (variables, message) => {
    const { errors } = await gql(null, CANDLES_QUERY, variables);
    expect(errors?.[0]).toMatchObject({
      message,
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });
});

// ---- quotes --------------------------------------------------------------------------------

const QUOTE = `mutation ($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {
  quote(coin: $coin, side: $side, qty: $qty) {
    id coin side qty price usdAmount fee total expiresAt
  }
}`;

interface QuoteResult {
  id: string;
  coin: string;
  side: string;
  qty: string;
  price: string;
  usdAmount: string;
  fee: string;
  total: string;
  expiresAt: string;
}

describe('quote', () => {
  /** A quote and the mid it was priced from: retried until no tick landed in between. */
  async function quoteAtKnownMid(side: 'BUY' | 'SELL', qty: string) {
    const prices = replicas[0].app.get(PriceStore);
    for (let attempt = 0; attempt < 10; attempt++) {
      const before = must(await prices.get('NXC'));
      const response = await gql<{ quote: QuoteResult }>('token-1', QUOTE, {
        coin: 'NXC',
        side,
        qty,
      });
      const after = must(await prices.get('NXC'));
      if (before.seq === after.seq) {
        return { response, mid: before.price };
      }
    }
    throw new Error('prices kept changing during the quote');
  }

  it.each(['BUY', 'SELL'] as const)(
    'prices a %s from the mid and keeps it in Redis for 10 s',
    async (side) => {
      const qty = (3n * COIN_UNIT + 12_345n).toString();
      const requested = Date.now();
      const { response, mid } = await quoteAtKnownMid(side, qty);
      expect(response.errors).toBeUndefined();
      const quote = must(response.data).quote;
      const expected = quoteAmounts(mid, side, BigInt(qty));
      expect(quote).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        coin: 'NXC',
        side,
        qty,
        price: expected.price.toString(),
        usdAmount: expected.usdAmount.toString(),
        fee: expected.fee.toString(),
        total: expected.total.toString(),
        expiresAt: expect.any(String),
      });
      const expiresAt = new Date(quote.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(requested + 10_000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10_000);

      const stored = JSON.parse(
        must(await redis.client.get(quoteKey(quote.id))),
      );
      expect(stored).toEqual({
        userId: 1,
        coin: 'NXC',
        side,
        qty,
        price: quote.price,
        usdAmount: quote.usdAmount,
        fee: quote.fee,
      });
      const ttl = await redis.client.pttl(quoteKey(quote.id));
      expect(ttl).toBeGreaterThan(9_000);
      expect(ttl).toBeLessThanOrEqual(10_000);
    },
  );

  it('needs a signed-in user', async () => {
    const { errors } = await gql(null, QUOTE, {
      coin: 'NXC',
      side: 'BUY',
      qty: '100',
    });
    expect(errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });

  it.each([
    [
      { coin: 'USD', side: 'BUY', qty: '100' },
      'coin must be one of: NXC, BLIP, ORB, WISP, BTC, ETH, HYPE, ZEC',
    ],
    [{ coin: 'NXC', side: 'BUY', qty: '0' }, 'qty must be positive'],
    [{ coin: 'NXC', side: 'BUY', qty: '-5' }, 'qty must be positive'],
    [
      {
        coin: 'NXC',
        side: 'SELL',
        qty: (1_000_000n * COIN_UNIT + 1n).toString(),
      },
      'qty must be at most 1,000,000 coins',
    ],
    [
      { coin: 'NXC', side: 'SELL', qty: '1' },
      'qty is too small: the trade is worth less than a cent',
    ],
  ])('refuses %j', async (variables, message) => {
    const { errors } = await gql('token-1', QUOTE, variables);
    expect(errors?.[0]).toMatchObject({
      message,
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('refuses a qty sent as a JSON number', async () => {
    const { errors } = await gql('token-1', QUOTE, {
      coin: 'NXC',
      side: 'BUY',
      qty: 100,
    });
    expect(errors?.[0].message).toContain('MinorUnits must be a string');
  });

  it('refuses to quote from a stale price', async () => {
    const service = replicas[0].app.get(MarketService);
    await expect(
      service.quote(1, 'NXC', 'BUY', COIN_UNIT, Date.now() + 11_000),
    ).rejects.toThrow(PricesUnavailableError);
  });
});

it('prints the schema that apps/market/schema.gql has committed', () => {
  const committed = readFileSync(join(__dirname, '../../schema.gql'), 'utf8');
  expect(readFileSync(schemaFile, 'utf8')).toBe(committed);
});

// ---- failover (acceptance test 13) ---------------------------------------------------------

describe('leader failover', () => {
  /** Every tick of the coin this test file received, numbered 1, 2, 3… with no gap or repeat. */
  function expectConsecutive(coin: string) {
    const seqs = ticksOf(coin).map((t) => t.message.seq);
    expect(seqs).toEqual(seqs.map((_, i) => seqs[0] + i));
  }

  function lastSeqs() {
    return new Map(
      SIMULATED_COINS.map((coin) => [
        coin,
        ticksOf(coin).slice(-1)[0]?.message.seq ?? 0,
      ]),
    );
  }

  it('hands over at once when the leader shuts down', async () => {
    const [leader] = leaders();
    const follower = must(
      replicas.find((r) => r !== leader && !r.simulator.isLeader),
    );
    await leader.app.close();
    replicas.splice(replicas.indexOf(leader), 1);
    // The old leader can send nothing more: its connections are closed.
    const closed = Date.now();
    const lastOld = ticksOf('NXC').slice(-1)[0].message.seq;

    await waitFor(
      () => follower.simulator.isLeader,
      3_000,
      'the follower to lead',
    );
    const first = await waitFor(
      () => ticksOf('NXC', closed)[0],
      3_000,
      'a tick from the new leader',
    );
    // Released at the start of the shutdown; the follower polls every 500 ms.
    expect(first.receivedAt - closed).toBeLessThan(1_000);
    // seq carries on from the old leader's, without a reset or a gap.
    expect(first.message.seq).toBe(lastOld + 1);
    expectConsecutive('NXC');
  });

  it('takes over within 5 s when the leader loses Redis, and the old leader stops', async () => {
    // A fresh follower, so there are two replicas again.
    await startReplica('c');
    const [leader] = leaders();
    const before = lastSeqs();
    const lastMid = must(await replicas[0].app.get(PriceStore).get('ORB')).mid;

    // Cut the leader off from Redis, as a network partition or a hung process would. It can't
    // renew, its key expires, and someone else takes it.
    const cutOff = Date.now();
    leader.app.get<Redis>(REDIS).disconnect(false);

    const follower = must(replicas.find((r) => r !== leader));
    await waitFor(
      () => follower.simulator.isLeader,
      6_000,
      'the follower to lead',
    );
    const tookOver = Date.now();
    // The key expires at most 5 s after the old leader's last renewal, which came before the
    // cut; the follower asked Redis when, and tried 20 ms after.
    expect(tookOver - cutOff).toBeLessThan(5_500);
    // The old leader gave up by itself before then (its lease runs out before the key).
    expect(leader.simulator.isLeader).toBe(false);

    const first = await waitFor(
      () => ticksOf('ORB', tookOver)[0],
      2_000,
      'a tick from the new leader',
    );
    // Nothing was lost or repeated: the new leader continues the old one's seq and price.
    expect(first.message.seq).toBeGreaterThan(before.get('ORB') ?? 0);
    expectConsecutive('ORB');
    const resumed = must(await follower.app.get(PriceStore).get('ORB')).mid;
    expect(Math.abs(resumed / lastMid - 1)).toBeLessThan(0.16);

    await sleep(2_000);
    expect(leaders()).toEqual([follower]);
  }, 30_000);
});

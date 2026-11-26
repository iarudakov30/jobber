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
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import Redis from 'ioredis';
import { Observable, of, throwError } from 'rxjs';
import { GRPC_LOADER_OPTIONS, Packages, User } from '@jobber/grpc';
import {
  DELAY_BUCKETS,
  DelayBucketSpec,
  RabbitModule,
  delayBucket,
} from '@jobber/rabbitmq';
import { FakeWallet, WALLET_PROTO } from '../testing/fake-wallet';
import { TestDatabase, startTestDatabase } from '../testing/test-database';
import { TestRedis, startTestRedis } from '../testing/test-redis';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { MarketModule } from './market/market.module';
import { COIN_UNIT, limitAmounts, quoteAmounts } from './market/pricing';
import { OrderMatcher } from './orders/order-matcher';
import { RECOVERY_OPTIONS, RecoveryOptions } from './orders/order-recovery';
import { OrdersModule } from './orders/orders.module';
import {
  ORDER_EXPIRY,
  ORDER_FAULTS,
  OrderFaults,
} from './orders/orders.service';
import { OrderRow, orders } from './orders/schema';
import { PriceStore } from './prices/price.store';
import { SIMULATOR_SEED } from './prices/price-ticker';
import {
  DEFAULT_SIMULATOR_OPTIONS,
  SIMULATOR_OPTIONS,
  SimulatorService,
} from './prices/simulator.service';
import { REDIS, RedisModule } from './redis/redis.module';
import { marketTopology } from './topology';

// Orders end to end: replicas of the real app against Testcontainers PostgreSQL, Redis and
// RabbitMQ, talking gRPC to a fake wallet (testing/fake-wallet.ts: the real proto and client,
// an in-memory ledger with the wallet's rules). `auth` is faked too. The simulator is off on
// these replicas: the tests set prices themselves (PriceStore for quotes, OrderMatcher.match for
// limit orders), except the last test, which checks that a leader's ticks fill orders.
// `delay.1m` is shortened to 2 s; recovery looks every 0.5 s for orders stuck for 2 s.

/** `delay.1m` takes 2 s here; the other buckets keep their TTL. */
const BUCKETS: DelayBucketSpec[] = DELAY_BUCKETS.map((b) =>
  b.name === 'delay.1m' ? { ...b, ttlMs: 2_000 } : b,
);
const RECOVERY: RecoveryOptions = { intervalMs: 500, staleMs: 2_000 };

let testDb: TestDatabase;
let redis: TestRedis;
let rabbit: StartedRabbitMQContainer;
const wallet = new FakeWallet();

// ---- auth: the cookie token-<n> is user n ---------------------------------------------------

const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    const match = /^token-(\d+)$/.exec(token);
    return match
      ? of({ id: Number(match[1]), email: `user${match[1]}@example.com` })
      : throwError(() => new Error('bad token'));
  },
};
let lastUser = 0;
/** A user of their own for each test, so balances don't leak between tests. */
function newUser(): { id: number; token: string } {
  const id = ++lastUser;
  return { id, token: `token-${id}` };
}

// ---- the crash hook (acceptance test 7) ------------------------------------------------------

/** What FAULT_CRASH_BEFORE_SETTLE does, without killing Jest: the request dies there. */
const faults: OrderFaults & { crashNext: boolean } = {
  crashNext: false,
  beforeSettle(order) {
    if (this.crashNext) {
      this.crashNext = false;
      throw new Error(`simulated crash before settling ${order.id}`);
    }
  },
};

// ---- replicas -------------------------------------------------------------------------------

interface Replica {
  name: string;
  app: INestApplication;
  url: string;
}
const replicas: Replica[] = [];
const walletClients: ClientGrpcProxy[] = [];

async function startReplica(
  name: string,
  { expiry = 'delay.24h', simulator = false } = {},
): Promise<Replica> {
  const client = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      url: wallet.url,
      package: Packages.WALLET,
      protoPath: WALLET_PROTO,
      loader: GRPC_LOADER_OPTIONS,
    },
  }) as ClientGrpcProxy;
  walletClients.push(client);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      RedisModule,
      RabbitModule.forRoot({
        url: rabbit.getAmqpUrl(),
        topology: marketTopology(BUCKETS),
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
    .useValue(client)
    .overrideProvider(SIMULATOR_SEED)
    .useValue(42)
    .overrideProvider(SIMULATOR_OPTIONS)
    .useValue({ ...DEFAULT_SIMULATOR_OPTIONS, enabled: simulator })
    .overrideProvider(ORDER_EXPIRY)
    .useValue(delayBucket(expiry, BUCKETS))
    .overrideProvider(ORDER_FAULTS)
    .useValue(faults)
    .overrideProvider(RECOVERY_OPTIONS)
    .useValue(RECOVERY)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  // What init() from @jobber/nestjs adds, minus the port and Swagger.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix('market');
  app.use(cookieParser());
  app.enableShutdownHooks();
  await app.listen(0);
  // Its Redis client connects in the background; the tests' first write mustn't beat it.
  const redisClient = app.get<Redis>(REDIS);
  if (redisClient.status !== 'ready') {
    await new Promise((resolve) => redisClient.once('ready', resolve));
  }
  const replica = {
    name,
    app,
    url: (await app.getUrl()).replace('[::1]', 'localhost'),
  };
  replicas.push(replica);
  return replica;
}

async function stopReplica(replica: Replica): Promise<void> {
  await replica.app.close();
  replicas.splice(replicas.indexOf(replica), 1);
}

beforeAll(async () => {
  [testDb, redis, rabbit] = await Promise.all([
    startTestDatabase(),
    startTestRedis(),
    new RabbitMQContainer('rabbitmq:4-management')
      // RabbitMQ boots slowly when several projects start one at once (nx affected).
      .withStartupTimeout(120_000)
      .start(),
    wallet.start(),
  ]);
  Object.assign(process.env, {
    DATABASE_URL: testDb.container.getConnectionUri(),
    REDIS_URL: redis.url,
    RABBITMQ_URL: rabbit.getAmqpUrl(),
    AUTH_GRPC_SERVICE_URL: 'localhost:1',
    WALLET_GRPC_SERVICE_URL: wallet.url,
  });
  await startReplica('a');
  await startReplica('b');
  // Its limit orders expire after 2 s (delay.1m, shortened).
  await startReplica('expiring', { expiry: 'delay.1m' });
}, 180_000);

afterAll(async () => {
  for (const replica of [...replicas]) {
    await replica.app.close().catch(() => undefined);
  }
  walletClients.forEach((client) => client.close());
  wallet.stop();
  redis?.client.disconnect();
  await testDb?.pool.end();
  await Promise.all([
    testDb?.container.stop(),
    redis?.container.stop(),
    rabbit?.stop(),
  ]);
});

afterEach(() => {
  expect(wallet.checkBooks()).toEqual([]);
});

// ---- helpers --------------------------------------------------------------------------------

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function gql<T = Record<string, unknown>>(
  token: string | null,
  query: string,
  variables?: Record<string, unknown>,
  { key, replica = replicas[0] }: { key?: string; replica?: Replica } = {},
): Promise<GqlResponse<T> & { replayed: boolean }> {
  const response = await fetch(`${replica.url}/market`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `Authentication=${token}` } : {}),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return {
    ...((await response.json()) as GqlResponse<T>),
    replayed: response.headers.get('idempotent-replayed') === 'true',
  };
}

interface OrderView {
  id: string;
  type: string;
  coin: string;
  side: string;
  qty: string;
  limitPrice: string | null;
  fillPrice: string | null;
  usdAmount: string;
  fee: string;
  total: string;
  status: string;
  reason: string | null;
  expiresAt: string | null;
}

const ORDER_FIELDS = `id type coin side qty limitPrice fillPrice usdAmount fee total status reason expiresAt`;
const PLACE = `mutation ($input: PlaceOrderInput!) { placeOrder(input: $input) { ${ORDER_FIELDS} } }`;
const CANCEL = `mutation ($id: ID!) { cancelOrder(id: $id) { ${ORDER_FIELDS} } }`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(50);
  }
}

function must<T>(response: GqlResponse<T>): T {
  expect(response.errors).toBeUndefined();
  return response.data as T;
}

const errorCode = (response: GqlResponse<unknown>) =>
  response.errors?.[0]?.extensions?.code;

async function row(id: string): Promise<OrderRow> {
  const [found] = await testDb.db
    .select()
    .from(orders)
    .where(eq(orders.id, id));
  return found;
}

const untilStatus = (id: string, status: string, timeoutMs = 8_000) =>
  waitFor(
    async () => {
      const current = await row(id);
      return current.status === status && current;
    },
    timeoutMs,
    `order ${id} to be ${status}`,
  );

/** Sets a coin's price as a tick would, so quotes see a fresh one. */
async function setPrice(coin: 'NXC' | 'BLIP' | 'ORB' | 'WISP', price: bigint) {
  await replicas[0].app
    .get(PriceStore)
    .record(
      [{ coin, price, mid: Number(price), source: 'simulator' }],
      Date.now(),
    );
}

async function quote(
  token: string,
  coin: string,
  side: 'BUY' | 'SELL',
  qty: bigint,
): Promise<{ id: string; total: string }> {
  const response = await gql<{ quote: { id: string; total: string } }>(
    token,
    `mutation ($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {
       quote(coin: $coin, side: $side, qty: $qty) { id total }
     }`,
    { coin, side, qty: qty.toString() },
  );
  return must(response).quote;
}

async function placeMarket(
  token: string,
  quoteId: string,
  key: string = randomUUID(),
  replica?: Replica,
) {
  return gql<{ placeOrder: OrderView }>(
    token,
    PLACE,
    { input: { type: 'MARKET', quoteId } },
    { key, replica },
  );
}

async function placeLimit(
  token: string,
  input: {
    coin: string;
    side: 'BUY' | 'SELL';
    qty: bigint;
    limitPrice: bigint;
  },
  { key = randomUUID(), replica }: { key?: string; replica?: Replica } = {},
) {
  return gql<{ placeOrder: OrderView }>(
    token,
    PLACE,
    {
      input: {
        type: 'LIMIT',
        coin: input.coin,
        side: input.side,
        qty: input.qty.toString(),
        limitPrice: input.limitPrice.toString(),
      },
    },
    { key, replica },
  );
}

/** What a tick at `price` does to `coin`'s open limit orders, on replica `replica`. */
function crossAt(coin: string, price: bigint, replica = replicas[0]) {
  return replica.app
    .get(OrderMatcher)
    .match(new Map([[coin, { low: price, high: price }]]));
}

const tradeOf = (id: string) => wallet.postings.get(`trade:${id}`);
const settleCalls = (id: string) =>
  wallet
    .callsOf('SettleTrade')
    .filter((r) => (r as { tradeId: string }).tradeId === id).length;

// ---- market orders --------------------------------------------------------------------------

describe('market orders (acceptance test 3)', () => {
  it('a buy moves balances by exactly the trade legs, and its quote works once', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    await setPrice('NXC', 4_200n);
    const qty = 2n * COIN_UNIT;
    const q = await quote(user.token, 'NXC', 'BUY', qty);
    const expected = quoteAmounts(4_200n, 'BUY', qty);

    const order = must(await placeMarket(user.token, q.id)).placeOrder;

    expect(order).toMatchObject({
      type: 'MARKET',
      coin: 'NXC',
      side: 'BUY',
      qty: qty.toString(),
      status: 'FILLED',
      fillPrice: '4209',
      usdAmount: '8418',
      fee: '43',
      total: '8461',
    });
    expect(expected.total).toBe(8_461n);
    const trade = tradeOf(order.id);
    expect(trade?.legs).toEqual([
      { account: `user:${user.id}:available`, asset: 'USD', amount: -8_461n },
      { account: 'market_maker', asset: 'USD', amount: 8_418n },
      { account: 'fees', asset: 'USD', amount: 43n },
      { account: 'market_maker', asset: 'NXC', amount: -qty },
      { account: `user:${user.id}:available`, asset: 'NXC', amount: qty },
    ]);
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 100_000n - 8_461n,
      held: 0n,
    });
    expect(wallet.balance(user.id, 'NXC').available).toBe(qty);
    expect((await row(order.id)).transactionId).toBe(trade?.transactionId);

    // The quote is used up: another order with it (a new key) gets nothing.
    const again = await placeMarket(user.token, q.id);
    expect(errorCode(again)).toBe('QUOTE_EXPIRED');
    expect(
      wallet
        .postingsOf('trade')
        .filter((p) => p.terms.includes(`"userId":${user.id},`)),
    ).toHaveLength(1);
  });

  it('a sell is the mirror, with the fee taken from the proceeds', async () => {
    const user = newUser();
    wallet.fund(user.id, 'ORB', 3n * COIN_UNIT);
    await setPrice('ORB', 31_000n);
    const qty = COIN_UNIT / 2n;
    const q = await quote(user.token, 'ORB', 'SELL', qty);
    const { price, usdAmount, fee, total } = quoteAmounts(31_000n, 'SELL', qty);

    const order = must(await placeMarket(user.token, q.id)).placeOrder;

    expect(order).toMatchObject({
      status: 'FILLED',
      fillPrice: price.toString(),
      usdAmount: usdAmount.toString(),
      fee: fee.toString(),
      total: total.toString(),
    });
    expect(tradeOf(order.id)?.legs).toEqual([
      { account: `user:${user.id}:available`, asset: 'ORB', amount: -qty },
      { account: 'market_maker', asset: 'ORB', amount: qty },
      { account: 'market_maker', asset: 'USD', amount: -usdAmount },
      { account: `user:${user.id}:available`, asset: 'USD', amount: total },
      { account: 'fees', asset: 'USD', amount: fee },
    ]);
    expect(wallet.balance(user.id, 'USD').available).toBe(total);
    expect(wallet.balance(user.id, 'ORB').available).toBe(3n * COIN_UNIT - qty);
  });

  it('a retry with the same Idempotency-Key returns the first order, not a second trade', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    await setPrice('NXC', 4_200n);
    const q = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);
    const key = randomUUID();

    const first = await placeMarket(user.token, q.id, key);
    const retry = await placeMarket(user.token, q.id, key, replicas[1]);

    expect(retry.replayed).toBe(true);
    expect(retry.data).toEqual(first.data);
    expect(settleCalls(must(first).placeOrder.id)).toBe(1);

    // The same key for another request is refused.
    const other = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);
    expect(errorCode(await placeMarket(user.token, other.id, key))).toBe(
      'UNPROCESSABLE_ENTITY',
    );
  });

  it("a quote is only its user's, and expires after 10 s", async () => {
    const owner = newUser();
    const other = newUser();
    wallet.fund(owner.id, 'USD', 100_000n);
    wallet.fund(other.id, 'USD', 100_000n);
    await setPrice('BLIP', 1_250n);
    const q = await quote(owner.token, 'BLIP', 'BUY', COIN_UNIT);

    // Someone else's attempt neither gets it nor uses it up.
    expect(errorCode(await placeMarket(other.token, q.id))).toBe(
      'QUOTE_EXPIRED',
    );
    expect(must(await placeMarket(owner.token, q.id)).placeOrder.status).toBe(
      'FILLED',
    );

    const late = await quote(owner.token, 'BLIP', 'BUY', COIN_UNIT);
    await sleep(10_100);
    expect(errorCode(await placeMarket(owner.token, late.id))).toBe(
      'QUOTE_EXPIRED',
    );
    expect(
      wallet
        .postingsOf('trade')
        .filter((p) => p.terms.includes(`"userId":${other.id},`)),
    ).toHaveLength(0);
  }, 30_000);

  it('without enough funds the order is REJECTED and nothing moves', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100n);
    await setPrice('NXC', 4_200n);
    const q = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);

    const order = must(await placeMarket(user.token, q.id)).placeOrder;

    expect(order.status).toBe('REJECTED');
    expect(order.reason).toBe('insufficient USD');
    expect(tradeOf(order.id)).toBeUndefined();
    expect(wallet.balance(user.id, 'USD').available).toBe(100n);
  });

  it("settles once when the wallet's answer is lost: the retry is a duplicate", async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    await setPrice('NXC', 4_200n);
    const q = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);
    wallet.fail('SettleTrade', 'after');

    const order = must(await placeMarket(user.token, q.id)).placeOrder;

    expect(order.status).toBe('FILLED');
    expect(settleCalls(order.id)).toBe(2);
    expect(wallet.balance(user.id, 'NXC').available).toBe(COIN_UNIT);
    expect((await row(order.id)).transactionId).toBe(
      tradeOf(order.id)?.transactionId,
    );
  });

  it('stays SETTLING while the wallet is down; recovery settles it later', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    await setPrice('NXC', 4_200n);
    const q = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);
    wallet.fail('SettleTrade', 'before', 'before', 'before');

    const order = must(await placeMarket(user.token, q.id)).placeOrder;

    expect(order.status).toBe('SETTLING');
    expect(tradeOf(order.id)).toBeUndefined();
    await untilStatus(order.id, 'FILLED');
    expect(settleCalls(order.id)).toBeGreaterThanOrEqual(4);
    expect(wallet.balance(user.id, 'NXC').available).toBe(COIN_UNIT);
  });

  it('refuses malformed requests', async () => {
    const user = newUser();
    await setPrice('NXC', 4_200n);
    const q = await quote(user.token, 'NXC', 'BUY', COIN_UNIT);

    const noKey = await gql(user.token, PLACE, {
      input: { type: 'MARKET', quoteId: q.id },
    });
    expect(errorCode(noKey)).toBe('BAD_REQUEST');
    const cases: [Record<string, unknown>, string][] = [
      [{ type: 'MARKET' }, 'quoteId is required for a market order'],
      [
        { type: 'MARKET', quoteId: q.id, limitPrice: '100' },
        'limitPrice is only for limit orders: a market order takes everything from its quote',
      ],
      [
        {
          type: 'LIMIT',
          quoteId: q.id,
          coin: 'NXC',
          side: 'BUY',
          qty: '1',
          limitPrice: '1',
        },
        'quoteId is only for market orders: a limit order fills at its limitPrice',
      ],
      [
        { type: 'LIMIT', coin: 'DOGE', side: 'BUY', qty: '1', limitPrice: '1' },
        'coin must be one of: NXC, BLIP, ORB, WISP, BTC, ETH, HYPE, ZEC',
      ],
      [
        { type: 'LIMIT', coin: 'NXC', qty: '1', limitPrice: '1' },
        'side is required: BUY or SELL',
      ],
      [
        { type: 'LIMIT', coin: 'NXC', side: 'BUY', qty: '0', limitPrice: '1' },
        'qty must be positive',
      ],
      [
        { type: 'LIMIT', coin: 'NXC', side: 'BUY', qty: '1', limitPrice: '0' },
        'limitPrice must be positive',
      ],
      [
        {
          type: 'LIMIT',
          coin: 'NXC',
          side: 'BUY',
          qty: '1',
          limitPrice: '100000001',
        },
        'limitPrice must be at most $1,000,000.00',
      ],
      [
        {
          type: 'LIMIT',
          coin: 'NXC',
          side: 'SELL',
          qty: '1000',
          limitPrice: '4200',
        },
        'qty is too small: the trade is worth less than a cent',
      ],
    ];
    for (const [input, message] of cases) {
      const response = await gql(
        user.token,
        PLACE,
        { input },
        { key: randomUUID() },
      );
      expect({ input, error: response.errors?.[0] }).toEqual({
        input,
        error: expect.objectContaining({
          message,
          extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
        }),
      });
    }
    // Not signed in.
    expect(
      errorCode(
        await gql(
          null,
          PLACE,
          { input: { type: 'MARKET', quoteId: q.id } },
          { key: 'k' },
        ),
      ),
    ).toBe('FORBIDDEN');
  });
});

describe('a crash between storing a market order and settling it (acceptance test 7)', () => {
  it('leaves it SETTLING, and recovery on another replica settles it once', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    await setPrice('WISP', 340n);
    const q = await quote(user.token, 'WISP', 'BUY', 10n * COIN_UNIT);
    const doomed = await startReplica('doomed');
    faults.crashNext = true;

    const response = await placeMarket(user.token, q.id, randomUUID(), doomed);

    expect(response.errors?.[0]?.message).toMatch(/simulated crash/);
    const [stored] = await testDb.db
      .select()
      .from(orders)
      .where(eq(orders.userId, user.id));
    expect(stored.status).toBe('SETTLING');
    expect(settleCalls(stored.id)).toBe(0);
    await stopReplica(doomed);

    const filled = await untilStatus(stored.id, 'FILLED');
    expect(settleCalls(stored.id)).toBeGreaterThanOrEqual(1);
    expect(
      wallet.postingsOf('trade').filter((p) => p.ref === stored.id),
    ).toHaveLength(1);
    expect(filled.transactionId).toBe(tradeOf(stored.id)?.transactionId);
    expect(wallet.balance(user.id, 'WISP').available).toBe(10n * COIN_UNIT);
    expect(wallet.balance(user.id, 'USD').available).toBe(
      100_000n - BigInt(q.total),
    );
  });
});

// ---- limit orders ---------------------------------------------------------------------------

describe('limit orders (acceptance test 5)', () => {
  it('a buy holds its USD and fills only when the price reaches its limit, at the limit', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    const qty = 2n * COIN_UNIT;
    const terms = limitAmounts(4_000n, 'BUY', qty);

    const order = must(
      await placeLimit(user.token, {
        coin: 'NXC',
        side: 'BUY',
        qty,
        limitPrice: 4_000n,
      }),
    ).placeOrder;

    expect(order).toMatchObject({
      type: 'LIMIT',
      status: 'OPEN',
      limitPrice: '4000',
      fillPrice: null,
      usdAmount: '8000',
      fee: '40',
      total: '8040',
    });
    expect(Date.parse(order.expiresAt ?? '') - Date.now()).toBeGreaterThan(
      23 * 60 * 60_000,
    );
    // The spec's qty · limit · 1.005: 2 × $40.00 × 1.005 = $80.40.
    expect(wallet.holds.get(order.id)).toEqual({
      userId: user.id,
      asset: 'USD',
      amount: 8_040n,
      status: 'ACTIVE',
    });
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 100_000n - 8_040n,
      held: 8_040n,
    });

    expect(await crossAt('NXC', 4_001n)).toEqual([]);
    expect((await row(order.id)).status).toBe('OPEN');

    const [filled] = await crossAt('NXC', 3_990n);

    expect(filled).toMatchObject({
      id: order.id,
      status: 'FILLED',
      fillPrice: 4_000n,
      usdAmount: terms.usdAmount,
      fee: terms.fee,
    });
    expect(wallet.holds.get(order.id)?.status).toBe('CAPTURED');
    expect(tradeOf(order.id)?.legs).toEqual([
      { account: `user:${user.id}:held`, asset: 'USD', amount: -8_040n },
      { account: 'market_maker', asset: 'USD', amount: 8_000n },
      { account: 'fees', asset: 'USD', amount: 40n },
      { account: 'market_maker', asset: 'NXC', amount: -qty },
      { account: `user:${user.id}:available`, asset: 'NXC', amount: qty },
    ]);
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 100_000n - 8_040n,
      held: 0n,
    });
    expect(wallet.balance(user.id, 'NXC').available).toBe(qty);
    // A later crossing tick finds nothing to fill.
    expect(await crossAt('NXC', 3_000n)).toEqual([]);
  });

  it('a sell holds its coins and fills when the price rises to its limit', async () => {
    const user = newUser();
    wallet.fund(user.id, 'ORB', 5n * COIN_UNIT);
    const qty = 3n * COIN_UNIT;
    const terms = limitAmounts(32_000n, 'SELL', qty);

    const order = must(
      await placeLimit(user.token, {
        coin: 'ORB',
        side: 'SELL',
        qty,
        limitPrice: 32_000n,
      }),
    ).placeOrder;

    expect(order.status).toBe('OPEN');
    expect(wallet.balance(user.id, 'ORB')).toEqual({
      available: 2n * COIN_UNIT,
      held: qty,
    });
    expect(await crossAt('ORB', 31_999n)).toEqual([]);

    const [filled] = await crossAt('ORB', 32_000n);

    expect(filled.status).toBe('FILLED');
    expect(wallet.balance(user.id, 'ORB')).toEqual({
      available: 2n * COIN_UNIT,
      held: 0n,
    });
    expect(wallet.balance(user.id, 'USD').available).toBe(terms.total);
    expect(terms.total).toBe(96_000n - 480n);
  });

  it("cancel releases the hold; cancelling again returns it; a filled order can't be cancelled", async () => {
    const user = newUser();
    const stranger = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    const order = must(
      await placeLimit(user.token, {
        coin: 'BLIP',
        side: 'BUY',
        qty: COIN_UNIT,
        limitPrice: 1_000n,
      }),
    ).placeOrder;

    // Another user's cancel: not found, and nothing happens.
    const foreign = await gql(stranger.token, CANCEL, { id: order.id });
    expect(foreign.errors?.[0]).toMatchObject({
      message: 'id is not one of your orders',
      extensions: { code: 'BAD_USER_INPUT' },
    });

    const cancelled = must(
      await gql<{ cancelOrder: OrderView }>(user.token, CANCEL, {
        id: order.id,
      }),
    ).cancelOrder;

    expect(cancelled.status).toBe('CANCELLED');
    expect(wallet.holds.get(order.id)?.status).toBe('RELEASED');
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 100_000n,
      held: 0n,
    });
    expect((await row(order.id)).releasedAt).toBeInstanceOf(Date);
    const again = must(
      await gql<{ cancelOrder: OrderView }>(user.token, CANCEL, {
        id: order.id,
      }),
    ).cancelOrder;
    expect(again.status).toBe('CANCELLED');
    expect(
      wallet.postingsOf('release').filter((p) => p.ref === order.id),
    ).toHaveLength(1);
    // A cancelled order doesn't fill.
    expect(await crossAt('BLIP', 900n)).toEqual([]);

    const filled = must(
      await placeLimit(user.token, {
        coin: 'BLIP',
        side: 'BUY',
        qty: COIN_UNIT,
        limitPrice: 1_000n,
      }),
    ).placeOrder;
    await crossAt('BLIP', 1_000n);
    const late = await gql(user.token, CANCEL, { id: filled.id });
    expect(late.errors?.[0]).toMatchObject({
      message: 'The order is FILLED; only an open order can be cancelled',
      extensions: { code: 'ORDER_NOT_OPEN' },
    });
    expect(errorCode(await gql(user.token, CANCEL, { id: 'nope' }))).toBe(
      'BAD_USER_INPUT',
    );
  });

  it('expires through the delay bucket and releases the hold', async () => {
    const user = newUser();
    wallet.fund(user.id, 'NXC', COIN_UNIT);
    const expiring = replicas.find((r) => r.name === 'expiring');

    const order = must(
      await placeLimit(
        user.token,
        { coin: 'NXC', side: 'SELL', qty: COIN_UNIT, limitPrice: 9_000n },
        { replica: expiring },
      ),
    ).placeOrder;

    expect(order.status).toBe('OPEN');
    expect(Date.parse(order.expiresAt ?? '') - Date.now()).toBeLessThan(2_100);
    expect(wallet.balance(user.id, 'NXC').held).toBe(COIN_UNIT);

    // EXPIRED first, then the release: wait for both.
    const expired = await waitFor(
      async () => {
        const current = await row(order.id);
        return current.status === 'EXPIRED' && current.releasedAt && current;
      },
      10_000,
      'the expiry and its release',
    );

    expect(expired.releasedAt).toBeInstanceOf(Date);
    expect(wallet.holds.get(order.id)?.status).toBe('RELEASED');
    expect(wallet.balance(user.id, 'NXC')).toEqual({
      available: COIN_UNIT,
      held: 0n,
    });
    expect(await crossAt('NXC', 10_000n)).toEqual([]);
  });

  it('is REJECTED without enough funds, and holds nothing', async () => {
    const user = newUser();
    wallet.fund(user.id, 'WISP', COIN_UNIT);

    const order = must(
      await placeLimit(user.token, {
        coin: 'WISP',
        side: 'SELL',
        qty: 2n * COIN_UNIT,
        limitPrice: 400n,
      }),
    ).placeOrder;

    expect(order.status).toBe('REJECTED');
    expect(order.reason).toBe('insufficient WISP');
    expect(wallet.holds.has(order.id)).toBe(false);
    expect(await crossAt('WISP', 500n)).toEqual([]);
    // Its order.expire comes in 24 h and finds nothing to do.
  });

  it('stays PLACING while the wallet is down: no cancel yet, and recovery opens it', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 10_000n);
    wallet.fail('PlaceHold', 'before', 'before', 'before');

    const order = must(
      await placeLimit(user.token, {
        coin: 'NXC',
        side: 'BUY',
        qty: COIN_UNIT,
        limitPrice: 1_000n,
      }),
    ).placeOrder;

    expect(order.status).toBe('PLACING');
    expect(await crossAt('NXC', 500n)).toEqual([]);
    const cancel = await gql(user.token, CANCEL, { id: order.id });
    expect(cancel.errors?.[0]).toMatchObject({
      message: 'The order is still being placed; try again in a moment',
      extensions: { code: 'ORDER_NOT_OPEN' },
    });

    await untilStatus(order.id, 'OPEN');
    expect(wallet.holds.get(order.id)?.status).toBe('ACTIVE');
    must(await gql(user.token, CANCEL, { id: order.id }));
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 10_000n,
      held: 0n,
    });
  });

  it("places the hold once when the wallet's answer is lost", async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 10_000n);
    wallet.fail('PlaceHold', 'after');

    const order = must(
      await placeLimit(user.token, {
        coin: 'BLIP',
        side: 'BUY',
        qty: COIN_UNIT,
        limitPrice: 1_000n,
      }),
    ).placeOrder;

    expect(order.status).toBe('OPEN');
    expect(
      wallet.postingsOf('hold').filter((p) => p.ref === order.id),
    ).toHaveLength(1);
    expect(wallet.balance(user.id, 'USD').held).toBe(1_005n);

    // And a lost answer to the release.
    wallet.fail('ReleaseHold', 'after');
    const cancelled = must(
      await gql<{ cancelOrder: OrderView }>(user.token, CANCEL, {
        id: order.id,
      }),
    ).cancelOrder;
    expect(cancelled.status).toBe('CANCELLED');
    expect((await row(order.id)).releasedAt).toBeInstanceOf(Date);
    expect(wallet.balance(user.id, 'USD').held).toBe(0n);
  });

  it("a release that can't reach the wallet is retried by recovery", async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 10_000n);
    const order = must(
      await placeLimit(user.token, {
        coin: 'BLIP',
        side: 'BUY',
        qty: COIN_UNIT,
        limitPrice: 1_000n,
      }),
    ).placeOrder;
    wallet.fail('ReleaseHold', 'before', 'before', 'before');

    const cancelled = must(
      await gql<{ cancelOrder: OrderView }>(user.token, CANCEL, {
        id: order.id,
      }),
    ).cancelOrder;

    expect(cancelled.status).toBe('CANCELLED');
    expect(wallet.balance(user.id, 'USD').held).toBe(1_005n);
    await waitFor(
      async () => (await row(order.id)).releasedAt,
      8_000,
      'the release',
    );
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 10_000n,
      held: 0n,
    });
  });

  it('two matchers at once (two leaders for a moment) fill each order once', async () => {
    const user = newUser();
    wallet.fund(user.id, 'USD', 100_000n);
    const placed: OrderView[] = [];
    for (let i = 0; i < 10; i++) {
      placed.push(
        must(
          await placeLimit(user.token, {
            coin: 'ORB',
            side: 'BUY',
            qty: COIN_UNIT / 100n,
            limitPrice: 30_000n,
          }),
        ).placeOrder,
      );
    }

    const [a, b] = await Promise.all([
      crossAt('ORB', 29_000n, replicas[0]),
      crossAt('ORB', 29_000n, replicas[1]),
    ]);

    expect([...a, ...b].map((o) => o.id).sort()).toEqual(
      placed.map((o) => o.id).sort(),
    );
    for (const order of placed) {
      expect((await row(order.id)).status).toBe('FILLED');
      expect(settleCalls(order.id)).toBe(1);
    }
    expect(wallet.balance(user.id, 'USD').held).toBe(0n);
  });
});

// ---- the race -------------------------------------------------------------------------------

describe('cancel vs fill (acceptance test 6)', () => {
  it('100 times a cancel and a crossing tick at once: exactly one outcome each', async () => {
    const user = newUser();
    const hold = limitAmounts(1_000n, 'BUY', COIN_UNIT).total;
    wallet.fund(user.id, 'USD', 100n * hold);
    const outcomes = { FILLED: 0, CANCELLED: 0 };

    for (let i = 0; i < 100; i++) {
      const order = must(
        await placeLimit(user.token, {
          coin: 'WISP',
          side: 'BUY',
          qty: COIN_UNIT,
          limitPrice: 1_000n,
        }),
      ).placeOrder;
      expect(order.status).toBe('OPEN');
      const jitter = () => sleep(Math.random() * 4);

      const [cancel, matched] = await Promise.all([
        jitter().then(() =>
          gql<{ cancelOrder: OrderView }>(user.token, CANCEL, { id: order.id }),
        ),
        jitter().then(() => crossAt('WISP', 1_000n, replicas[i % 2])),
      ]);

      const final = await row(order.id);
      const walletHold = wallet.holds.get(order.id);
      if (final.status === 'CANCELLED') {
        expect(cancel.data?.cancelOrder.status).toBe('CANCELLED');
        expect(matched).toEqual([]);
        expect(walletHold?.status).toBe('RELEASED');
        expect(tradeOf(order.id)).toBeUndefined();
      } else {
        expect(final.status).toBe('FILLED');
        expect(errorCode(cancel)).toBe('ORDER_NOT_OPEN');
        expect(matched.map((o) => o.id)).toEqual([order.id]);
        expect(walletHold?.status).toBe('CAPTURED');
        expect(
          wallet.postingsOf('release').some((p) => p.ref === order.id),
        ).toBe(false);
      }
      outcomes[final.status as 'FILLED' | 'CANCELLED']++;
    }

    expect(outcomes.FILLED + outcomes.CANCELLED).toBe(100);
    expect(wallet.balance(user.id, 'USD')).toEqual({
      available: 100n * hold - BigInt(outcomes.FILLED) * hold,
      held: 0n,
    });
    expect(wallet.balance(user.id, 'WISP').available).toBe(
      BigInt(outcomes.FILLED) * COIN_UNIT,
    );
    // Which one wins each race is up to timing (about 80 fills to 20 cancels here). If one side
    // never won, the race wouldn't have been tested.
    expect(outcomes.FILLED).toBeGreaterThan(0);
    expect(outcomes.CANCELLED).toBeGreaterThan(0);
  }, 60_000);
});

// ---- the orders query, and the leader's ticks -------------------------------------------------

it("orders lists the user's orders, newest first, optionally by status", async () => {
  const user = newUser();
  const other = newUser();
  wallet.fund(user.id, 'USD', 100_000n);
  wallet.fund(other.id, 'USD', 100_000n);
  const limit = {
    coin: 'BLIP',
    side: 'BUY' as const,
    qty: COIN_UNIT,
    limitPrice: 100n,
  };
  const first = must(await placeLimit(user.token, limit)).placeOrder;
  const second = must(await placeLimit(user.token, limit)).placeOrder;
  await placeLimit(other.token, limit);
  must(await gql(user.token, CANCEL, { id: first.id }));

  const all = must(
    await gql<{ orders: OrderView[] }>(user.token, `{ orders { id status } }`),
  ).orders;
  const open = must(
    await gql<{ orders: OrderView[] }>(
      user.token,
      `{ orders(status: [OPEN], first: 10) { id } }`,
    ),
  ).orders;

  expect(all).toEqual([
    { id: second.id, status: 'OPEN' },
    { id: first.id, status: 'CANCELLED' },
  ]);
  expect(open).toEqual([{ id: second.id }]);
  expect(errorCode(await gql(user.token, `{ orders(first: 0) { id } }`))).toBe(
    'BAD_USER_INPUT',
  );
  expect(errorCode(await gql(null, `{ orders { id } }`))).toBe('FORBIDDEN');
  // Leave nothing open for the next test's ticks.
  for (const token of [user.token, other.token]) {
    const mine = must(
      await gql<{ orders: OrderView[] }>(
        token,
        `{ orders(status: [OPEN]) { id } }`,
      ),
    ).orders;
    for (const { id } of mine) {
      must(await gql(token, CANCEL, { id }));
    }
  }
});

it('the simulator leader fills crossing limit orders on its ticks', async () => {
  const user = newUser();
  wallet.fund(user.id, 'USD', 100_000n);
  const leader = await startReplica('leader', { simulator: true });
  const simulator = leader.app.get(SimulatorService);
  await waitFor(async () => simulator.isLeader, 10_000, 'the leader');
  const price = await waitFor(
    async () => (await leader.app.get(PriceStore).get('NXC'))?.price,
    5_000,
    'an NXC price',
  );

  // A buy limit far above the price: the next tick crosses it.
  const order = must(
    await placeLimit(user.token, {
      coin: 'NXC',
      side: 'BUY',
      qty: COIN_UNIT / 10n,
      limitPrice: price * 2n,
    }),
  ).placeOrder;
  expect(order.status).toBe('OPEN');

  const filled = await untilStatus(order.id, 'FILLED', 5_000);
  expect(filled.fillPrice).toBe(price * 2n);
  expect(wallet.balance(user.id, 'NXC').available).toBe(COIN_UNIT / 10n);
  await stopReplica(leader);
});

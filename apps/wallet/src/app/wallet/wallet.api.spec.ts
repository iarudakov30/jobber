import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { Observable, of, throwError } from 'rxjs';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { randomUUID } from 'crypto';
import { GrpcStatus, Packages, User } from '@jobber/grpc';
import { IDEMPOTENCY_LOCK, RedisIdempotencyLock } from '@jobber/idempotency';
import { OutboxRelay } from '@jobber/outbox';
import { PulsarClient } from '@jobber/pulsar';
import {
  TestDatabase,
  expectBooksBalanced,
  startTestDatabase,
} from '../../testing/test-database';
import { DatabaseModule } from '../database/database.module';
import { graphQLOptions } from '../graphql.options';
import { OutboxModule } from '../outbox/outbox.module';
import { WalletController } from './wallet.controller';
import { WalletModule } from './wallet.module';

// The wallet API end to end over HTTP: Apollo, GqlAuthGuard, ValidationPipe, the MinorUnits
// scalar, @Idempotent() and the ledger, against Testcontainers PostgreSQL and Redis. Only `auth`
// (gRPC) and Pulsar are faked.

const schemaFile = join(tmpdir(), `wallet-schema-${process.pid}.gql`);

let testDb: TestDatabase;
let redisContainer: StartedTestContainer;
let redisLock: RedisIdempotencyLock;
let pool: Pool;
let app: INestApplication;
let url: string;
let controller: WalletController;
const relay = { poke: jest.fn() };

/** The users `auth` knows, by session token. */
const sessions = new Map<string, User>();
let lastUserId = 0;

function notFound() {
  return Object.assign(new Error('No user has that email'), {
    code: GrpcStatus.NOT_FOUND,
  });
}

const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    const user = sessions.get(token);
    return user ? of(user) : throwError(() => new Error('bad token'));
  },
  findUserByEmail: ({ email }: { email: string }): Observable<User> => {
    const user = [...sessions.values()].find((u) => u.email === email);
    return user ? of(user) : throwError(notFound);
  },
};

beforeAll(async () => {
  [testDb, redisContainer] = await Promise.all([
    startTestDatabase(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  pool = testDb.pool;
  redisLock = RedisIdempotencyLock.connect(
    `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`,
  );
  await redisLock.whenReady();

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      OutboxModule,
      WalletModule,
      GraphQLModule.forRoot<ApolloDriverConfig>(graphQLOptions(schemaFile)),
    ],
  })
    .overrideProvider('DATABASE_POOL')
    .useValue(pool)
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    .overrideProvider(OutboxRelay)
    .useValue(relay)
    .overrideProvider(PulsarClient)
    .useValue({})
    .overrideProvider(IDEMPOTENCY_LOCK)
    .useValue(redisLock)
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  // What init() from @jobber/nestjs adds, minus the port and Swagger.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.use(cookieParser());
  await app.listen(0);
  url = `${(await app.getUrl()).replace('[::1]', 'localhost')}/wallet`;
  controller = app.get(WalletController);
}, 180_000);

afterAll(async () => {
  await app?.close(); // ends the pool (DatabaseModule)
  await testDb?.container.stop();
  await redisContainer?.stop();
  rmSync(schemaFile, { force: true });
});

afterEach(() => expectBooksBalanced(pool));

async function signUp(dollars = 0) {
  const id = ++lastUserId;
  const user = { id, email: `user${id}@example.com` };
  const token = `token-${id}`;
  sessions.set(token, user);
  if (dollars > 0) {
    await controller.credit({
      userId: id,
      asset: 'USD',
      amount: String(dollars * 100),
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `seed:${id}`,
    });
  }
  return { ...user, token };
}

interface GqlResponse<T = Record<string, unknown>> {
  data?: T | null;
  errors?: {
    message: string;
    extensions?: { code?: string; originalError?: { message: unknown } };
  }[];
}

async function gql<T = Record<string, unknown>>(
  token: string | null,
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<GqlResponse<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `Authentication=${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

const BALANCES = '{ balances { asset available held } }';
const TRANSFER = `
  mutation ($input: TransferInput!) {
    transfer(input: $input) { transactionId amount asset }
  }`;

async function usd(token: string) {
  const { data } = await gql<{ balances: { available: string }[] }>(
    token,
    BALANCES,
  );
  return data?.balances[0].available;
}

/** A transfer with its own Idempotency-Key unless `key` is given (`null`: no header). */
function send(
  token: string,
  toEmail: string,
  amount: unknown,
  key: string | null = randomUUID(),
) {
  return gql<{ transfer: { transactionId: string; amount: string } }>(
    token,
    TRANSFER,
    { input: { toEmail, asset: 'USD', amount } },
    key === null ? {} : { 'idempotency-key': key },
  );
}

async function transferCount(fromUserId: number) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM transactions
     WHERE type = 'transfer' AND metadata->>'fromUserId' = $1`,
    [String(fromUserId)],
  );
  return rows[0].n as number;
}

describe('GraphQL', () => {
  it('refuses a request without a valid session', async () => {
    for (const token of [null, 'forged']) {
      const { data, errors } = await gql(token, BALANCES);

      expect(data).toBeNull();
      expect(errors?.[0].extensions?.code).toBe('FORBIDDEN');
    }
  });

  it("shows a new user's zero balance, creating their accounts", async () => {
    const alice = await signUp();

    expect(await gql(alice.token, BALANCES)).toEqual({
      data: { balances: [{ asset: 'USD', available: '0', held: '0' }] },
    });
  });

  it('transfers by email and announces it on the outbox', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    relay.poke.mockClear();

    const { data, errors } = await send(alice.token, bob.email, '1250');

    expect(errors).toBeUndefined();
    expect(data?.transfer).toEqual({
      transactionId: expect.any(String),
      amount: '1250',
      asset: 'USD',
    });
    expect(await usd(alice.token)).toBe('8750');
    expect(await usd(bob.token)).toBe('1250');
    expect(relay.poke).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      'SELECT destination, key, payload FROM outbox WHERE key = $1',
      [data?.transfer.transactionId],
    );
    expect(rows).toEqual([
      {
        destination: 'transfer-completed',
        key: data?.transfer.transactionId,
        payload: {
          transactionId: data?.transfer.transactionId,
          fromUserId: alice.id,
          toUserId: bob.id,
          asset: 'USD',
          amount: '1250',
        },
      },
    ]);
  });

  it.each([
    [
      'an unknown email',
      'nobody@example.com',
      '100',
      'toEmail does not belong to any user',
    ],
    ['the sender themselves', 'self', '100', 'toEmail is your own email'],
    [
      'more than the balance',
      'bob',
      '10001',
      'amount exceeds your available balance',
    ],
  ])(
    'refuses a transfer to %s with BAD_USER_INPUT',
    async (_, to, amount, message) => {
      const alice = await signUp(100);
      const bob = await signUp();
      const toEmail =
        to === 'self' ? alice.email : to === 'bob' ? bob.email : to;

      const { data, errors } = await send(alice.token, toEmail, amount);

      expect(data).toBeNull();
      expect(errors).toEqual([
        expect.objectContaining({
          message,
          extensions: expect.objectContaining({ code: 'BAD_USER_INPUT' }),
        }),
      ]);
      expect(await usd(alice.token)).toBe('10000');
    },
  );

  it('refuses a non-positive amount through validation, naming the field', async () => {
    const alice = await signUp(100);
    const bob = await signUp();

    for (const amount of ['0', '-5']) {
      const { errors } = await send(alice.token, bob.email, amount);

      expect(errors?.[0].extensions?.code).toBe('BAD_REQUEST');
      expect(errors?.[0].extensions?.originalError?.message).toEqual([
        'amount must be positive',
      ]);
    }
    expect(await usd(alice.token)).toBe('10000');
  });

  it('refuses to transfer coins: they move only through trades', async () => {
    const alice = await signUp();
    const bob = await signUp();
    await controller.credit({
      userId: alice.id,
      asset: 'NXC',
      amount: '100000000',
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `seed-coin:${alice.id}`,
    });

    const { data, errors } = await gql(
      alice.token,
      TRANSFER,
      { input: { toEmail: bob.email, asset: 'NXC', amount: '1' } },
      { 'idempotency-key': randomUUID() },
    );

    expect(data).toBeNull();
    expect(errors?.[0].extensions?.code).toBe('BAD_REQUEST');
    expect(errors?.[0].extensions?.originalError?.message).toEqual([
      'asset must be one of the following values: USD',
    ]);
  });

  it('lists a coin only once the user holds an account in it', async () => {
    const alice = await signUp();
    await controller.credit({
      userId: alice.id,
      asset: 'ORB',
      amount: '250000000',
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `seed-coin:${alice.id}`,
    });

    expect(await gql(alice.token, BALANCES)).toEqual({
      data: {
        balances: [
          { asset: 'USD', available: '0', held: '0' },
          { asset: 'ORB', available: '250000000', held: '0' },
        ],
      },
    });
  });

  it.each([
    ['a JSON number', 1250],
    ['a decimal', '12.50'],
    ['garbage', 'ten'],
  ])('refuses an amount given as %s', async (_, amount) => {
    const alice = await signUp(100);
    const bob = await signUp();

    const { data, errors } = await send(alice.token, bob.email, amount);

    expect(data).toBeUndefined();
    expect(errors?.[0].message).toMatch(/MinorUnits/);
    expect(await usd(alice.token)).toBe('10000');
  });

  it("lists the user's positions from their trades", async () => {
    const alice = await signUp(100);
    await controller.settleTrade({
      tradeId: randomUUID(),
      userId: alice.id,
      coin: 'NXC',
      side: 'BUY',
      qty: '150000000',
      usdAmount: '3000',
      fee: '15',
      holdId: '',
    });

    const { data, errors } = await gql(
      alice.token,
      '{ positions { coin qty costBasis averagePrice } }',
    );

    expect(errors).toBeUndefined();
    expect(data).toEqual({
      positions: [
        {
          coin: 'NXC',
          qty: '150000000',
          costBasis: '3015',
          averagePrice: '2010',
        },
      ],
    });
  });

  it('pages through the history, newest first', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    for (const cents of ['100', '200', '300']) {
      await send(alice.token, bob.email, cents);
    }
    const ENTRIES = `
      query ($after: ID) {
        entries(first: 2, after: $after) {
          items { id transactionId type asset amount createdAt }
          nextCursor
        }
      }`;
    type Page = {
      entries: {
        items: { type: string; amount: string; createdAt: string }[];
        nextCursor: string | null;
      };
    };

    const first = await gql<Page>(alice.token, ENTRIES);
    const second = await gql<Page>(alice.token, ENTRIES, {
      after: first.data?.entries.nextCursor,
    });

    expect(first.data?.entries.items.map((e) => [e.type, e.amount])).toEqual([
      ['transfer', '-300'],
      ['transfer', '-200'],
    ]);
    expect(first.data?.entries.nextCursor).toEqual(expect.any(String));
    expect(second.data?.entries.items.map((e) => [e.type, e.amount])).toEqual([
      ['transfer', '-100'],
      ['seed', '10000'],
    ]);
    expect(second.data?.entries.nextCursor).toBeNull();
    expect(
      new Date(String(first.data?.entries.items[0].createdAt)).getTime(),
    ).not.toBeNaN();
    // Bob sees only his own side.
    const bobs = await gql<Page>(bob.token, ENTRIES);
    expect(bobs.data?.entries.items.map((e) => e.amount)).toEqual([
      '300',
      '200',
    ]);
  });

  it("finds a top-up's entry once it is credited, for its owner only", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const paymentId = randomUUID();
    const TOP_UP = `
      query ($paymentId: ID!) {
        topUp(paymentId: $paymentId) { type asset amount }
      }`;
    type Found = { topUp: { type: string; amount: string } | null };

    const before = await gql<Found>(alice.token, TOP_UP, { paymentId });
    await controller.credit({
      userId: alice.id,
      asset: 'USD',
      amount: '5000',
      fromSystemAccount: 'stripe_clearing',
      type: 'topup',
      externalRef: paymentId,
    });
    const after = await gql<Found>(alice.token, TOP_UP, { paymentId });
    const asBob = await gql<Found>(bob.token, TOP_UP, { paymentId });
    const malformed = await gql(alice.token, TOP_UP, { paymentId: 'x' });

    expect(before).toEqual({ data: { topUp: null } });
    expect(after.data?.topUp).toEqual({
      type: 'topup',
      asset: 'USD',
      amount: '5000',
    });
    expect(asBob).toEqual({ data: { topUp: null } });
    expect(malformed.errors?.[0]).toMatchObject({
      message: 'paymentId must be a payment id (a UUID)',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('refuses a malformed cursor', async () => {
    const alice = await signUp();

    const { errors } = await gql(
      alice.token,
      '{ entries(after: "x") { nextCursor } }',
    );

    expect(errors?.[0]).toMatchObject({
      message: 'after must be a cursor from nextCursor',
      extensions: { code: 'BAD_USER_INPUT' },
    });
  });

  it('prints the schema that apps/wallet/schema.gql has committed', () => {
    const committed = readFileSync(
      join(__dirname, '../../../schema.gql'),
      'utf8',
    );

    expect(readFileSync(schemaFile, 'utf8')).toBe(committed);
  });
});

describe('idempotent transfer', () => {
  const scopeOf = (userId: number, key: string) => `${userId}:transfer:${key}`;

  it('requires an Idempotency-Key and moves nothing without one', async () => {
    const alice = await signUp(100);
    const bob = await signUp();

    const { data, errors } = await send(alice.token, bob.email, '100', null);

    expect(data).toBeNull();
    expect(errors?.[0].extensions).toMatchObject({
      code: 'BAD_REQUEST',
      status: 400,
    });
    expect(await transferCount(alice.id)).toBe(0);
  });

  it('replays the first result for a retry with the same key', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();

    const first = await send(alice.token, bob.email, '700', key);
    const retry = await send(alice.token, bob.email, '700', key);

    expect(first.errors).toBeUndefined();
    expect(retry).toEqual(first);
    expect(await usd(alice.token)).toBe('9300');
    expect(await transferCount(alice.id)).toBe(1);
  });

  it('makes one transfer from 50 parallel requests with one key (spec test 4)', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        send(alice.token, bob.email, '100', key),
      ),
    );

    const ok = results.filter((r) => r.data?.transfer);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((r) => r.data?.transfer.transactionId)).size).toBe(1);
    for (const r of results.filter((r) => r.errors)) {
      expect(r.errors?.[0].extensions?.code).toBe('CONFLICT');
    }
    expect(await transferCount(alice.id)).toBe(1);
    expect(await usd(bob.token)).toBe('100');
  });

  it('refuses the key with a different amount and moves nothing (spec test 5)', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();
    await send(alice.token, bob.email, '100', key);

    const reused = await send(alice.token, bob.email, '200', key);

    expect(reused.data).toBeNull();
    expect(reused.errors?.[0]).toMatchObject({
      message: 'Idempotency-Key was already used with a different request',
      extensions: { code: 'UNPROCESSABLE_ENTITY', status: 422 },
    });
    expect(await transferCount(alice.id)).toBe(1);
    expect(await usd(alice.token)).toBe('9900');
  });

  it('still makes one transfer with Redis unavailable (spec test 6)', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();
    const acquire = jest
      .spyOn(redisLock, 'acquire')
      .mockResolvedValue({ status: 'unavailable' });

    try {
      const results = await Promise.all(
        Array.from({ length: 50 }, () =>
          send(alice.token, bob.email, '100', key),
        ),
      );

      expect(results.some((r) => r.data?.transfer)).toBe(true);
      expect(await transferCount(alice.id)).toBe(1);
    } finally {
      acquire.mockRestore();
    }
  });

  it('lets the same key be retried after a refused transfer', async () => {
    const alice = await signUp(1);
    const bob = await signUp();
    const key = randomUUID();

    const refused = await send(alice.token, bob.email, '500', key);
    await controller.credit({
      userId: alice.id,
      asset: 'USD',
      amount: '400',
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `top-up:${alice.id}`,
    });
    const retried = await send(alice.token, bob.email, '500', key);

    expect(refused.errors?.[0].message).toBe(
      'amount exceeds your available balance',
    );
    expect(retried.errors).toBeUndefined();
    expect(await usd(bob.token)).toBe('500');
  });

  it('posts once when a retry takes over a claim whose response was never stored', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();
    const first = await send(alice.token, bob.email, '300', key);
    // As if the server crashed after the ledger commit, before storing the response.
    await pool.query(
      `UPDATE idempotency_keys
       SET status = 'in_progress', response = NULL, expires_at = NULL,
           locked_until = now() - interval '1 second'
       WHERE scope = $1`,
      [scopeOf(alice.id, key)],
    );

    const retry = await send(alice.token, bob.email, '300', key);

    expect(retry).toEqual(first);
    expect(await transferCount(alice.id)).toBe(1);
    expect(await usd(bob.token)).toBe('300');
  });

  it('refuses a key reused for a different transfer after its response expired', async () => {
    const alice = await signUp(100);
    const bob = await signUp();
    const key = randomUUID();
    await send(alice.token, bob.email, '300', key);
    await pool.query(
      `UPDATE idempotency_keys SET expires_at = now() - interval '1 second'
       WHERE scope = $1`,
      [scopeOf(alice.id, key)],
    );

    const reused = await send(alice.token, bob.email, '999', key);

    expect(reused.errors?.[0]).toMatchObject({
      message: 'Idempotency-Key was already used for a different transfer',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(await transferCount(alice.id)).toBe(1);
    expect(await usd(alice.token)).toBe('9700');
  });
});

describe('gRPC WalletService', () => {
  it('credits from the seed account once per externalRef', async () => {
    const alice = await signUp();
    const request = {
      userId: alice.id,
      asset: 'USD',
      amount: '5000',
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `seed-test:${alice.id}`,
    };

    const first = await controller.credit(request);
    const again = await controller.credit(request);

    expect(first.duplicate).toBe(false);
    expect(again).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await controller.getBalances({ userId: alice.id })).toEqual({
      balances: [{ asset: 'USD', available: '5000', held: '0' }],
    });
  });

  it.each([
    [
      'an unknown system account',
      { fromSystemAccount: 'fees' },
      /fromSystemAccount must be one of/,
    ],
    ['a zero amount', { amount: '0' }, /amount must be positive/],
    [
      'an amount that is not minor units',
      { amount: '12.50' },
      /not an amount in minor units/,
    ],
    ['an unknown asset', { asset: 'EUR' }, /asset EUR is not supported/],
    ['a missing externalRef', { externalRef: '' }, /externalRef are required/],
  ])('refuses %s with INVALID_ARGUMENT', async (_, change, message) => {
    const alice = await signUp();

    const credit = controller.credit({
      userId: alice.id,
      asset: 'USD',
      amount: '100',
      fromSystemAccount: 'seed',
      type: 'seed',
      externalRef: `bad:${alice.id}`,
      ...change,
    });

    await expect(credit).rejects.toBeInstanceOf(RpcException);
    await expect(credit).rejects.toMatchObject({
      error: {
        code: GrpcStatus.INVALID_ARGUMENT,
        message: expect.stringMatching(message),
      },
    });
  });

  it('places a hold and settles a limit order through it, amounts as strings', async () => {
    const alice = await signUp(100);
    const holdId = randomUUID();

    const hold = await controller.placeHold({
      holdId,
      userId: alice.id,
      asset: 'USD',
      amount: '2010',
    });
    expect(await controller.getBalances({ userId: alice.id })).toEqual({
      balances: [{ asset: 'USD', available: '7990', held: '2010' }],
    });

    const trade = {
      tradeId: holdId,
      userId: alice.id,
      coin: 'NXC',
      side: 'BUY',
      qty: '100000000',
      usdAmount: '2000',
      fee: '10',
      holdId,
    };
    const first = await controller.settleTrade(trade);
    const again = await controller.settleTrade(trade);

    expect(hold.duplicate).toBe(false);
    expect(first.duplicate).toBe(false);
    expect(again).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await controller.getBalances({ userId: alice.id })).toEqual({
      balances: [
        { asset: 'USD', available: '7990', held: '0' },
        { asset: 'NXC', available: '100000000', held: '0' },
      ],
    });
    expect(relay.poke).toHaveBeenCalled();
  });

  it.each([
    [
      'a hold beyond the balance',
      async () =>
        controller.placeHold({
          holdId: randomUUID(),
          userId: (await signUp()).id,
          asset: 'USD',
          amount: '1',
        }),
      GrpcStatus.FAILED_PRECONDITION,
      /Insufficient funds/,
    ],
    [
      'an unknown hold',
      () => controller.releaseHold({ holdId: randomUUID() }),
      GrpcStatus.NOT_FOUND,
      /does not exist/,
    ],
    [
      'a quantity that is not minor units',
      () =>
        controller.settleTrade({
          tradeId: randomUUID(),
          userId: 1,
          coin: 'NXC',
          side: 'BUY',
          qty: '1.5',
          usdAmount: '100',
          fee: '1',
          holdId: '',
        }),
      GrpcStatus.INVALID_ARGUMENT,
      /not an amount in minor units/,
    ],
  ])(
    'answers %s with the matching gRPC status',
    async (_, call, code, message) => {
      await expect(call()).rejects.toMatchObject({
        error: { code, message: expect.stringMatching(message) },
      });
    },
  );

  it('audits the books: nothing to report', async () => {
    await signUp(10);

    expect(await controller.runAudit()).toEqual({ issues: [] });
  });
});

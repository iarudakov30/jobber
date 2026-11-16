import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { Observable, of, throwError } from 'rxjs';
import { GrpcStatus, Packages, User } from '@jobber/grpc';
import { OutboxRelay } from '@jobber/outbox';
import { PulsarClient } from '@jobber/pulsar';
import {
  TestDatabase,
  expectBooksBalanced,
  startTestDatabase,
} from '../../testing/test-database';
import { DatabaseModule } from '../database/database.module';
import { graphQLOptions } from '../graphql.options';
import { WalletController } from './wallet.controller';
import { WalletModule } from './wallet.module';

// The wallet API end to end over HTTP: Apollo, GqlAuthGuard, ValidationPipe, the MinorUnits
// scalar and the ledger, against a Testcontainers PostgreSQL. Only `auth` (gRPC) and Pulsar
// are faked.

const schemaFile = join(tmpdir(), `wallet-schema-${process.pid}.gql`);

let testDb: TestDatabase;
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
  testDb = await startTestDatabase();
  pool = testDb.pool;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
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
): Promise<GqlResponse<T>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { cookie: `Authentication=${token}` } : {}),
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

function send(token: string, toEmail: string, amount: unknown) {
  return gql<{ transfer: { transactionId: string; amount: string } }>(
    token,
    TRANSFER,
    { input: { toEmail, asset: 'USD', amount } },
  );
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

  it('audits the books: nothing to report', async () => {
    await signUp(10);

    expect(await controller.runAudit()).toEqual({ issues: [] });
  });
});

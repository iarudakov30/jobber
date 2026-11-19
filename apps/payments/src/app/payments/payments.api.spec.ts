import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import { readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Pool } from 'pg';
import { Observable, of, throwError } from 'rxjs';
import Stripe from 'stripe';
import { Packages, User } from '@jobber/grpc';
import { IDEMPOTENCY_LOCK } from '@jobber/idempotency';
import { PulsarClient } from '@jobber/pulsar';
import { RabbitModule } from '@jobber/rabbitmq';
import { TestDatabase, startTestDatabase } from '../../testing/test-database';
import { DatabaseModule } from '../database/database.module';
import { graphQLOptions } from '../graphql.options';
import { PaymentsModule } from './payments.module';
import { STRIPE_API_VERSION, STRIPE_CLIENT } from './stripe.client';
import { DELAY_BUCKETS, paymentsTopology } from './topology';

// The payments service end to end: GraphQL over HTTP, the signed webhook, the outbox relay,
// and the payment.expire command through a real RabbitMQ delay bucket, against Testcontainers
// PostgreSQL and RabbitMQ. Faked: `auth` (gRPC), Pulsar (messages are captured) and Stripe's
// Checkout API (an in-memory imitation of its session states). Webhook signatures are real:
// the Stripe SDK signs and verifies them.

const WEBHOOK_SECRET = 'whsec_test_secret';
/** `delay.1m` waits this long in these tests. */
const EXPIRY_MS = 2_000;

// The test process may have apps/payments/.env values in its environment (Nx loads it); pin
// what the app reads.
Object.assign(process.env, {
  APP_URL: 'http://app.test',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  PAYMENT_EXPIRY_BUCKET: 'delay.1m',
  AUTH_GRPC_SERVICE_URL: 'localhost:1',
});

const schemaFile = join(tmpdir(), `payments-schema-${process.pid}.gql`);

let testDb: TestDatabase;
let rabbit: StartedRabbitMQContainer;
let pool: Pool;
let app: INestApplication;
let baseUrl: string;

// ---- auth ----------------------------------------------------------------------------------

const sessions = new Map<string, User>();
let lastUserId = 0;

const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    const user = sessions.get(token);
    return user ? of(user) : throwError(() => new Error('bad token'));
  },
};

function signUp() {
  const id = ++lastUserId;
  const token = `token-${id}`;
  sessions.set(token, { id, email: `user${id}@example.com` });
  return { id, token };
}

// ---- Pulsar --------------------------------------------------------------------------------

interface Sent {
  topic: string;
  key?: string;
  data: Record<string, unknown>;
}
const sent: Sent[] = [];
const fakePulsar = {
  createProducer: async (topic: string) => ({
    send: async (m: { data: Buffer; partitionKey?: string }) => {
      sent.push({
        topic,
        key: m.partitionKey,
        data: JSON.parse(m.data.toString()),
      });
      return {};
    },
  }),
};
const succeededFor = (paymentId: string) =>
  sent.filter(
    (m) => m.topic === 'payment-succeeded' && m.data['paymentId'] === paymentId,
  );

// ---- Stripe --------------------------------------------------------------------------------

const stripe = new Stripe('sk_test_not_used', {
  apiVersion: STRIPE_API_VERSION,
});

type FakeSession = Pick<
  Stripe.Checkout.Session,
  | 'id'
  | 'object'
  | 'status'
  | 'payment_status'
  | 'amount_total'
  | 'currency'
  | 'metadata'
  | 'client_reference_id'
  | 'url'
>;

/** Checkout sessions as Stripe keeps them: open → complete (paid) or expired. */
const checkout = new Map<string, FakeSession>();
let stripeDown = false;
let expireFailures = 0;
const createCalls: [
  Stripe.Checkout.SessionCreateParams,
  Stripe.RequestOptions,
][] = [];

function stripeError(type: string, message: string) {
  return Object.assign(new Error(message), { type });
}

const fakeSessions = {
  async create(
    params: Stripe.Checkout.SessionCreateParams,
    options: Stripe.RequestOptions,
  ) {
    createCalls.push([params, options]);
    if (stripeDown) {
      throw stripeError('StripeConnectionError', 'connect ECONNREFUSED');
    }
    const id = `cs_test_${params.client_reference_id}`;
    const session: FakeSession = {
      id,
      object: 'checkout.session',
      status: 'open',
      payment_status: 'unpaid',
      amount_total: params.line_items?.[0].price_data?.unit_amount ?? null,
      currency: 'usd',
      metadata: params.metadata as Stripe.Metadata,
      client_reference_id: params.client_reference_id ?? null,
      url: `https://checkout.stripe.test/${id}`,
    };
    checkout.set(id, session);
    return { ...session };
  },
  async expire(id: string) {
    if (expireFailures > 0) {
      expireFailures--;
      throw stripeError('StripeConnectionError', 'socket hang up');
    }
    const session = checkout.get(id);
    if (!session) {
      throw stripeError('StripeInvalidRequestError', 'No such session');
    }
    if (session.status !== 'open') {
      throw stripeError(
        'StripeInvalidRequestError',
        'Only Checkout Sessions with a status of `open` can be expired.',
      );
    }
    session.status = 'expired';
    return { ...session };
  },
  async retrieve(id: string) {
    return { ...checkout.get(id) };
  },
};

/** The customer pays on the Checkout page. */
function pay(paymentId: string, changes: Partial<FakeSession> = {}) {
  const session = checkout.get(`cs_test_${paymentId}`);
  if (!session) {
    throw new Error(`no session for ${paymentId}`);
  }
  Object.assign(
    session,
    { status: 'complete', payment_status: 'paid' },
    changes,
  );
  return { ...session };
}

// ---- app -----------------------------------------------------------------------------------

beforeAll(async () => {
  [testDb, rabbit] = await Promise.all([
    startTestDatabase(),
    new RabbitMQContainer('rabbitmq:4-management')
      // RabbitMQ boots slowly when several projects start one at once (nx affected).
      .withStartupTimeout(120_000)
      .start(),
  ]);
  pool = testDb.pool;
  for (const method of ['create', 'expire', 'retrieve'] as const) {
    jest
      .spyOn(stripe.checkout.sessions, method)
      .mockImplementation(fakeSessions[method] as never);
  }

  const buckets = DELAY_BUCKETS.map((b) =>
    b.name === 'delay.1m' ? { ...b, ttlMs: EXPIRY_MS } : b,
  );
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      RabbitModule.forRoot({
        url: rabbit.getAmqpUrl(),
        topology: paymentsTopology(buckets),
        minReconnectDelayMs: 100,
      }),
      PaymentsModule,
      GraphQLModule.forRoot<ApolloDriverConfig>(graphQLOptions(schemaFile)),
    ],
  })
    .overrideProvider('DATABASE_POOL')
    .useValue(pool)
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    .overrideProvider(PulsarClient)
    .useValue(fakePulsar)
    .overrideProvider(STRIPE_CLIENT)
    .useValue(stripe)
    .overrideProvider(IDEMPOTENCY_LOCK)
    .useValue(null) // PostgreSQL alone decides; Redis is only the fast path
    .compile();

  app = moduleRef.createNestApplication({ logger: false, rawBody: true });
  // What init() from @jobber/nestjs adds, minus the port and Swagger.
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.setGlobalPrefix('payments');
  app.use(cookieParser());
  await app.listen(0);
  baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
}, 180_000);

afterAll(async () => {
  await app?.close();
  await Promise.all([testDb?.container.stop(), rabbit?.stop()]);
  rmSync(schemaFile, { force: true });
});

beforeEach(() => {
  stripeDown = false;
  expireFailures = 0;
});

// ---- helpers -------------------------------------------------------------------------------

interface GqlResponse<T> {
  data?: T | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

async function gql<T = Record<string, unknown>>(
  token: string | null,
  query: string,
  variables?: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<GqlResponse<T>> {
  const response = await fetch(`${baseUrl}/payments`, {
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

const CREATE_TOP_UP = `
  mutation ($input: CreateTopUpInput!) {
    createTopUp(input: $input) { paymentId checkoutUrl }
  }`;

function topUp(token: string, amount: unknown, key = randomUUID()) {
  return gql<{ createTopUp: { paymentId: string; checkoutUrl: string } }>(
    token,
    CREATE_TOP_UP,
    { input: { amount } },
    { 'idempotency-key': key },
  );
}

async function startTopUp(token: string, amount = '5000') {
  const { data, errors } = await topUp(token, amount);
  expect(errors).toBeUndefined();
  return must(data).createTopUp.paymentId;
}

async function row(paymentId: string) {
  const { rows } = await pool.query(
    'SELECT status, amount::text, stripe_session_id FROM payments WHERE id = $1',
    [paymentId],
  );
  return rows[0] as {
    status: string;
    amount: string;
    stripe_session_id: string | null;
  };
}

function event(
  type: string,
  object: object,
  id = `evt_${randomUUID().replace(/-/g, '')}`,
) {
  return {
    id,
    object: 'event',
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

async function webhook(
  body: object,
  sign: { secret?: string; header?: string | null } = {},
) {
  const payload = JSON.stringify(body);
  const signature =
    sign.header === undefined
      ? stripe.webhooks.generateTestHeaderString({
          payload,
          secret: sign.secret ?? WEBHOOK_SECRET,
        })
      : sign.header;
  const response = await fetch(`${baseUrl}/payments/webhooks/stripe`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(signature !== null ? { 'stripe-signature': signature } : {}),
    },
    body: payload,
  });
  return { status: response.status, body: await response.json() };
}

async function count(sql: string, params: unknown[] = []) {
  const { rows } = await pool.query(`SELECT count(*)::int AS n ${sql}`, params);
  return rows[0].n as number;
}

async function until(
  check: () => Promise<boolean> | boolean,
  timeoutMs = 10_000,
) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The value, or a test failure if it is missing. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error('expected a value');
  }
  return value;
}

const settle = () => new Promise((r) => setTimeout(r, 500));

// ---- tests ---------------------------------------------------------------------------------

describe('createTopUp', () => {
  it('refuses a request without a valid session', async () => {
    const { errors } = await topUp('forged', '5000');
    expect(errors?.[0].extensions?.code).toBe('FORBIDDEN');
  });

  it('stores a PENDING payment, opens Checkout and schedules the expiry', async () => {
    const user = signUp();

    const { data, errors } = await topUp(user.token, '5000');

    expect(errors).toBeUndefined();
    const { paymentId, checkoutUrl } = must(data).createTopUp;
    expect(checkoutUrl).toBe(
      `https://checkout.stripe.test/cs_test_${paymentId}`,
    );
    expect(await row(paymentId)).toEqual({
      status: 'PENDING',
      amount: '5000',
      stripe_session_id: `cs_test_${paymentId}`,
    });

    const [params, options] = must(createCalls.at(-1));
    expect(options).toEqual({
      idempotencyKey: `checkout-session:${paymentId}`,
    });
    expect(params).toMatchObject({
      mode: 'payment',
      line_items: [
        { quantity: 1, price_data: { currency: 'usd', unit_amount: 5000 } },
      ],
      metadata: { paymentId, userId: String(user.id) },
      client_reference_id: paymentId,
      success_url: `http://app.test/wallet?topup=${paymentId}`,
    });
    const lifetime = must(params.expires_at) - Date.now() / 1000;
    expect(lifetime).toBeGreaterThan(30 * 60);
    expect(lifetime).toBeLessThan(32 * 60);

    const { rows } = await pool.query(
      `SELECT transport, destination, key, payload FROM outbox
       WHERE payload->>'paymentId' = $1`,
      [paymentId],
    );
    expect(rows).toEqual([
      {
        transport: 'rabbitmq',
        destination: 'delay.1m',
        key: 'payment.expire',
        payload: { paymentId },
      },
    ]);
  });

  it.each([
    ['99', 'amount must be between $1.00 and $1,000.00'],
    ['100001', 'amount must be between $1.00 and $1,000.00'],
  ])('refuses %s minor units', async (amount, message) => {
    const user = signUp();
    const before = await count('FROM payments');

    const { errors } = await topUp(user.token, amount);

    expect(errors?.[0]).toMatchObject({
      message,
      extensions: { code: 'BAD_USER_INPUT' },
    });
    expect(await count('FROM payments')).toBe(before);
  });

  it('refuses a number instead of a string of minor units', async () => {
    const { errors } = await topUp(signUp().token, 5000);
    expect(errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('allows $2,000 per user in 24 hours, counting only PENDING and SUCCEEDED', async () => {
    const user = signUp();
    const first = await startTopUp(user.token, '100000');
    await startTopUp(user.token, '99900');

    const { errors } = await topUp(user.token, '101');
    expect(errors?.[0]).toMatchObject({
      message:
        'amount is over your limit of $2,000.00 per 24 hours: $1.00 left',
      extensions: { code: 'BAD_USER_INPUT' },
    });
    await startTopUp(user.token, '100');
    // Another user has their own limit.
    await startTopUp(signUp().token, '100000');

    // An expired top-up frees its share.
    await until(async () => (await row(first)).status === 'EXPIRED');
    await startTopUp(user.token, '100000');
  });

  it('marks the payment FAILED when Stripe is unreachable', async () => {
    const user = signUp();
    stripeDown = true;

    const { errors } = await topUp(user.token, '5000');

    expect(errors?.[0]).toMatchObject({
      message: 'Stripe is not available right now; try again in a minute',
      extensions: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
    });
    const { rows } = await pool.query(
      'SELECT status, stripe_session_id FROM payments WHERE user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([{ status: 'FAILED', stripe_session_id: null }]);
  });

  it('returns the first result for a retry with the same Idempotency-Key', async () => {
    const user = signUp();
    const key = randomUUID();

    const first = await topUp(user.token, '2500', key);
    const second = await topUp(user.token, '2500', key);

    expect(second.data).toEqual(first.data);
    expect(await count('FROM payments WHERE user_id = $1', [user.id])).toBe(1);
  });
});

describe('payment and payments queries', () => {
  const PAYMENT = `query ($id: ID!) { payment(id: $id) { id amount currency status } }`;

  it("returns the user's own payment and nobody else's", async () => {
    const owner = signUp();
    const paymentId = await startTopUp(owner.token, '1234');

    const mine = await gql(owner.token, PAYMENT, { id: paymentId });
    const theirs = await gql(signUp().token, PAYMENT, { id: paymentId });

    expect(mine.data).toEqual({
      payment: {
        id: paymentId,
        amount: '1234',
        currency: 'USD',
        status: 'PENDING',
      },
    });
    expect(theirs).toEqual({ data: { payment: null } });
  });

  it('answers BAD_USER_INPUT for an id that is not a UUID', async () => {
    const { errors } = await gql(signUp().token, PAYMENT, { id: '42' });
    expect(errors?.[0].extensions?.code).toBe('BAD_USER_INPUT');
  });

  it('lists payments newest first', async () => {
    const user = signUp();
    const a = await startTopUp(user.token, '100');
    const b = await startTopUp(user.token, '200');

    const { data } = await gql<{ payments: { id: string }[] }>(
      user.token,
      '{ payments { id } }',
    );

    expect(data?.payments.map((p) => p.id)).toEqual([b, a]);
  });
});

describe('Stripe webhook', () => {
  it('answers 400 to a bad or missing signature and writes nothing (acceptance 1)', async () => {
    const user = signUp();
    const paymentId = await startTopUp(user.token);
    const body = event('checkout.session.completed', pay(paymentId));
    const events = await count('FROM stripe_events');

    const wrong = await webhook(body, { secret: 'whsec_wrong' });
    const missing = await webhook(body, { header: null });
    const garbage = await webhook(body, { header: 't=1,v1=deadbeef' });

    expect([wrong.status, missing.status, garbage.status]).toEqual([
      400, 400, 400,
    ]);
    expect(await count('FROM stripe_events')).toBe(events);
    expect((await row(paymentId)).status).toBe('PENDING');
  });

  it('credits a paid session once, however often the event is resent', async () => {
    const user = signUp();
    const paymentId = await startTopUp(user.token, '5000');
    const completed = event('checkout.session.completed', pay(paymentId));

    const first = await webhook(completed);
    const resends = [];
    for (let i = 0; i < 10; i++) {
      resends.push(await webhook(completed));
    }

    expect(first).toEqual({
      status: 200,
      body: { received: true, duplicate: false },
    });
    expect(resends.every((r) => r.status === 200 && r.body.duplicate)).toBe(
      true,
    );
    expect((await row(paymentId)).status).toBe('SUCCEEDED');
    await until(() => succeededFor(paymentId).length > 0);
    await settle();
    expect(succeededFor(paymentId)).toEqual([
      {
        topic: 'payment-succeeded',
        key: String(user.id),
        data: { paymentId, userId: user.id, amount: '5000', currency: 'USD' },
      },
    ]);
  });

  it('keeps a SUCCEEDED payment when `expired` arrives after `completed` (acceptance 4)', async () => {
    const paymentId = await startTopUp(signUp().token);
    const session = pay(paymentId);

    await webhook(event('checkout.session.completed', session));
    const late = await webhook(
      event('checkout.session.expired', { ...session, status: 'expired' }),
    );

    expect(late.status).toBe(200);
    expect((await row(paymentId)).status).toBe('SUCCEEDED');
  });

  it('expires a PENDING payment on `checkout.session.expired`', async () => {
    const paymentId = await startTopUp(signUp().token);
    const session = must(checkout.get(`cs_test_${paymentId}`));

    await webhook(
      event('checkout.session.expired', { ...session, status: 'expired' }),
    );

    expect((await row(paymentId)).status).toBe('EXPIRED');
  });

  it('records a recon issue, not a credit, for a payment taken after it expired', async () => {
    const paymentId = await startTopUp(signUp().token);
    await until(async () => (await row(paymentId)).status === 'EXPIRED');
    const session = {
      ...must(checkout.get(`cs_test_${paymentId}`)),
      status: 'complete',
      payment_status: 'paid',
    };

    const completed = event('checkout.session.completed', session);
    await webhook(completed);

    expect((await row(paymentId)).status).toBe('EXPIRED');
    const { rows } = await pool.query(
      'SELECT kind, stripe_event_id FROM recon_issues WHERE payment_id = $1',
      [paymentId],
    );
    expect(rows).toEqual([
      { kind: 'paid_after_expired', stripe_event_id: completed.id },
    ]);
    await settle();
    expect(succeededFor(paymentId)).toEqual([]);
  });

  it('records a recon issue when the paid amount differs', async () => {
    const paymentId = await startTopUp(signUp().token, '5000');

    await webhook(
      event(
        'checkout.session.completed',
        pay(paymentId, { amount_total: 500 }),
      ),
    );

    expect((await row(paymentId)).status).toBe('PENDING');
    expect(
      await count('FROM recon_issues WHERE payment_id = $1 AND kind = $2', [
        paymentId,
        'amount_mismatch',
      ]),
    ).toBe(1);
  });

  it('stores and ignores sessions it did not create and other event types', async () => {
    const foreign = event('checkout.session.completed', {
      id: 'cs_test_foreign',
      object: 'checkout.session',
      status: 'complete',
      payment_status: 'paid',
      amount_total: 2000,
      currency: 'usd',
      metadata: {},
      client_reference_id: null,
    });
    const other = event('payment_intent.created', {
      id: 'pi_1',
      object: 'payment_intent',
    });

    expect((await webhook(foreign)).status).toBe(200);
    expect((await webhook(other)).status).toBe(200);
    expect(
      await count('FROM stripe_events WHERE event_id = ANY($1)', [
        [foreign.id, other.id],
      ]),
    ).toBe(2);
    expect(
      await count(
        "FROM recon_issues WHERE stripe_session_id = 'cs_test_foreign'",
      ),
    ).toBe(0);
  });
});

describe('payment.expire through the delay bucket', () => {
  it('expires an unpaid top-up at Stripe and here (acceptance 5)', async () => {
    const paymentId = await startTopUp(signUp().token);
    const started = Date.now();

    await until(async () => (await row(paymentId)).status === 'EXPIRED');

    expect(Date.now() - started).toBeGreaterThanOrEqual(EXPIRY_MS - 500);
    expect(checkout.get(`cs_test_${paymentId}`)?.status).toBe('expired');
    await settle();
    expect(succeededFor(paymentId)).toEqual([]);
  });

  it('settles a session paid at the last second instead of expiring it (acceptance 6)', async () => {
    const user = signUp();
    const paymentId = await startTopUp(user.token, '700');
    const session = pay(paymentId); // paid, but the webhook hasn't arrived yet

    await until(async () => (await row(paymentId)).status !== 'PENDING');
    expect((await row(paymentId)).status).toBe('SUCCEEDED');
    expect(checkout.get(session.id)?.status).toBe('complete');

    // The webhook arrives afterwards and finds the payment settled.
    const late = await webhook(event('checkout.session.completed', session));
    expect(late.status).toBe(200);
    await until(() => succeededFor(paymentId).length > 0);
    await settle();
    expect(succeededFor(paymentId)).toHaveLength(1);
    expect(succeededFor(paymentId)[0].data).toEqual({
      paymentId,
      userId: user.id,
      amount: '700',
      currency: 'USD',
    });
  });

  it('retries when Stripe is unreachable, then expires', async () => {
    const paymentId = await startTopUp(signUp().token);
    expireFailures = 1;

    // First attempt after EXPIRY_MS fails; the retry queue waits 5 s.
    await until(
      async () => (await row(paymentId)).status === 'EXPIRED',
      15_000,
    );
    expect(expireFailures).toBe(0);
  }, 20_000);

  it('leaves a FAILED payment alone', async () => {
    const user = signUp();
    stripeDown = true;
    await topUp(user.token, '5000');
    stripeDown = false;
    const { rows } = await pool.query(
      'SELECT id FROM payments WHERE user_id = $1',
      [user.id],
    );

    await new Promise((r) => setTimeout(r, EXPIRY_MS + 1_000));

    expect((await row(rows[0].id)).status).toBe('FAILED');
  });
});

it('prints the schema that apps/payments/schema.gql has committed', () => {
  const committed = readFileSync(
    join(__dirname, '../../../schema.gql'),
    'utf8',
  );
  expect(readFileSync(schemaFile, 'utf8')).toBe(committed);
});

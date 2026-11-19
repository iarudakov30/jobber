import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { OutboxRelay } from '@jobber/outbox';
import { NonRetryableError, PulsarClient } from '@jobber/pulsar';
import {
  TestDatabase,
  expectBooksBalanced,
  startTestDatabase,
} from '../../testing/test-database';
import { LedgerService } from '../ledger/ledger.service';
import { PaymentSucceededConsumer } from './payment-succeeded.consumer';

// The top-up credit against a real PostgreSQL (Testcontainers): the guarantees under test
// (one credit per paymentId, the email exactly when the credit) live in the database.

let testDb: TestDatabase;
let pool: Pool;
let consumer: PaymentSucceededConsumer;
const relay = { poke: jest.fn() };

beforeAll(async () => {
  testDb = await startTestDatabase();
  pool = testDb.pool;
  consumer = new PaymentSucceededConsumer(
    {} as PulsarClient,
    new LedgerService(testDb.db),
    relay as unknown as OutboxRelay,
  );
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.container.stop();
});

afterEach(() => expectBooksBalanced(pool));

let lastUserId = 1000;
function paid(amount = '5000', userId = ++lastUserId) {
  return { paymentId: randomUUID(), userId, amount, currency: 'USD' };
}

async function available(userId: number) {
  const { rows } = await pool.query(
    `SELECT coalesce(sum(balance), 0)::text AS total FROM accounts
     WHERE owner_type = 'user' AND owner_id = $1 AND kind = 'available'`,
    [String(userId)],
  );
  return rows[0].total as string;
}

async function topups(paymentId: string) {
  const { rows } = await pool.query(
    `SELECT id FROM transactions WHERE type = 'topup' AND external_ref = $1`,
    [paymentId],
  );
  return rows.length;
}

async function emails(paymentId: string) {
  const { rows } = await pool.query(
    `SELECT transport, destination, key, payload FROM outbox
     WHERE payload->>'paymentId' = $1`,
    [paymentId],
  );
  return rows;
}

it('credits the user from stripe_clearing and queues one email, in one transaction', async () => {
  const message = paid('5000');

  await expect(consumer.credit(message)).resolves.toEqual({ duplicate: false });

  expect(await available(message.userId)).toBe('5000');
  expect(await topups(message.paymentId)).toBe(1);
  expect(await emails(message.paymentId)).toEqual([
    {
      transport: 'rabbitmq',
      destination: 'notifications',
      key: 'email.topup',
      payload: {
        userId: message.userId,
        paymentId: message.paymentId,
        amount: '5000',
        currency: 'USD',
      },
    },
  ]);
  expect(relay.poke).toHaveBeenCalled();
});

it('credits once and emails once when the message is redelivered (acceptance 7)', async () => {
  const message = paid('2500');
  await consumer.credit(message);

  // A crash after the commit and before the ack: Pulsar delivers the message again, maybe
  // several times, maybe to two replicas at once.
  const again = await Promise.all(
    Array.from({ length: 5 }, () => consumer.credit({ ...message })),
  );

  expect(again.every((r) => r.duplicate)).toBe(true);
  expect(await available(message.userId)).toBe('2500');
  expect(await topups(message.paymentId)).toBe(1);
  expect(await emails(message.paymentId)).toHaveLength(1);
});

it('credits concurrent first deliveries of one payment once', async () => {
  const message = paid('700');

  const results = await Promise.all(
    Array.from({ length: 10 }, () => consumer.credit({ ...message })),
  );

  expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
  expect(await available(message.userId)).toBe('700');
  expect(await emails(message.paymentId)).toHaveLength(1);
});

it('adds up several top-ups for one user', async () => {
  const userId = ++lastUserId;
  await consumer.credit(paid('100', userId));
  await consumer.credit(paid('250', userId));

  expect(await available(userId)).toBe('350');
});

it.each([
  ['a numeric amount', { amount: 5000 }],
  ['a zero amount', { amount: '0' }],
  ['an unknown currency', { currency: 'EUR' }],
  ['a missing paymentId', { paymentId: undefined }],
])('dead-letters %s without writing anything', async (_, change) => {
  const message = { ...paid(), ...change };

  const call = consumer.credit(message);

  await expect(call).rejects.toBeInstanceOf(NonRetryableError);
  expect(await available(message.userId)).toBe('0');
});

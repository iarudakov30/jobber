import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { DrizzleOutboxStore } from './drizzle-outbox.store';
import { NewOutboxRecord, OutboxRecord } from './outbox.types';

// Against a real PostgreSQL (Docker required): the store is SQL, and what matters (array
// parameters, jsonb round-trips, SKIP LOCKED) only shows up in a real database.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let store: DrizzleOutboxStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = drizzle(pool);
  store = new DrizzleOutboxStore(db);
  // The table from outbox.types.ts.
  await pool.query(`
    CREATE TABLE outbox (
      id           BIGSERIAL PRIMARY KEY,
      transport    TEXT        NOT NULL,
      destination  TEXT        NOT NULL,
      key          TEXT,
      payload      JSONB       NOT NULL,
      headers      JSONB       NOT NULL DEFAULT '{}',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ
    );
    CREATE INDEX ON outbox (published_at, id);`);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

beforeEach(() => pool.query('TRUNCATE outbox RESTART IDENTITY'));

const record = (i: number, extra: Partial<NewOutboxRecord> = {}) => ({
  transport: 'pulsar' as const,
  destination: 'transfer-completed',
  key: `k${i}`,
  payload: { i, amount: '1250', nested: { ok: true } },
  ...extra,
});

async function enqueue(records: NewOutboxRecord[]) {
  await db.transaction((tx) => store.enqueue(tx, records));
}

async function unpublishedIds() {
  const { rows } = await pool.query(
    'SELECT id::int FROM outbox WHERE published_at IS NULL ORDER BY id',
  );
  return rows.map((r) => r.id as number);
}

describe('DrizzleOutboxStore.enqueue', () => {
  it('writes every record, payload and headers intact, in chunks of 1,000', async () => {
    await enqueue([
      ...Array.from({ length: 1000 }, (_, i) => record(i)),
      record(1000, { key: undefined, headers: { traceparent: 'x' } }),
    ]);

    const { rows } = await pool.query(
      'SELECT key, payload, headers FROM outbox ORDER BY id',
    );
    expect(rows).toHaveLength(1001);
    expect(rows[0]).toEqual({
      key: 'k0',
      payload: { i: 0, amount: '1250', nested: { ok: true } },
      headers: {},
    });
    expect(rows[1000]).toEqual({
      key: null,
      payload: { i: 1000, amount: '1250', nested: { ok: true } },
      headers: { traceparent: 'x' },
    });
  });

  it("writes nothing when the caller's transaction rolls back", async () => {
    await expect(
      db.transaction(async (tx) => {
        await store.enqueue(tx, [record(1)]);
        throw new Error('state change failed');
      }),
    ).rejects.toThrow('state change failed');

    expect(await unpublishedIds()).toEqual([]);
  });
});

describe('DrizzleOutboxStore.processBatch', () => {
  it('publishes in id order with bigint ids and marks them published', async () => {
    await enqueue([record(1), record(2), record(3)]);
    const seen: OutboxRecord[] = [];

    const result = await store.processBatch(2, async (r) => {
      seen.push(r);
    });

    expect(result).toEqual({ published: 2, error: undefined });
    expect(seen.map((r) => r.id)).toEqual([1n, 2n]);
    expect(seen[0]).toEqual({
      id: 1n,
      transport: 'pulsar',
      destination: 'transfer-completed',
      key: 'k1',
      payload: { i: 1, amount: '1250', nested: { ok: true } },
      headers: {},
    });
    expect(await unpublishedIds()).toEqual([3]);
  });

  it('stops at the first failure but keeps what went out marked', async () => {
    await enqueue([record(1), record(2), record(3)]);
    const failure = new Error('broker down');
    const publish = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure);

    const result = await store.processBatch(100, publish);

    expect(result).toEqual({ published: 1, error: failure });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await unpublishedIds()).toEqual([2, 3]);
  });

  it('claims only the given transport, so one broker cannot block another', async () => {
    await enqueue([
      record(1, { transport: 'rabbitmq' }),
      record(2),
      record(3, { transport: 'rabbitmq' }),
      record(4),
    ]);
    const seen: bigint[] = [];

    const result = await store.processBatch(
      100,
      async (r) => {
        seen.push(r.id);
      },
      'pulsar',
    );

    expect(result).toEqual({ published: 2, error: undefined });
    expect(seen).toEqual([2n, 4n]);
    expect(await unpublishedIds()).toEqual([1, 3]);
  });

  it('never gives the same record to two relays at once', async () => {
    await enqueue(Array.from({ length: 50 }, (_, i) => record(i)));
    const published: bigint[] = [];
    const slowPublish = async (r: OutboxRecord) => {
      published.push(r.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
    };

    await Promise.all(
      Array.from({ length: 5 }, () => store.processBatch(20, slowPublish)),
    );

    expect(new Set(published).size).toBe(published.length);
    expect(published.length + (await unpublishedIds()).length).toBe(50);
  });
});

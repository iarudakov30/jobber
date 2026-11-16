import {
  Body,
  Controller,
  INestApplication,
  Module,
  Post,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import { DrizzleIdempotencyStore } from './drizzle-idempotency.store';
import { REPLAYED_HEADER } from './idempotency.interceptor';
import {
  IDEMPOTENCY_LOCK,
  IDEMPOTENCY_STORE,
  IdempotencyLock,
  LockResult,
} from './idempotency.types';
import { Idempotent, IdempotencyKey } from './idempotent.decorator';

// The store and the interceptor against a real PostgreSQL (Docker required): the guarantee is
// the atomic claim, which only a real database can show under concurrency.

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: NodePgDatabase;
let store: DrizzleIdempotencyStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  db = drizzle(pool);
  store = new DrizzleIdempotencyStore(db);
  // The table idempotencyKeysTable() describes (apps get it from drizzle-kit).
  await pool.query(`
    CREATE TABLE idempotency_keys (
      scope        TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      status       TEXT NOT NULL,
      response     JSONB,
      locked_until TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at   TIMESTAMPTZ
    );
    CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);`);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

let lastScope = 0;
const newScope = () => `user:op:${++lastScope}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DrizzleIdempotencyStore', () => {
  it('claims a new key once; a second claim sees it in progress', async () => {
    const scope = newScope();

    expect(await store.claim(scope, 'h1', 30_000)).toEqual({ kind: 'claimed' });
    expect(await store.claim(scope, 'h1', 30_000)).toEqual({
      kind: 'in_progress',
    });
  });

  it('reports a different request under the same key as a mismatch', async () => {
    const scope = newScope();
    await store.claim(scope, 'h1', 30_000);

    expect(await store.claim(scope, 'h2', 30_000)).toEqual({
      kind: 'mismatch',
    });
    await store.complete(scope, 'h1', '{"ok":true}', 60_000);
    expect(await store.claim(scope, 'h2', 30_000)).toEqual({
      kind: 'mismatch',
    });
  });

  it('replays the stored response once completed', async () => {
    const scope = newScope();
    await store.claim(scope, 'h1', 30_000);
    await store.complete(scope, 'h1', '{"amount":{"$bigint":"1250"}}', 60_000);

    expect(await store.claim(scope, 'h1', 30_000)).toEqual({
      kind: 'replay',
      response: '{"amount": {"$bigint": "1250"}}',
    });
  });

  it('frees a released key for a retry', async () => {
    const scope = newScope();
    await store.claim(scope, 'h1', 30_000);
    await store.release(scope, 'h1');

    expect(await store.claim(scope, 'h1', 30_000)).toEqual({ kind: 'claimed' });
  });

  it('lets a retry take over once the lease has expired, exactly once', async () => {
    const scope = newScope();
    await store.claim(scope, 'h1', 1);
    await sleep(20);

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.claim(scope, 'h1', 30_000)),
    );

    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
    expect(results.filter((r) => r.kind === 'in_progress')).toHaveLength(9);
  });

  it('gives a new key to exactly one of 20 concurrent claims', async () => {
    const scope = newScope();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.claim(scope, 'h1', 30_000)),
    );

    expect(results.filter((r) => r.kind === 'claimed')).toHaveLength(1);
  });

  it('treats a key past its TTL as new, and cleanup deletes such keys', async () => {
    const reused = newScope();
    const forgotten = newScope();
    for (const scope of [reused, forgotten]) {
      await store.claim(scope, 'h1', 30_000);
      await store.complete(scope, 'h1', 'null', 1);
    }
    await sleep(20);

    expect(await store.claim(reused, 'h2', 30_000)).toEqual({
      kind: 'claimed',
    });
    expect(await store.deleteExpired()).toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query(
      'SELECT scope FROM idempotency_keys WHERE scope = ANY($1)',
      [[reused, forgotten]],
    );
    expect(rows).toEqual([{ scope: reused }]);
  });
});

describe('@Idempotent() on an HTTP handler', () => {
  let app: INestApplication;
  let url: string;
  const calls: unknown[] = [];
  let failNext = false;
  /** An in-memory stand-in for Redis: just enough to show the 409 path. */
  const lockedScopes = new Set<string>();
  const lock: IdempotencyLock = {
    async acquire(scope): Promise<LockResult> {
      if (lockedScopes.has(scope)) return { status: 'taken' };
      lockedScopes.add(scope);
      return { status: 'acquired', token: scope };
    },
    async release(scope) {
      lockedScopes.delete(scope);
    },
  };

  @Controller('payments')
  class PaymentsController {
    @Post()
    @Idempotent({ operation: 'pay' })
    async pay(
      @Body() body: { amount: number; slowMs?: number },
      @IdempotencyKey() key: string,
    ) {
      calls.push(body);
      if (body.slowMs) await sleep(body.slowMs);
      if (failNext) {
        failNext = false;
        throw new Error('payment provider down');
      }
      return { paid: body.amount, key, at: new Date('2026-01-01T00:00:00Z') };
    }
  }

  @Module({
    controllers: [PaymentsController],
    providers: [
      { provide: IDEMPOTENCY_STORE, useFactory: () => store }, // set in beforeAll
      { provide: IDEMPOTENCY_LOCK, useValue: lock },
    ],
  })
  class PaymentsModule {}

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PaymentsModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `${(await app.getUrl()).replace('[::1]', 'localhost')}/payments`;
  });

  afterAll(() => app?.close());

  beforeEach(() => {
    calls.length = 0;
  });

  let lastKey = 0;
  const newKey = () => `key-${Date.now()}-${++lastKey}`;

  function pay(body: object, key: string | null) {
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key !== null ? { 'idempotency-key': key } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('requires the Idempotency-Key header', async () => {
    for (const key of [null, '', 'has space', 'x'.repeat(256)]) {
      const response = await pay({ amount: 1 }, key);

      expect(response.status).toBe(400);
    }
    expect(calls).toEqual([]);
  });

  it('runs once and replays the same response for a retry', async () => {
    const key = newKey();

    const first = await pay({ amount: 5 }, key);
    const retry = await pay({ amount: 5 }, key);

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual(await first.json());
    expect(first.headers.get(REPLAYED_HEADER)).toBeNull();
    expect(retry.headers.get(REPLAYED_HEADER)).toBe('true');
    expect(calls).toEqual([{ amount: 5 }]);
  });

  it('refuses the key with a different body (422) and runs nothing', async () => {
    const key = newKey();
    await pay({ amount: 5 }, key);

    const reused = await pay({ amount: 6 }, key);

    expect(reused.status).toBe(422);
    expect(await reused.json()).toMatchObject({
      error: 'UNPROCESSABLE_ENTITY',
    });
    expect(calls).toEqual([{ amount: 5 }]);
  });

  it('lets the client retry after the handler failed', async () => {
    const key = newKey();
    failNext = true;

    expect((await pay({ amount: 7 }, key)).status).toBe(500);
    const retry = await pay({ amount: 7 }, key);

    expect(retry.status).toBe(201);
    expect(calls).toHaveLength(2);
  });

  it('runs a burst of 20 identical requests once; the rest get 409 or the replay', async () => {
    const key = newKey();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => pay({ amount: 9, slowMs: 100 }, key)),
    );

    expect(calls).toHaveLength(1);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
  });

  it('still runs once without the lock (Redis down): PostgreSQL decides', async () => {
    const key = newKey();
    const acquire = jest
      .spyOn(lock, 'acquire')
      .mockResolvedValue({ status: 'unavailable' });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => pay({ amount: 3, slowMs: 100 }, key)),
    );

    acquire.mockRestore();
    expect(calls).toHaveLength(1);
    expect(responses.every((r) => r.status === 201 || r.status === 409)).toBe(
      true,
    );
  });
});

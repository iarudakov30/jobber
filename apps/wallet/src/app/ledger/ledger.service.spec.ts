import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';
import { Pool } from 'pg';
import { InsufficientFundsError, InvalidPostingError } from './ledger.errors';
import { LedgerDatabase, LedgerService } from './ledger.service';
import * as schema from './schema';
import { accounts, entries, transactions } from './schema';

// Integration tests against a real PostgreSQL (Docker required): the guarantees under test
// live in the database (constraints, triggers, row locks), so mocks would prove nothing.

const USD = 'USD';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: LedgerDatabase;
let ledger: LedgerService;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:18-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri(), max: 20 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: join(__dirname, '../../../drizzle') });
  // A second asset, to check that an entry can't land on an account of another asset.
  await db.insert(schema.assets).values({ code: 'XTS', scale: 2 });
  ledger = new LedgerService(db);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

// Whatever a test did, the books must still balance.
afterEach(async () => {
  const { rows: assetSums } = await pool.query(
    'SELECT asset, sum(balance)::text AS total FROM accounts GROUP BY asset',
  );
  for (const row of assetSums) {
    expect(row).toEqual({ asset: row.asset, total: '0' });
  }
  const { rows: drifted } = await pool.query(`
    SELECT a.id FROM accounts a
    LEFT JOIN entries e ON e.account_id = a.id
    GROUP BY a.id, a.balance
    HAVING a.balance <> coalesce(sum(e.amount), 0)`);
  expect(drifted).toEqual([]);
});

let lastId = 0;
const nextId = () => `${Date.now()}-${++lastId}`;

async function newUser(cents = 0n) {
  const userId = nextId();
  const user = await ledger.ensureAccounts(userId, USD);
  if (cents > 0n) {
    const seed = await ledger.ensureSystemAccount('seed', USD);
    await ledger.post({
      type: 'seed',
      externalRef: `seed:${userId}`,
      legs: [
        { accountId: seed, asset: USD, amount: -cents },
        { accountId: user.available, asset: USD, amount: cents },
      ],
    });
  }
  return user.available;
}

function transfer(from: bigint, to: bigint, cents: bigint, ref = nextId()) {
  return ledger.post({
    type: 'transfer',
    externalRef: `transfer:${ref}`,
    legs: [
      { accountId: from, asset: USD, amount: -cents },
      { accountId: to, asset: USD, amount: cents },
    ],
  });
}

async function balanceOf(accountId: bigint) {
  const [row] = await db
    .select({ balance: accounts.balance })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return row.balance;
}

/** Every message in the rejection's `cause` chain (Drizzle wraps the `pg` error). */
async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = e.cause) {
      messages.push(e.message);
    }
    return messages.join(' <- ');
  }
  throw new Error('Expected the promise to reject');
}

async function countTransactions(type: string, externalRef: string) {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM transactions WHERE type = $1 AND external_ref = $2',
    [type, externalRef],
  );
  return rows[0].n as number;
}

describe('LedgerService.post', () => {
  it('moves money and writes one entry per leg', async () => {
    const alice = await newUser(10_000n);
    const bob = await newUser();

    const result = await transfer(alice, bob, 1_250n);

    expect(result.duplicate).toBe(false);
    expect(await balanceOf(alice)).toBe(8_750n);
    expect(await balanceOf(bob)).toBe(1_250n);
    const written = await db
      .select({ accountId: entries.accountId, amount: entries.amount })
      .from(entries)
      .where(eq(entries.transactionId, result.transactionId));
    expect(written).toEqual(
      expect.arrayContaining([
        { accountId: alice, amount: -1_250n },
        { accountId: bob, amount: 1_250n },
      ]),
    );
    expect(written).toHaveLength(2);
  });

  it('lets system accounts go negative', async () => {
    await newUser(500n);
    const seed = await ledger.ensureSystemAccount('seed', USD);

    expect(await balanceOf(seed)).toBeLessThan(0n);
  });

  it.each([
    [
      'legs that do not sum to zero',
      (a: bigint, b: bigint) => [
        { accountId: a, asset: USD, amount: -100n },
        { accountId: b, asset: USD, amount: 99n },
      ],
    ],
    [
      'a single leg',
      (a: bigint) => [{ accountId: a, asset: USD, amount: 100n }],
    ],
    [
      'a zero amount',
      (a: bigint, b: bigint) => [
        { accountId: a, asset: USD, amount: 0n },
        { accountId: b, asset: USD, amount: 0n },
      ],
    ],
    [
      'an unknown account',
      (a: bigint) => [
        { accountId: a, asset: USD, amount: -100n },
        { accountId: 999_999_999n, asset: USD, amount: 100n },
      ],
    ],
  ])('rejects %s and writes nothing', async (_, legs) => {
    const alice = await newUser(1_000n);
    const bob = await newUser();
    const ref = `bad:${nextId()}`;

    await expect(
      ledger.post({
        type: 'transfer',
        externalRef: ref,
        legs: legs(alice, bob),
      }),
    ).rejects.toThrow(InvalidPostingError);

    expect(await countTransactions('transfer', ref)).toBe(0);
    expect(await balanceOf(alice)).toBe(1_000n);
  });

  it("rejects a leg whose asset is not its account's asset", async () => {
    const alice = await newUser(1_000n);
    const { available: xts } = await ledger.ensureAccounts(nextId(), 'XTS');

    await expect(
      ledger.post({
        type: 'transfer',
        externalRef: nextId(),
        legs: [
          { accountId: alice, asset: USD, amount: -100n },
          { accountId: xts, asset: USD, amount: 100n },
        ],
      }),
    ).rejects.toThrow(InvalidPostingError);
  });

  it('posts a repeated externalRef once and reports the duplicate', async () => {
    const alice = await newUser(1_000n);
    const bob = await newUser();

    const first = await transfer(alice, bob, 300n, 'same');
    const second = await transfer(alice, bob, 300n, 'same');

    expect(second).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await balanceOf(alice)).toBe(700n);
    expect(await balanceOf(bob)).toBe(300n);
  });

  it('refuses an overdraft and writes nothing, so the ref can be posted later', async () => {
    const alice = await newUser(100n);
    const bob = await newUser();

    const overdraft = transfer(alice, bob, 101n, 'retry-later');
    await expect(overdraft).rejects.toThrow(InsufficientFundsError);
    await expect(overdraft).rejects.toMatchObject({ accountId: alice });
    expect(await countTransactions('transfer', 'transfer:retry-later')).toBe(0);
    expect(await balanceOf(alice)).toBe(100n);

    const seed = await ledger.ensureSystemAccount('seed', USD);
    await ledger.post({
      type: 'seed',
      externalRef: `top-up:${nextId()}`,
      legs: [
        { accountId: seed, asset: USD, amount: -1n },
        { accountId: alice, asset: USD, amount: 1n },
      ],
    });
    const retried = await transfer(alice, bob, 101n, 'retry-later');

    expect(retried.duplicate).toBe(false);
    expect(await balanceOf(alice)).toBe(0n);
  });
});

describe('ledger invariants enforced by the database', () => {
  it('refuses to commit an unbalanced transaction', async () => {
    const alice = await newUser();
    const ref = `raw:${nextId()}`;

    const unbalanced = failure(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(transactions)
          .values({ type: 'raw', externalRef: ref })
          .returning({ id: transactions.id });
        // The cached balance is kept in step so only the balance trigger can object.
        await tx
          .update(accounts)
          .set({ balance: sql`${accounts.balance} + 100` })
          .where(eq(accounts.id, alice));
        await tx
          .insert(entries)
          .values({
            transactionId: t.id,
            accountId: alice,
            asset: USD,
            amount: 100n,
          });
      }),
    );

    expect(await unbalanced).toMatch(/is not balanced/);
    expect(await countTransactions('raw', ref)).toBe(0);
  });

  it.each([
    ['UPDATE', 'UPDATE entries SET amount = amount * 2'],
    ['DELETE', 'DELETE FROM entries'],
    ['TRUNCATE', 'TRUNCATE entries'],
  ])('refuses %s on entries', async (_, statement) => {
    await newUser(100n);

    expect(await failure(pool.query(statement))).toMatch(/append-only/);
  });

  it('refuses an entry on an account of another asset', async () => {
    const { available: xts } = await ledger.ensureAccounts(nextId(), 'XTS');

    const wrongAsset = failure(
      db.transaction(async (tx) => {
        const [t] = await tx
          .insert(transactions)
          .values({ type: 'raw', externalRef: nextId() })
          .returning({ id: transactions.id });
        await tx.insert(entries).values([
          { transactionId: t.id, accountId: xts, asset: USD, amount: 100n },
          { transactionId: t.id, accountId: xts, asset: USD, amount: -100n },
        ]);
      }),
    );

    expect(await wrongAsset).toMatch(/entries_account_asset_fk/);
  });
});

describe('concurrency', () => {
  it('never overdraws: 200 parallel $1 transfers from $100, exactly 100 succeed', async () => {
    const alice = await newUser(10_000n);
    const bob = await newUser();

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, () => transfer(alice, bob, 100n)),
    );

    const failed = results.filter((r) => r.status === 'rejected');
    expect(results.length - failed.length).toBe(100);
    for (const f of failed) {
      expect(f.reason).toBeInstanceOf(InsufficientFundsError);
    }
    expect(await balanceOf(alice)).toBe(0n);
    expect(await balanceOf(bob)).toBe(10_000n);
  });

  it('does not deadlock: 100 parallel transfers each way', async () => {
    const alice = await newUser(10_000n);
    const bob = await newUser(10_000n);

    const results = await Promise.allSettled(
      Array.from({ length: 200 }, (_, i) =>
        i % 2 ? transfer(alice, bob, 100n) : transfer(bob, alice, 100n),
      ),
    );

    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(await balanceOf(alice)).toBe(10_000n);
    expect(await balanceOf(bob)).toBe(10_000n);
  });

  it('posts once when the same externalRef arrives 20 times at once', async () => {
    const alice = await newUser(1_000n);
    const bob = await newUser();
    const ref = nextId();

    const results = await Promise.all(
      Array.from({ length: 20 }, () => transfer(alice, bob, 100n, ref)),
    );

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balanceOf(bob)).toBe(100n);
  });

  it('creates accounts once when ensureAccounts races with itself', async () => {
    const userId = nextId();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ledger.ensureAccounts(userId, USD)),
    );

    expect(new Set(results.map((r) => r.available)).size).toBe(1);
    expect(new Set(results.map((r) => r.held)).size).toBe(1);
    expect(results[0].available).not.toBe(results[0].held);
  });
});

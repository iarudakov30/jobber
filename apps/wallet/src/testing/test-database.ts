import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';
import { Pool } from 'pg';
import { LedgerDatabase } from '../app/ledger/ledger.service';
import * as schema from '../app/ledger/schema';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: LedgerDatabase;
}

/**
 * A migrated PostgreSQL 18 in Docker (Testcontainers), for tests of guarantees that live in the
 * database (constraints, triggers, row locks), where mocks would prove nothing.
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:18-alpine').start();
  const pool = new Pool({
    connectionString: container.getConnectionUri(),
    max: 20,
  });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: join(__dirname, '../../drizzle') });
  return { container, pool, db };
}

/** Whatever a test did, the books must still balance. Call it in `afterEach`. */
export async function expectBooksBalanced(pool: Pool): Promise<void> {
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
}

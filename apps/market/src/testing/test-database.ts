import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'path';
import { Pool } from 'pg';
import { MarketDatabase, schema } from '../app/database/database';

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: MarketDatabase;
}

/** A migrated PostgreSQL 18 in Docker (Testcontainers). */
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

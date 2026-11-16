import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { ClaimResult, IdempotencyStore } from './idempotency.types';

/** A Drizzle PostgreSQL database, whatever its driver and schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzlePgDatabase = PgDatabase<PgQueryResultHKT, any, any>;

interface KeyRow {
  request_hash: string;
  status: 'in_progress' | 'completed';
  response: string | null;
  lease_expired: boolean | null;
  expired: boolean | null;
}

/** A key that's been claimed in progress for this long is abandoned, whatever its lease. */
const ABANDONED_AFTER = '1 day';

/**
 * Idempotency keys in PostgreSQL. Every decision is one atomic statement (an insert with
 * ON CONFLICT DO NOTHING, or a conditional update), so concurrent requests with the same key
 * can't both claim it, Redis or not.
 */
export class DrizzleIdempotencyStore implements IdempotencyStore {
  private readonly table: ReturnType<typeof sql.identifier>;

  constructor(
    private readonly db: DrizzlePgDatabase,
    tableName = 'idempotency_keys',
  ) {
    this.table = sql.identifier(tableName);
  }

  async claim(
    scope: string,
    requestHash: string,
    leaseMs: number,
  ): Promise<ClaimResult> {
    // A few rounds at most: a row can vanish (released after a failure) or be taken over
    // between our statements.
    for (let attempt = 0; attempt < 5; attempt++) {
      const inserted = rowsOf(
        await this.db.execute(sql`
          INSERT INTO ${this.table} (scope, request_hash, status, locked_until)
          VALUES (${scope}, ${requestHash}, 'in_progress', now() + ${leaseMs} * interval '1 millisecond')
          ON CONFLICT (scope) DO NOTHING
          RETURNING scope`),
      );
      if (inserted.length) {
        return { kind: 'claimed' };
      }

      const [row] = rowsOf<KeyRow>(
        await this.db.execute(sql`
          SELECT request_hash, status, response::text AS response,
                 locked_until <= now() AS lease_expired, expires_at <= now() AS expired
          FROM ${this.table} WHERE scope = ${scope}`),
      );
      if (!row) {
        continue; // released meanwhile: try to insert again
      }

      if (row.status === 'completed' && row.expired) {
        // Past its TTL: the key is free again (cleanup just hasn't deleted it yet).
        if (
          await this.update(sql`
            UPDATE ${this.table}
            SET request_hash = ${requestHash}, status = 'in_progress', response = NULL,
                expires_at = NULL,
                locked_until = now() + ${leaseMs} * interval '1 millisecond'
            WHERE scope = ${scope} AND status = 'completed' AND expires_at <= now()
            RETURNING scope`)
        ) {
          return { kind: 'claimed' };
        }
        continue;
      }
      if (row.request_hash !== requestHash) {
        return { kind: 'mismatch' };
      }
      if (row.status === 'completed') {
        return { kind: 'replay', response: row.response ?? 'null' };
      }
      if (!row.lease_expired) {
        return { kind: 'in_progress' };
      }
      // The claimant ran out of lease (crashed, or slower than leaseMs): take the key over.
      if (
        await this.update(sql`
          UPDATE ${this.table}
          SET locked_until = now() + ${leaseMs} * interval '1 millisecond'
          WHERE scope = ${scope} AND status = 'in_progress' AND locked_until <= now()
          RETURNING scope`)
      ) {
        return { kind: 'claimed' };
      }
      return { kind: 'in_progress' };
    }
    return { kind: 'in_progress' };
  }

  async complete(
    scope: string,
    requestHash: string,
    response: string,
    ttlMs: number,
  ): Promise<void> {
    await this.db.execute(sql`
      UPDATE ${this.table}
      SET status = 'completed', response = ${response}::jsonb, locked_until = NULL,
          expires_at = now() + ${ttlMs} * interval '1 millisecond'
      WHERE scope = ${scope} AND request_hash = ${requestHash} AND status = 'in_progress'`);
  }

  async release(scope: string, requestHash: string): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM ${this.table}
      WHERE scope = ${scope} AND request_hash = ${requestHash} AND status = 'in_progress'`);
  }

  async deleteExpired(): Promise<number> {
    const deleted = rowsOf(
      await this.db.execute(sql`
        DELETE FROM ${this.table}
        WHERE expires_at <= now()
           OR (status = 'in_progress' AND created_at <= now() - ${ABANDONED_AFTER}::interval)
        RETURNING scope`),
    );
    return deleted.length;
  }

  private async update(query: ReturnType<typeof sql>): Promise<boolean> {
    return rowsOf(await this.db.execute(query)).length > 0;
  }
}

/** node-postgres returns `{ rows }`; postgres.js returns the rows array itself. */
function rowsOf<T = unknown>(result: unknown): T[] {
  return (
    Array.isArray(result) ? result : (result as { rows: T[] }).rows
  ) as T[];
}

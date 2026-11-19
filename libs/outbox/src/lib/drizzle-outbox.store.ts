import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import {
  BatchResult,
  NewOutboxRecord,
  OutboxRecord,
  OutboxStore,
  OutboxTransport,
} from './outbox.types';
import { withTraceHeaders } from './trace-headers';

/** A Drizzle PostgreSQL database or transaction, whatever its driver and schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzlePgDatabase = PgDatabase<PgQueryResultHKT, any, any>;

interface OutboxRow {
  // node-postgres returns int8 columns as strings.
  id: string | bigint;
  transport: OutboxRecord['transport'];
  destination: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

const INSERT_CHUNK = 1000;

/**
 * The outbox store for apps on Drizzle. Same contract and SQL as `PrismaOutboxStore`; the
 * `outbox` table is described in `outbox.types.ts`.
 */
export class DrizzleOutboxStore implements OutboxStore {
  constructor(private readonly db: DrizzlePgDatabase) {}

  /**
   * Writes `records` inside the caller's transaction `tx`. The active trace context is saved in
   * each record's headers, so publishing later (outside the request) stays in the same trace.
   */
  async enqueue(
    tx: DrizzlePgDatabase,
    records: NewOutboxRecord[],
  ): Promise<void> {
    records = withTraceHeaders(records);
    for (let i = 0; i < records.length; i += INSERT_CHUNK) {
      const chunk = records.slice(i, i + INSERT_CHUNK);
      // sql.param() sends each JS array as one PostgreSQL array parameter; a bare array in
      // Drizzle's `sql` tag would be expanded into a list instead.
      await tx.execute(sql`
        INSERT INTO outbox (transport, destination, key, payload, headers)
        SELECT * FROM unnest(
          ${sql.param(chunk.map((r) => r.transport))}::text[],
          ${sql.param(chunk.map((r) => r.destination))}::text[],
          ${sql.param(chunk.map((r) => r.key ?? null))}::text[],
          ${sql.param(chunk.map((r) => JSON.stringify(r.payload)))}::jsonb[],
          ${sql.param(chunk.map((r) => JSON.stringify(r.headers ?? {})))}::jsonb[]
        )`);
    }
  }

  processBatch(
    limit: number,
    publish: (record: OutboxRecord) => Promise<void>,
    transport?: OutboxTransport,
  ): Promise<BatchResult> {
    return this.db.transaction(async (tx) => {
      const rows = rowsOf<OutboxRow>(
        await tx.execute(sql`
          SELECT id, transport, destination, key, payload, headers
          FROM outbox
          WHERE published_at IS NULL
            AND (${transport ?? null}::text IS NULL OR transport = ${transport ?? null})
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`),
      );

      const published: string[] = [];
      let error: unknown;
      for (const row of rows) {
        try {
          await publish({ ...row, id: BigInt(row.id) });
        } catch (e) {
          error = e;
          break;
        }
        published.push(row.id.toString());
      }

      // Mark what did go out even when a later record failed: rolling back would make the next
      // batch publish those again.
      if (published.length) {
        await tx.execute(sql`
          UPDATE outbox SET published_at = now()
          WHERE id = ANY(${sql.param(published)}::bigint[])`);
      }
      return { published: published.length, error };
    });
  }
}

/** node-postgres returns `{ rows }`; postgres.js returns the rows array itself. */
function rowsOf<T>(result: unknown): T[] {
  return (
    Array.isArray(result) ? result : (result as { rows: T[] }).rows
  ) as T[];
}

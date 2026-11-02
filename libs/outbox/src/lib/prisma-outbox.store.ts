import { context, propagation } from '@opentelemetry/api';

import {
  BatchResult,
  NewOutboxRecord,
  OutboxRecord,
  OutboxStore,
} from './outbox.types';

/**
 * The parts of a Prisma client (or interactive-transaction client) the store needs. Typed
 * structurally so the lib works with every app's generated client.
 */
export interface PrismaRawClient {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<T>;
  $executeRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): PromiseLike<number>;
}

export interface PrismaTransactionalClient extends PrismaRawClient {
  $transaction<R>(
    fn: (tx: PrismaRawClient) => Promise<R>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<R>;
}

interface OutboxRow {
  id: bigint;
  transport: OutboxRecord['transport'];
  destination: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

const INSERT_CHUNK = 1000;

export class PrismaOutboxStore implements OutboxStore {
  constructor(
    private readonly prisma: PrismaTransactionalClient,
    // Long enough to publish a whole batch even when the broker is slow to confirm.
    private readonly transactionTimeoutMs = 60_000,
  ) {}

  /**
   * Writes `records` inside the caller's transaction `tx`. The active trace context is saved in
   * each record's headers, so publishing later (outside the request) stays in the same trace.
   */
  async enqueue(
    tx: PrismaRawClient,
    records: NewOutboxRecord[],
  ): Promise<void> {
    const trace: Record<string, string> = {};
    propagation.inject(context.active(), trace);
    records = records.map((r) => ({
      ...r,
      headers: { ...trace, ...r.headers },
    }));
    for (let i = 0; i < records.length; i += INSERT_CHUNK) {
      const chunk = records.slice(i, i + INSERT_CHUNK);
      await tx.$executeRaw`
        INSERT INTO outbox (transport, destination, key, payload, headers)
        SELECT * FROM unnest(
          ${chunk.map((r) => r.transport)}::text[],
          ${chunk.map((r) => r.destination)}::text[],
          ${chunk.map((r) => r.key ?? null)}::text[],
          ${chunk.map((r) => JSON.stringify(r.payload))}::jsonb[],
          ${chunk.map((r) => JSON.stringify(r.headers ?? {}))}::jsonb[]
        )`;
    }
  }

  processBatch(
    limit: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<BatchResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<OutboxRow[]>`
          SELECT id, transport, destination, key, payload, headers
          FROM outbox
          WHERE published_at IS NULL
          ORDER BY id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`;

        const published: string[] = [];
        let error: unknown;
        for (const row of rows) {
          try {
            await publish(row);
          } catch (e) {
            error = e;
            break;
          }
          published.push(row.id.toString());
        }

        // Mark what did go out even when a later record failed: rolling back would make the
        // next batch publish those again.
        if (published.length) {
          await tx.$executeRaw`
            UPDATE outbox SET published_at = now()
            WHERE id = ANY(${published}::bigint[])`;
        }
        return { published: published.length, error };
      },
      { timeout: this.transactionTimeoutMs },
    );
  }
}

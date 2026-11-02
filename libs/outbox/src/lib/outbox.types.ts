/**
 * Every app that uses the outbox creates this table in its own database, in its own migration:
 *
 * ```sql
 * CREATE TABLE outbox (
 *   id           BIGSERIAL PRIMARY KEY,
 *   transport    TEXT        NOT NULL,             -- 'pulsar' (later also 'rabbitmq')
 *   destination  TEXT        NOT NULL,             -- topic or exchange
 *   key          TEXT,                             -- partition or routing key
 *   payload      JSONB       NOT NULL,
 *   headers      JSONB       NOT NULL DEFAULT '{}',
 *   created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
 *   published_at TIMESTAMPTZ
 * );
 * CREATE INDEX ON outbox (published_at, id);
 * ```
 */
export const OUTBOX_TABLE = 'outbox';

export type OutboxTransport = 'pulsar' | 'rabbitmq';

/** A message to write in the same transaction as the state change it announces. */
export interface NewOutboxRecord {
  transport: OutboxTransport;
  destination: string;
  key?: string;
  payload: unknown;
  headers?: Record<string, string>;
}

export interface OutboxRecord {
  id: bigint;
  transport: OutboxTransport;
  destination: string;
  key: string | null;
  payload: unknown;
  headers: Record<string, string>;
}

export interface BatchResult {
  published: number;
  /** Set when a publish failed; the batch stopped there so later records keep their order. */
  error?: unknown;
}

export interface OutboxStore {
  /**
   * In one transaction: claims up to `limit` unpublished records in id order (skipping rows
   * another relay holds), publishes them one by one, and marks the published ones. Stops at the
   * first failed publish; the rest stay unpublished for the next batch.
   */
  processBatch(
    limit: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<BatchResult>;
}

export interface OutboxPublisher {
  readonly transport: OutboxTransport;
  /** Resolves only once the broker has accepted the message. */
  publish(record: OutboxRecord): Promise<void>;
}

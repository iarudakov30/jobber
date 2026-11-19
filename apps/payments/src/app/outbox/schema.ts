import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * The transactional outbox table, exactly as `libs/outbox` expects it (see `outbox.types.ts`).
 * Only `DrizzleOutboxStore` reads and writes it, with raw SQL; it's declared here so
 * drizzle-kit creates it.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transport: text('transport').notNull(),
    destination: text('destination').notNull(),
    key: text('key'),
    payload: jsonb('payload').notNull(),
    headers: jsonb('headers')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => [index('outbox_published_at_id_idx').on(t.publishedAt, t.id)],
);

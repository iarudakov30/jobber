import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

// Kept free of NestJS imports and decorators: drizzle-kit loads it (through
// `@jobber/idempotency/table`) with esbuild, which can't compile parameter decorators.

/**
 * The table that holds idempotency keys. Export its result from an app's Drizzle schema so
 * drizzle-kit creates it:
 *
 * ```ts
 * import { idempotencyKeysTable } from '@jobber/idempotency/table';
 * export const idempotencyKeys = idempotencyKeysTable();
 * ```
 */
export function idempotencyKeysTable(name = 'idempotency_keys') {
  return pgTable(
    name,
    {
      /** `<userId>:<operation>:<key>` */
      scope: text('scope').primaryKey(),
      /** SHA-256 of the request's canonical arguments. */
      requestHash: text('request_hash').notNull(),
      /** 'in_progress' | 'completed' */
      status: text('status').notNull(),
      /** The handler's response (encodeResponse), once completed. */
      response: jsonb('response'),
      /** While in progress: until when the claim is exclusive. */
      lockedUntil: timestamp('locked_until', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true })
        .notNull()
        .defaultNow(),
      /** Once completed: when the key may be forgotten. */
      expiresAt: timestamp('expires_at', { withTimezone: true }),
    },
    (t) => [index(`${name}_expires_at_idx`).on(t.expiresAt)],
  );
}

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as ordersSchema from '../orders/schema';
import * as pricesSchema from '../prices/schema';

export const DATABASE_POOL = 'DATABASE_POOL';
export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

/**
 * The tables the app queries through Drizzle. `outbox` and `idempotency_keys` (their own
 * `schema.ts` files) are only for drizzle-kit: their stores use raw SQL, and the idempotency
 * table's entry point (`@jobber/idempotency/table`) isn't in the built app.
 */
export const schema = { ...pricesSchema, ...ordersSchema };

export type MarketDatabase = NodePgDatabase<typeof schema>;
/** The database or a transaction on it. */
export type MarketTx = Parameters<
  Parameters<MarketDatabase['transaction']>[0]
>[0];

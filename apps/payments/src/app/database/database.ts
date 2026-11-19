import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as paymentsSchema from '../payments/schema';

export const DATABASE_POOL = 'DATABASE_POOL';
export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

export const schema = paymentsSchema;

export type PaymentsDatabase = NodePgDatabase<typeof schema>;
/** The database or a transaction on it. */
export type PaymentsTx = Parameters<
  Parameters<PaymentsDatabase['transaction']>[0]
>[0];

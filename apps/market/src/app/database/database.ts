import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pricesSchema from '../prices/schema';

export const DATABASE_POOL = 'DATABASE_POOL';
export const DATABASE_CONNECTION = 'DATABASE_CONNECTION';

export const schema = { ...pricesSchema };

export type MarketDatabase = NodePgDatabase<typeof schema>;

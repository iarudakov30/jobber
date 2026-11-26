import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/** The only interval stored; longer ones can be aggregated from it when a chart needs them. */
export const ONE_MINUTE = '1m';

/**
 * Price history: one row per coin per minute, prices in USD cents per whole coin. The
 * simulator leader upserts each finished minute; the backfill job (step 6) writes past days.
 * The key makes either one safe to repeat.
 */
export const candles = pgTable(
  'candles',
  {
    coin: text('coin').notNull(),
    interval: text('interval').notNull(),
    start: timestamp('start', { withTimezone: true }).notNull(),
    open: bigint('open', { mode: 'bigint' }).notNull(),
    high: bigint('high', { mode: 'bigint' }).notNull(),
    low: bigint('low', { mode: 'bigint' }).notNull(),
    close: bigint('close', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.coin, t.interval, t.start] }),
    check('candles_interval_valid', sql`${t.interval} IN ('1m')`),
    check(
      'candles_prices_valid',
      sql`${t.low} > 0 AND ${t.low} <= LEAST(${t.open}, ${t.close}) AND ${t.high} >= GREATEST(${t.open}, ${t.close})`,
    ),
  ],
);

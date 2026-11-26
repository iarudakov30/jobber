import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/**
 * - `PLACING`: a limit order whose hold the wallet hasn't confirmed yet. Nothing matches,
 *   cancels or expires it until it is `OPEN` (or `REJECTED`), so nobody releases or captures a
 *   hold that may not exist.
 * - `OPEN`: a limit order with its funds held, waiting for its price.
 * - `SETTLING`: claimed for a trade; `SettleTrade` is in flight or will be retried.
 * - `FILLED`, `CANCELLED`, `EXPIRED`, `REJECTED`: final.
 *
 * Every change is a conditional `UPDATE … WHERE status = <expected>`, so of two racing changes
 * (a cancel and a fill, two leaders matching) exactly one happens.
 */
export const ORDER_STATUSES = [
  'PLACING',
  'OPEN',
  'SETTLING',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

const list = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(', '));

/**
 * One order. `id` is also the wallet's `tradeId` and, for a limit order, its `holdId`. The
 * trade's terms (`usdAmount`, `fee`) are fixed when the order is created, from the quote or the
 * limit price, so every retry of `SettleTrade` sends exactly the same ones.
 */
export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id').notNull(),
    /** The `Idempotency-Key` of the `placeOrder` request that created it. */
    requestKey: text('request_key'),
    coin: text('coin').notNull(),
    side: text('side').$type<'BUY' | 'SELL'>().notNull(),
    type: text('type').$type<OrderType>().notNull(),
    /** Coin minor units (8 decimals). */
    qty: bigint('qty', { mode: 'bigint' }).notNull(),
    /** USD cents per whole coin; limit orders only. */
    limitPrice: bigint('limit_price', { mode: 'bigint' }),
    /** USD cents per whole coin: the quote's price, or the limit price once matched. */
    fillPrice: bigint('fill_price', { mode: 'bigint' }),
    /** USD cents for `qty`, before the fee, rounded in the house's favour. */
    usdAmount: bigint('usd_amount', { mode: 'bigint' }).notNull(),
    /** USD cents, on top of a buy, out of a sell's proceeds. */
    fee: bigint('fee', { mode: 'bigint' }).notNull(),
    status: text('status').$type<OrderStatus>().notNull(),
    /** Why the order was rejected. */
    reason: text('reason'),
    /** The wallet's ledger transaction, once filled. */
    transactionId: text('transaction_id'),
    /** When an open limit order expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** When the hold of a cancelled or expired limit order was released in the wallet. */
    releasedAt: timestamp('released_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Matching: the open limit orders of a coin. Recovery: orders stuck in one status.
    index('orders_status_coin_idx').on(t.status, t.coin),
    index('orders_user_created_idx').on(t.userId, t.createdAt),
    uniqueIndex('orders_user_request_key_idx').on(t.userId, t.requestKey),
    check('orders_side_valid', sql`${t.side} IN ('BUY', 'SELL')`),
    check('orders_type_valid', sql`${t.type} IN (${list(ORDER_TYPES)})`),
    check('orders_status_valid', sql`${t.status} IN (${list(ORDER_STATUSES)})`),
    check('orders_qty_positive', sql`${t.qty} > 0`),
    check(
      'orders_amounts_valid',
      sql`${t.usdAmount} > 0 AND ${t.fee} >= 0 AND ${t.fee} <= ${t.usdAmount}`,
    ),
    check(
      'orders_limit_price_valid',
      sql`(${t.type} = 'LIMIT') = (${t.limitPrice} IS NOT NULL) AND (${t.limitPrice} IS NULL OR ${t.limitPrice} > 0)`,
    ),
  ],
);

export type OrderRow = typeof orders.$inferSelect;

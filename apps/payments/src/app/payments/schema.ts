import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

export const PAYMENT_STATUSES = [
  'PENDING',
  'SUCCEEDED',
  'EXPIRED',
  'FAILED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/** USD 1.00 to 1,000.00 per top-up, in minor units. */
export const MIN_TOP_UP = 100n;
export const MAX_TOP_UP = 100_000n;

/**
 * One top-up through Stripe Checkout. It starts `PENDING` and moves once, to `SUCCEEDED`,
 * `EXPIRED` or `FAILED`: every change is a conditional `UPDATE … WHERE status = 'PENDING'`, so
 * a late or repeated event can't move a finished payment.
 */
export const payments = pgTable(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: integer('user_id').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(),
    currency: text('currency').notNull(),
    status: text('status').$type<PaymentStatus>().notNull().default('PENDING'),
    /** Set once Stripe has created the Checkout session; null if that never happened. */
    stripeSessionId: text('stripe_session_id').unique(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // The user's list and the rolling 24-hour limit both read by user, newest first.
    index('payments_user_id_created_at_idx').on(t.userId, t.createdAt.desc()),
    check(
      'payments_amount_range',
      sql`${t.amount} BETWEEN ${sql.raw(String(MIN_TOP_UP))} AND ${sql.raw(String(MAX_TOP_UP))}`,
    ),
    check('payments_currency', sql`${t.currency} = 'USD'`),
    check(
      'payments_status',
      sql`${t.status} IN ('PENDING', 'SUCCEEDED', 'EXPIRED', 'FAILED')`,
    ),
  ],
);

/**
 * Every Stripe webhook event, by id, inserted in the transaction that applies it. A redelivered
 * or resent event hits the primary key and is skipped, so it is applied at most once.
 */
export const stripeEvents = pgTable('stripe_events', {
  eventId: text('event_id').primaryKey(),
  type: text('type').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/**
 * Money and records that disagree and need a person: a payment that Stripe took after it had
 * expired here, an amount that doesn't match. Written instead of moving money; phase 5 reports
 * them.
 */
export const reconIssues = pgTable('recon_issues', {
  id: bigserial('id', { mode: 'bigint' }).primaryKey(),
  kind: text('kind').notNull(),
  paymentId: uuid('payment_id'),
  stripeEventId: text('stripe_event_id'),
  stripeSessionId: text('stripe_session_id'),
  details: jsonb('details')
    .notNull()
    .default(sql`'{}'::jsonb`),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

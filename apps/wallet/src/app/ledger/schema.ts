import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

// Amounts are BIGINT minor units of their asset (cents for USD), read and written as JS bigint.
// Never floats, never JS numbers.

export const assets = pgTable('assets', {
  code: text('code').primaryKey(), // 'USD'
  scale: smallint('scale').notNull(), // 2 = two decimal places
});

export const accounts = pgTable(
  'accounts',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    ownerType: text('owner_type').notNull(), // 'user' | 'system'
    ownerId: text('owner_id').notNull(), // user id, or 'seed', 'stripe_clearing', ...
    asset: text('asset')
      .notNull()
      .references(() => assets.code),
    kind: text('kind').notNull(), // 'available' | 'held' | 'system'
    // Cached sum of this account's entries, kept in the same transaction as the entries.
    // `sql` default: drizzle-kit 0.31 can't serialize a bigint literal like `0n`.
    balance: bigint('balance', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (t) => [
    unique('accounts_owner_asset_kind_unique').on(
      t.ownerType,
      t.ownerId,
      t.asset,
      t.kind,
    ),
    // Target of the entries (account_id, asset) foreign key below.
    unique('accounts_id_asset_unique').on(t.id, t.asset),
    // System accounts (seed, clearing, fees) may go negative; users may not.
    check(
      'user_balance_non_negative',
      sql`${t.ownerType} <> 'user' OR ${t.balance} >= 0`,
    ),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    type: text('type').notNull(), // 'seed', 'transfer', 'topup', ...
    // The caller's business id (e.g. 'transfer:<uuid>'): posting the same one twice is a no-op.
    externalRef: text('external_ref').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('transactions_type_external_ref_unique').on(t.type, t.externalRef),
  ],
);

// Append-only (trigger in the 0001 migration); every transaction's entries sum to zero per
// asset (deferred trigger, checked at commit).
export const entries = pgTable(
  'entries',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    accountId: bigint('account_id', { mode: 'bigint' }).notNull(),
    asset: text('asset').notNull(),
    amount: bigint('amount', { mode: 'bigint' }).notNull(), // signed, never 0
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // An entry's asset must be its account's asset, so the per-asset sum can be trusted.
    foreignKey({
      name: 'entries_account_asset_fk',
      columns: [t.accountId, t.asset],
      foreignColumns: [accounts.id, accounts.asset],
    }),
    index('entries_account_id_id_idx').on(t.accountId, t.id),
    index('entries_transaction_id_idx').on(t.transactionId),
    check('amount_non_zero', sql`${t.amount} <> 0`),
  ],
);

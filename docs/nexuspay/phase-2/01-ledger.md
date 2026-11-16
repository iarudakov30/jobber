# Step 1 — Ledger core

- **Where:** committed directly to `main`.

## Why

Every money flow in NexusPay (top-ups, transfers, trades, refunds) ends as a ledger posting. If
the ledger can lose a cent, double-post a payment or overdraw a wallet under load, nothing built
on it can be trusted. So the ledger comes first, with its guarantees in PostgreSQL itself rather
than in application code that a later caller could bypass.

## What changed

| Area                    | Change                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/wallet`           | New NestJS app on port 3004 (`init()` prefix `wallet`), Drizzle + `pg`, own `package.json`, Jest tests                                 |
| `wallet` database       | Tables `assets`, `accounts`, `transactions`, `entries`; migrations `0000_ledger` (generated) and `0001_ledger_triggers` (hand-written) |
| `LedgerService`         | `post()`, `ensureAccounts()`, `ensureSystemAccount()`; errors `InvalidPostingError`, `InsufficientFundsError`                          |
| `scripts/create-db.mjs` | Creates the database in a project's `DATABASE_URL`; `wallet:migrate-drizzle` runs it first                                             |
| Workspace               | `wallet` in `npm start`, `npm run build`, `npm stop` (port 3004) and `docker/init-db.sql`                                              |

GraphQL, gRPC, the outbox and `libs/money` are later steps; the app currently serves only
Swagger.

## How it works

Four rules, each enforced by the database:

| Rule                                          | Enforced by                                                       |
| --------------------------------------------- | ----------------------------------------------------------------- |
| A transaction's entries sum to zero per asset | Deferred constraint trigger `entries_balanced`, checked at COMMIT |
| Entries are never changed or removed          | Triggers on UPDATE, DELETE and TRUNCATE that raise                |
| A user's balance never goes below zero        | `CHECK (owner_type <> 'user' OR balance >= 0)` on `accounts`      |
| An entry's asset is its account's asset       | Foreign key `(account_id, asset)` → `accounts (id, asset)`        |

The last row isn't in the spec. Without it, an entry in USD could land on a coin account, and the
per-asset sum check would still pass.

`post({ type, externalRef, legs })` in one READ COMMITTED transaction:

1. Check in code: at least two legs, no zero amounts, legs sum to zero per asset.
2. `INSERT INTO transactions … ON CONFLICT (type, external_ref) DO NOTHING RETURNING id`. No row
   back means the posting already exists: return its id with `duplicate: true` and write nothing.
   A concurrent post of the same ref waits on the unique index until the first one commits.
3. `SELECT … FROM accounts WHERE id IN (…) ORDER BY id FOR UPDATE` locks every touched account in
   one statement, in ascending id order, so two postings can't deadlock. Unknown accounts and
   asset mismatches become `InvalidPostingError`.
4. One `UPDATE accounts SET balance = balance + delta` per account (legs on the same account are
   netted). A `user_balance_non_negative` violation becomes `InsufficientFundsError`.
5. Insert the entries and commit; the trigger re-checks the sums.

Any error rolls everything back, including the `transactions` row, so a refused posting can be
retried later with the same `externalRef`.

Accounts are created lazily: `ensureAccounts(userId, asset)` inserts the user's `available` and
`held` accounts with `ON CONFLICT DO NOTHING`, then reads their ids. System accounts (`seed`,
later `stripe_clearing`, `fees`) may go negative by design.

## How it was verified

- `npx nx test wallet`: 18 tests against PostgreSQL 18 in Testcontainers. After every test, a
  check asserts that each asset's balances sum to zero and every cached balance equals the sum of
  its entries.
  - Spec acceptance test 1: an unbalanced transaction (written with raw SQL, past the service)
    fails at commit; UPDATE, DELETE and TRUNCATE on entries fail; a repeated `externalRef` returns
    `duplicate: true` with no new entries.
  - Malformed postings (unbalanced legs, one leg, zero amount, unknown account, wrong asset) are
    refused and write nothing.
  - **No overdraft:** 200 parallel $1.00 transfers from a $100.00 balance → exactly 100 succeed,
    the other 100 fail with `InsufficientFundsError`, and the balance ends at 0. This is the
    in-process version of spec test 2; the k6 run over GraphQL comes with the API.
  - **No deadlocks:** 100 parallel transfers each way between two users all succeed.
  - **Exactly once:** the same `externalRef` posted 20 times at once → one transaction.
  - `ensureAccounts` called 10 times at once → one pair of accounts.
- `wallet:migrate-drizzle` against the compose PostgreSQL created the `wallet` database, applied
  both migrations, seeded USD and installed the three triggers. The built app booted on port 3004.
- `npx nx run-many -t lint test build` passes for all projects.

## Lessons

- **drizzle-kit 0.31 can't generate a migration for `bigint(...).default(0n)`:** it crashes with
  "Do not know how to serialize a BigInt". Use ``.default(sql`0`)``.
- **Nx reported `generate-drizzle` as successful while drizzle-kit had crashed.** Check that a new
  `.sql` file appeared, not the exit status.
- **Drizzle wraps database errors** in `DrizzleQueryError`; the `pg` error (with `code` and
  `constraint`) is its `cause`. `isConstraintViolation()` walks the `cause` chain.
- **The app tsconfig copied from `products` included spec files**, because products has no tests.
  The build then type-checked Jest globals and failed with 58 errors. `tsconfig.app.json`
  excludes `*.spec.ts`, as in `jobs`.
- `Error.cause` needs the ES2022 type library, so the wallet's tsconfigs add `"lib": ["es2022"]`
  (the compile target stays ES2021, like the other apps).

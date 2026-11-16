# Step 3 — Wallet API

- **Where:** committed directly to `main`.

## Why

After steps 1 and 2, the ledger worked but nothing could reach it. This step opens it up:

- people use GraphQL (from the React app in step 6)
- other services use gRPC (`Credit` for top-ups in phase 3, `RunAudit` for the nightly audit in
  step 5)
- the outside world hears about transfers through the outbox and Pulsar

It also adds a way to put money into dev accounts, since Stripe only arrives in phase 3.

## What changed

| Area                        | Change                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GraphQL (`/wallet` on 3004) | `MinorUnits` scalar; queries `balances` and `entries(asset, after, first)`; mutation `transfer(input: { toEmail, asset, amount })`; all behind `GqlAuthGuard` |
| `apps/wallet/schema.gql`    | The printed schema, written on startup (`autoSchemaFile`, sorted) and committed for step 6's codegen                                                          |
| gRPC `WalletService` (5003) | `Credit`, `GetBalances`, `RunAudit`                                                                                                                           |
| `WalletService`             | Balances (accounts created on first read), cursor-paged entries, transfer by email, credit from a system account                                              |
| `LedgerService.audit()`     | Recomputes balances from entries; reports `balance_drift` and `transaction_unbalanced`                                                                        |
| Outbox                      | `DrizzleOutboxStore` + `OutboxRelay` + `PulsarOutboxPublisher` (producer `outbox-wallet-<topic>`); each transfer publishes `transfer-completed`               |
| `wallet:seed`               | `scripts/wallet-seed.mjs`: creates `alice@` and `bob@example.com` if missing (password `Test@1234`) and credits $100 each through `Credit`                    |
| Config                      | `apps/wallet/.env`: `WALLET_GRPC_SERVICE_URL` (5003), `AUTH_GRPC_SERVICE_URL`, `PULSAR_SERVICE_URL`; `npm stop` covers 5003                                   |
| Tests                       | `src/testing/test-database.ts` (shared Testcontainers setup and books-balance check); `wallet.api.spec.ts` (20 tests over HTTP); 2 audit tests                |

`RunAudit` was planned for step 5, but the generated `WalletServiceController` interface needs all
three methods, so the audit query came now. Step 5 is left with the nightly `LedgerAudit` job that
calls it.

## How it works

### GraphQL

```graphql
query {
  balances {
    asset
    available
    held
  } # [{ "USD", "8750", "0" }]
  entries(first: 20) {
    items {
      type
      amount
      createdAt
    }
    nextCursor
  }
}

mutation {
  transfer(input: { toEmail: "bob@example.com", asset: "USD", amount: "1250" }) {
    transactionId
    amount
    asset
  }
}
```

- **`MinorUnits`** is a decimal string of minor units in and out (`"1250"` = $12.50). The scalar
  refuses JSON numbers, decimals (`"12.50"`) and non-canonical strings before any resolver runs.
- **`balances`** returns one row per asset in `libs/money`'s `ASSETS`. On a user's first read it
  creates their accounts (`ensureAccounts`), so a new user sees `"0"` instead of nothing.
- **`entries`** is newest first. The cursor is the last entry's id (`WHERE id < after ORDER BY id
DESC LIMIT first + 1`, served by the `(account_id, id)` index). `first` is 1 to 100.
- **`transfer`** follows these steps:
  1. Asks `auth` for the recipient (`FindUserByEmail`).
  2. Refuses an unknown email, a transfer to yourself, or more than the available balance.
  3. Posts `available A −X / available B +X` with `externalRef = transfer:<uuid>` and the
     `transfer-completed` event in the same transaction.
  4. Wakes the relay (`poke()`).

  Every call is a new transfer. Deduplicating retries is step 4 (`@Idempotent()`).

Errors are worded like class-validator's, field name first, so the React forms can put them on
that field:

| Problem                                                             | GraphQL error                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| No session cookie, or an invalid one                                | `FORBIDDEN` (from `GqlAuthGuard`, as in jobs)                                                                                   |
| `amount` `"0"` or negative; `toEmail` not an email; unknown `asset` | `BAD_REQUEST` from `ValidationPipe`, with `originalError.message: ["amount must be positive"]`                                  |
| Unknown email / yourself / overdraft                                | `BAD_USER_INPUT`: `toEmail does not belong to any user` / `toEmail is your own email` / `amount exceeds your available balance` |
| `amount` not a minor-units string                                   | GraphQL validation error naming `MinorUnits`                                                                                    |
| Bad cursor or `first`                                               | `BAD_USER_INPUT`                                                                                                                |

The spec groups the shape errors (non-positive amount) under `BAD_USER_INPUT`. Here they go
through `ValidationPipe` like `auth`'s inputs, so they come out as `BAD_REQUEST` with the
class-validator message. The React error helper already handles both.

### gRPC `WalletService`

| RPC           | Does                                                                                                             | Errors                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `Credit`      | System account → user's `available`, idempotent by `(type, externalRef)`; returns `{ transactionId, duplicate }` | `INVALID_ARGUMENT` for a bad user id, asset or amount, a missing ref, or a system account outside the allowed list |
| `GetBalances` | Same as the `balances` query, amounts as wire strings                                                            |                                                                                                                    |
| `RunAudit`    | `LedgerService.audit()`                                                                                          |                                                                                                                    |

`Credit` may only draw from `seed` and `stripe_clearing`. `seed`, the dev faucet, is refused when
`NODE_ENV=production`.

### Audit

`audit()` runs two queries in one `REPEATABLE READ, READ ONLY` transaction. Because they share a
snapshot, a posting that commits while the audit runs can't look like drift.

- **`balance_drift`:** an account whose cached `balance` differs from the sum of its entries, for
  example `account 113 (user 19 USD available): balance 501, entries sum to 500`.
- **`transaction_unbalanced`:** a transaction whose entries don't sum to zero in some asset. The
  `entries_balanced` trigger should make this impossible; the audit checks anyway.

Negative system accounts (`seed`) are normal and aren't reported.

### Outbox

The wallet registers the same relay as `jobs`, with `DrizzleOutboxStore` instead of the Prisma
store. A transfer's `transfer-completed` record is written in the posting's transaction:

```json
{ "transactionId": "5f49…", "fromUserId": 19, "toUserId": 20, "asset": "USD", "amount": "1250" }
```

Its key is the transaction id. Nothing consumes it yet.

## How it was verified

- **`npx nx test wallet`:** 43 tests against PostgreSQL 18 in Testcontainers. After every test, a
  check confirms the books still balance.
  - `wallet.api.spec.ts` (20 tests) starts Apollo, `GqlAuthGuard`, `ValidationPipe`,
    `cookie-parser`, the real resolver and controller, and calls them over HTTP with
    `Authentication` cookies. Only `auth` (gRPC) and Pulsar are faked.
    - **Auth:** a request without a session, or with a forged one, gets `FORBIDDEN`.
    - **Balances:** a new user sees `"0"`.
    - **Transfers:** a transfer moves money, wakes the relay, and writes exactly the expected
      `transfer-completed` row. The three `BAD_USER_INPUT` cases, the validation errors and the
      bad `MinorUnits` inputs all leave balances unchanged.
    - **History:** paging returns the newest entries first, and each user sees only their own
      side.
    - **Schema:** the printed schema equals the committed `schema.gql`.
    - **gRPC:** `Credit` is idempotent, five bad requests get `INVALID_ARGUMENT`, and `RunAudit`
      reports nothing on sound books.
  - **Audit (spec acceptance test 7):** sound books report nothing. After `UPDATE accounts SET
balance = balance + 1` on one account, the audit reports exactly one `balance_drift`, naming
    that account.
- **With real services**, using the built `auth` and `wallet` plus PostgreSQL and Pulsar from
  compose:
  - **Seeding:** `npx nx run wallet:seed` created alice and bob and credited $100 each. A second
    run printed "already seeded, unchanged".
  - **Login:** logged in as alice through `auth`'s GraphQL; with that cookie,
    `http://localhost:3004/wallet` returned `balances` `"10000"`.
  - **Transfers:** a `"1250"` transfer to bob succeeded. A `"999999"` one got `BAD_USER_INPUT`
    "amount exceeds your available balance". Bob saw `"11250"` with entries `transfer 1250` and
    `seed 10000`; alice saw `"8750"`. Without a cookie: `FORBIDDEN`.
  - **Outbox:** the `outbox` row was written with the payload above. With Pulsar running, the
    relay marked it published, and `pulsar-admin topics stats transfer-completed` showed
    `msgInCounter: 1` from producer `outbox-wallet-transfer-completed`.
- `npx nx run-many -t lint test build`: all 15 projects green. `dist/apps/wallet/main.js` was
  rebuilt.

## Lessons

- **The generated schema has to be in `.prettierignore`.** The pre-commit hook formats every
  staged file, and Prettier reflows the descriptions in `schema.gql`. The committed file would
  then never match what the app prints, and the schema test would fail.
- **`src/testing/` must be excluded from `tsconfig.app.json`**, like `*.spec.ts`. Otherwise
  webpack type-checks the Jest helpers and the build fails on `expect`.
- **Running Jest directly** (`npx jest -c apps/wallet/jest.config.cts`) fails with "Must use
  import to load ES Module" on `@nestjs/common`. Nx adds `--experimental-vm-modules`
  (`targetDefaults.test` in `nx.json`), so use `npx nx test wallet`.
- **`OutboxRelay` holds its batch transaction open while a publish waits for the broker.** With
  Pulsar down, a claimed record stays locked until the Pulsar client gives up or the broker comes
  up; other relays skip it (`SKIP LOCKED`). `published_at` is `now()`, the batch's start time,
  which can be earlier than the actual publish.

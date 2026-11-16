# Step 2 — Contracts and libraries

- **Where:** committed directly to `main`.

## Why

Step 3 puts the ledger behind GraphQL and gRPC. Before that, three things need to exist, each
used by more than one project:

- **`libs/money`.** One place that turns what a person types ("12.34") into minor units, and minor
  units into display text and wire strings. Both the wallet and the React app need it, and
  getting it wrong loses cents.
- **The gRPC contracts.** `wallet.proto` (what other services can ask the wallet) and
  `FindUserByEmail` in `auth.proto` (a transfer names the recipient by email; only `auth` knows
  emails).
- **An outbox on Drizzle.** The wallet announces each posting (`transfer-completed` and later
  events) through the same transactional outbox as `jobs`, but `jobs` uses Prisma and the
  wallet uses Drizzle.

## What changed

| Area                         | Change                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/money` (new)           | `ASSETS`, `parseAmount`, `formatAmount`, `toDecimal`, `toWire`, `fromWire`, `MoneyFormatError`; 64 tests                                                                                                 |
| `libs/grpc`                  | `wallet.proto` (`Credit`, `GetBalances`, `RunAudit`); `FindUserByEmail` in `auth.proto`; `--ts_proto_opt=forceLong=string`; `Packages.WALLET`; `GRPC_LOADER_OPTIONS` (`{ longs: String }`); `GrpcStatus` |
| Every gRPC client and server | `loader: GRPC_LOADER_OPTIONS` (auth, jobs, products servers; the jobs and executor clients)                                                                                                              |
| `auth`                       | `FindUserByEmail` handler: returns `{ id, email }`, or gRPC `NOT_FOUND`                                                                                                                                  |
| `libs/outbox`                | `DrizzleOutboxStore` (`enqueue(tx, records)`, `processBatch`); trace headers shared with `PrismaOutboxStore` through `withTraceHeaders()`                                                                |
| `apps/wallet`                | Migration `0002_outbox` (the `outbox` table); `LedgerService.post({ ..., outbox })` writes events in the posting's transaction                                                                           |
| Workspace                    | `@jobber/money` in `tsconfig.base.json` and `_moduleAliases`; Testcontainers tests (wallet, outbox) get a 30 s timeout                                                                                   |

The wallet's GraphQL and gRPC servers, and the relay that publishes its outbox, are step 3.

## How it works

### Money

Amounts are `bigint` minor units in code and decimal strings of minor units on the wire. Nothing
goes through a JS `number`, so nothing rounds.

- `parseAmount("12.34", "USD")` → `1234n`. It refuses what it would have to round (`"1.234"`),
  plus thousands separators, exponents, `"12."`, `".5"`, and anything outside `bigint` (int64)
  range.
- `formatAmount(123456n, "USD")` → `"$1,234.56"`. It passes `Intl.NumberFormat` a decimal
  **string**, which it formats exactly. A `Number` would lose digits above 2^53 (about
  $90 trillion in cents).
- `fromWire` accepts only the canonical form `toWire` writes (`"0"`, `"1250"`, `"-5"`, but not
  `"01"`, `"-0"` or `"+5"`), so each amount has exactly one wire spelling.

The lib has no framework imports, so `nexus` can use it in step 6.

### gRPC and int64

`int64` fields (`amount`, `available`, `held`) must not become JS numbers. Two settings keep them
strings end to end:

- `forceLong=string` makes ts-proto type them as `string`.
- `loader: { longs: String }` makes proto-loader decode them as decimal strings. Without it they
  arrive as `Long` objects that don't match the generated types.

The second is set through `GRPC_LOADER_OPTIONS` on every client and server. The older protos have
no `int64`, so their generated types didn't change.

### `FindUserByEmail`

`auth` looks the email up exactly as typed (trimmed), the same way login does. It returns only
`id` and `email`, or `NOT_FOUND`. Like `Authenticate`, it's for services inside the cluster. The
wallet's GraphQL guard has already checked the caller's JWT before it asks.

### Outbox on Drizzle

`DrizzleOutboxStore` runs the same SQL as the Prisma store: `INSERT … SELECT FROM unnest(arrays)`
in chunks of 1,000, and `SELECT … FOR UPDATE SKIP LOCKED` to claim a batch. It takes any Drizzle
PostgreSQL database or transaction. `processBatch` converts ids to `bigint` (node-postgres returns
`int8` as a string).

`LedgerService.post()` takes `outbox` as a **function of the transaction id**. The spec had a
plain list, but an event like `transfer-completed` has to carry the transaction id, which doesn't
exist until `post()` inserts the transaction. The records are written after the entries, in the
same transaction, so the posting and its events always exist together:

| Case                                    | Outbox rows written              |
| --------------------------------------- | -------------------------------- |
| New posting                             | The function's records           |
| Duplicate `(type, externalRef)`         | None (the function isn't called) |
| Refused (insufficient funds, malformed) | None (rolled back)               |

## How it was verified

- `npx nx test money`: 64 tests. Parsing (each rejected form above, int64 bounds, values past
  `Number.MAX_SAFE_INTEGER`), formatting (`en-US`, `de-DE`, negatives, the largest int64), and the
  wire format round-trips for every asset (spec acceptance test 8).
- `npx nx test outbox`: 5 new tests against PostgreSQL 18 in Testcontainers:
  - 1,001 records in two chunks, with payloads and headers intact
  - a rolled-back transaction leaves no rows
  - batches are claimed in id order with `bigint` ids
  - a failed publish stops the batch but keeps earlier records marked
  - 5 relays at once never publish the same record twice
- `npx nx test wallet`: 21 tests, including 3 new ones. An event is written with its posting and
  carries its transaction id; a duplicate writes none; a refused posting writes none.
- `npx nx test auth`: `FindUserByEmail` returns `{ id, email }` for a match and `NOT_FOUND`
  otherwise.
- **Real gRPC:** I started the built `auth` and called `AuthService.FindUserByEmail` with
  `@grpc/grpc-js`. A seeded email returned `{"id":1,"email":"test@example.com"}`; an unknown one
  returned `NOT_FOUND: No user has that email`.
- `wallet:migrate-drizzle` applied `0002_outbox` to the dev database. The built wallet started
  with `@jobber/outbox` loaded.
- `npx nx run-many -t lint test build`: all 15 projects green. `dist/apps/wallet`,
  `dist/apps/auth`, `dist/libs/money` and the four protos in `dist/libs/grpc/proto` were written.

## Lessons

- **A JS array inside Drizzle's `sql` tag becomes a list** (`($1, $2, …)`), not a PostgreSQL
  array. To send one array parameter (for `unnest(…)::text[]` or `= ANY(…)`), wrap it in
  `sql.param(array)`.
- **Git Bash rewrites Docker's `-w /work`** to `C:/Program Files/Git/work`. Run the proto
  generation container from PowerShell, or set `MSYS_NO_PATHCONV=1`.
- **The 200-way concurrency tests passed alone but timed out** under Jest's 5 s default when
  every project's tests ran at once. The Testcontainers suites now allow 30 s per test. Only the
  time limit changed, not what the tests check.
- `products` and `wallet` call `ConfigModule.forRoot()` without `envFilePath`. Nx loads
  `apps/<app>/.env` for `nx serve`, but a bundle started by hand needs
  `node --env-file=apps/wallet/.env dist/apps/wallet/main.js`.

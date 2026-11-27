# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Start all services

```bash
npm start                          # serves auth, jobs, executor, products, wallet, payments, market, realtime, ui-admin and nexus concurrently
npm stop                           # and stops them
```

Needs the infrastructure first (`docker compose up -d`, below) and migrated databases (Database,
below). Once running:

| What                                               | URL                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| NexusPay (React)                                   | http://localhost:4300                                                              |
| ui-admin (Angular)                                 | http://localhost:4200                                                              |
| GraphiQL: auth / jobs / wallet / payments / market | http://localhost:3000/auth, :3001/jobs, :3004/wallet, :3005/payments, :3006/market |
| Realtime gateway stats                             | http://localhost:3007/realtime/stats                                               |
| RabbitMQ UI                                        | http://localhost:15672 (guest / guest)                                             |
| Mailpit                                            | http://localhost:8025                                                              |
| Jaeger                                             | http://localhost:16686                                                             |

Sign in as `alice@example.com` or `bob@example.com` (password `Test@1234`, created by
`npx nx run wallet:seed`).

### Individual app commands

```bash
npx nx serve <app>                 # serve with watch mode
npx nx build <app>                 # build
npx nx test <app>                  # run tests
npx nx lint <app>                  # lint
```

Apps: `auth`, `jobs`, `executor`, `products`, `wallet`, `payments`, `market`, `realtime`, `ui-admin`, `nexus` (plus `nexus-e2e`, Playwright)

### Run a single test file

```bash
npx nx test auth --testFile=apps/auth/src/app/auth/auth.service.spec.ts
npx nx test ui-admin --include=apps/ui-admin/src/app/auth/session.spec.ts   # ui-admin uses Vitest, not Jest
npx nx test nexus -- src/lib/session.spec.ts                    # nexus runs plain Vitest from apps/nexus
npx nx run nexus-e2e:e2e           # Playwright against running auth, wallet, market (+ Pulsar, RabbitMQ); starts the gateway and the nexus dev server
npx nx run nexus:codegen           # GraphQL types from apps/{auth,wallet,payments,market}/schema.gql; CI fails if stale
npx nx test wallet                 # real PostgreSQL via Testcontainers: Docker must be running
npx nx test outbox                 # likewise (DrizzleOutboxStore spec)
npx nx test payments               # Testcontainers PostgreSQL + RabbitMQ; Stripe faked, signatures real
npx nx test market                 # Testcontainers PostgreSQL, Redis, RabbitMQ; leader failover, orders against a fake wallet gRPC server (~1 min)
npx nx test realtime               # gateway replicas on Testcontainers RabbitMQ with real ws clients
npx nx run realtime:load-test prices-and-fills   # k6: 1,000 sockets for 5 min while trading (auth, wallet, market, realtime running)
npx nx test executor               # email worker: Testcontainers RabbitMQ, Redis, Mailpit
npx nx test rabbitmq               # Testcontainers RabbitMQ (retries, DLQ, delay buckets, reconnect)
npx nx run rabbitmq:replay --queue=<name>   # move <name>.dlq back to <name> (RABBITMQ_URL, default localhost)
```

Node 25+ has a built-in global `localStorage` that is `undefined` without `--localstorage-file` and
hides jsdom's, so both frontends start their Vitest workers with `--no-webstorage`
(`apps/nexus/vite.config.mts`; `apps/ui-admin/vitest-base.config.mts`, loaded through
`runnerConfig: true` in its `project.json`).

### Run all affected tasks (CI pattern)

```bash
npx nx affected -t lint test build
```

### Infrastructure

```bash
docker compose up -d               # start PostgreSQL, Pulsar, RabbitMQ, Redis, Mailpit and Jaeger
docker compose up -d pulsar jaeger # or just what you need
docker compose down
```

| Service  | Port(s)                | UI                     |
| -------- | ---------------------- | ---------------------- |
| Postgres | 5432                   |                        |
| Pulsar   | 6650                   |                        |
| RabbitMQ | 5672                   | http://localhost:15672 (guest / guest) |
| Redis    | 6379                   |                        |
| Mailpit  | 1025 (SMTP)            | http://localhost:8025  |
| Jaeger   | 4318 (OTLP/HTTP)       | http://localhost:16686 |

Pulsar runs with `brokerDeduplicationEnabled=true` (applied by `apply-config-from-env.py` in the
compose `command`): a resend with the same producer name and `sequenceId` is dropped. Changing the
compose config needs `docker compose up -d pulsar` to recreate the container.

### Docker (per app)

```bash
# auth
docker build -t auth -f apps/auth/Dockerfile .
docker run auth

# jobs
docker build -t jobs -f apps/jobs/Dockerfile .
docker run jobs

# executor
docker build -t executor -f apps/executor/Dockerfile .
docker run executor

# products
docker build -t products -f apps/products/Dockerfile .
docker run products
```

### Kubernetes (minikube)

Local cluster used for testing the `charts/jobber` Helm chart.

```bash
minikube start                     # start/resume the local cluster (uses the docker driver)
minikube stop                      # stop the cluster without deleting it
minikube status                    # check whether the cluster is up
minikube delete                    # tear down the cluster completely
minikube service -n jobber <svc>   # open/tunnel a service from the jobber namespace
```

`minikube start` reassigns the local API server port on each start (kubeconfig at `~/.kube/config`
is updated automatically) — if `kubectl` fails with `connection refused`, the cluster is most
likely stopped; run `minikube start` first.

```bash
kubectl config current-context     # should print "minikube"
kubectl get namespaces             # list namespaces
kubectl get pods -A                # list pods across all namespaces
kubectl get pods -n jobber         # list pods in the app's namespace (once installed)
kubectl get pods -n postgresql     # list pods in the postgresql subchart's namespace
kubectl get pods -n pulsar         # list pods in the pulsar subchart's namespace
kubectl get svc -n jobber          # list services in the app's namespace
kubectl exec --stdin --tty jobber-postgresql-0 -n postgresql -- sh   # shell into the postgres pod
```

```bash
eval $(minikube docker-env)        # point the local docker CLI at minikube's daemon, so
                                    # `docker build` output is usable by the cluster without a push
```

Images are tagged `:latest` and pulled with a static policy, so after rebuilding an image with
`docker build` (under `minikube docker-env`), Kubernetes won't notice the new image on its own —
`helm upgrade` reapplies manifests but does not restart pods when the tag is unchanged. Restart the
deployment manually to pick up the new image:

```bash
kubectl rollout restart deployment/<app> -n jobber
kubectl rollout status deployment/<app> -n jobber
```

`auth-http` and `jobs-http` are `type: LoadBalancer` services (see
`charts/jobber/templates/auth/service-http.yaml` and `charts/jobber/templates/jobs/service-http.yaml`).
Minikube has no cloud provider to satisfy `LoadBalancer`, so their `EXTERNAL-IP` stays `<pending>`
until you run `minikube tunnel` (separate terminal, prompts for sudo) — it then assigns a routable
`EXTERNAL-IP` (typically `127.0.0.1`):

```bash
minikube tunnel                        # keep running in its own terminal
kubectl get svc -n jobber auth-http jobs-http   # watch EXTERNAL-IP move from <pending>
```

Both `auth` and `jobs` set a NestJS global prefix matching their app name
(`libs/nestjs/src/lib/init.ts`), but the GraphQL module sets its own explicit `path` (`auth`/`jobs`)
instead of inheriting that prefix via `useGlobalPrefix`, so the endpoints are served directly at
that path (not `/graphql` or `/auth/graphql`/`/jobs/graphql`). `graphiql: true` also enables the
embedded GraphiQL IDE at that same endpoint:

```
http://127.0.0.1:3000/auth
http://127.0.0.1:3001/jobs
```

These bypass the `jobber.local` ingress entirely. On a real cloud cluster (e.g. EKS), prefer the
ALB ingress path (`ingress.alb: true` in `charts/jobber/values.yaml`) over per-service
`LoadBalancer` — one ALB fans out by path/host instead of provisioning a separate billed load
balancer per service.

### Helm

Dependency subcharts (`pulsar`, `postgresql`) are not committed — `charts/jobber/charts/*.tgz` is
gitignored and regenerated from `Chart.lock`. Run this once after cloning, and whenever
`Chart.yaml`/`Chart.lock` changes, before `install`/`upgrade`/`template`/`lint`:

```bash
helm dependency build charts/jobber
```

```bash
# from the repo root
helm upgrade --install jobber charts/jobber -n jobber --create-namespace

# from charts/jobber
helm upgrade jobber . -n jobber    # upgrade an existing release (chart path is ".")
helm install jobber . -n jobber --create-namespace

helm lint charts/jobber            # validate the chart
helm template jobber charts/jobber -n jobber   # render manifests locally without applying
helm diff upgrade jobber charts/jobber -n jobber   # requires the helm-diff plugin

helm list -n jobber                # show installed releases
helm status jobber -n jobber       # show release status
helm uninstall jobber -n jobber
```

### Database

```bash
npx nx run auth:migrate-prisma   # run Prisma migrations
npx nx run auth:generate-prisma  # regenerate Prisma client

npx nx run products:generate-drizzle  # generate Drizzle migrations from schema
npx nx run products:migrate-drizzle   # run Drizzle migrations

npx nx run wallet:migrate-drizzle     # creates the `wallet` database if missing, then migrates
npx nx run wallet:generate-drizzle --name=<name>            # migration from schema changes
npx nx run wallet:generate-drizzle --custom --name=<name>   # empty SQL migration (triggers, seeds)
npx nx run payments:migrate-drizzle   # creates the `payments` database if missing, then migrates
npx nx run market:migrate-drizzle     # creates the `market` database if missing, then migrates
npx nx run wallet:seed                # with auth + wallet running: creates alice@/bob@example.com
                                      # (password Test@1234) if missing, credits $100 each, once
```

`wallet:create-db` (`scripts/create-db.mjs`, run before `migrate-drizzle`) creates the database
named in the project's `DATABASE_URL`; drizzle-kit won't. Nx reports `generate-drizzle` as
successful even when drizzle-kit crashes, so check that a new `.sql` file appeared.

### Proto generation

```bash
npx nx run grpc:generate-ts-proto  # regenerate TypeScript from libs/grpc/src/lib/proto/*.proto
```

`protoc.exe` fails on Windows; generate in a Linux container instead (command in
`docs/nexuspay/02-repo-guide.md`, "Gotchas"; run it from PowerShell). ts-proto runs with
`forceLong=string`, so `int64` fields are decimal strings in TypeScript, and every gRPC client and
server passes `loader: GRPC_LOADER_OPTIONS` (`{ longs: String }`) so they arrive that way.

### Utilities

```bash
npm stop                           # kill Node processes on the app ports (3000-3007, gRPC 5000-5004, 4200, 4300)
npm run cache-clean                # reset Nx cache and npm cache
```

## Architecture

Nx monorepo with eight NestJS microservices, an Angular frontend, a React frontend (`nexus`, the
NexusPay pet project), and ten shared libraries.

NexusPay (the wallet/payments learning project being built in this repo) is documented in
`docs/nexuspay/`: purpose and architecture, repo guide, roadmap, and a step-by-step log of what
was built and why (`docs/nexuspay/README.md` is the entry point).

### Services

| Service    | Port | Role                                                        |
| ---------- | ---- | ----------------------------------------------------------- |
| `auth`     | 3000 | User auth (GraphQL + PostgreSQL/Prisma + gRPC server)       |
| `jobs`     | 3001 | Job management (GraphQL + outbox to Pulsar + gRPC client)   |
| `executor` | 3002 | Job execution (Pulsar consumer + gRPC clients to `jobs`, `products`, `wallet`, `market`, `auth`) and the NexusPay email worker (RabbitMQ → SMTP) |
| `products` | 3003 | Product persistence (gRPC server + PostgreSQL/Drizzle)      |
| `wallet`   | 3004 | NexusPay ledger (GraphQL + gRPC server 5003 + PostgreSQL/Drizzle + outbox to Pulsar) |
| `payments` | 3005 | NexusPay Stripe top-ups (GraphQL + Stripe webhook + PostgreSQL/Drizzle + outbox to Pulsar and RabbitMQ) |
| `market`   | 3006 | NexusPay fake coin market (GraphQL + gRPC server 5004 + price simulator on one leader via Redis + PostgreSQL/Drizzle candles and orders + ticks to RabbitMQ + gRPC client to `wallet`) |
| `realtime` | 3007 | NexusPay WebSocket gateway (raw `ws` at `/realtime`, cookie auth via `auth` gRPC, per-instance RabbitMQ queue on `realtime`) |
| `ui-admin` | 4200 | Angular 22 frontend (Apollo Client against `auth` + `jobs`) |
| `nexus`    | 4300 | React 19 + Vite frontend for NexusPay (`graphql-request`)   |

### Communication Patterns

1. **GraphQL (external)** — clients talk to `auth` and `jobs` via Apollo GraphQL APIs
2. **gRPC (internal)** — `jobs` calls `auth` to validate JWT tokens on every incoming request (`auth` also serves `FindUserByEmail`, for wallet transfers by email, and `GetUser`, for the email worker); other services call `wallet`'s `WalletService` (`Credit`, `GetBalances`, `RunAudit`; `SettleTrade`, `PlaceHold`, `ReleaseHold` for the market); `executor` calls `products` to persist job results and `market`'s `GenerateCandles` for candle backfill; contracts in `libs/grpc/src/lib/proto/*.proto`
3. **Apache Pulsar (async)** — `jobs` publishes job messages to Pulsar topics; `executor` subscribes and processes them. NexusPay events too: `payments` → `payment-succeeded` → `wallet`
4. **RabbitMQ (async)** — work queues and timers: `payment.expire` through the `delay.30m` bucket back into `payments`; `email.topup` from `wallet` to the executor's email worker; `order.expire` through `delay.24h` back into `market`; realtime channels on the `realtime` exchange (`prices.<coin>` from `market`, `user.<id>` from `wallet`), pushed to browsers by `realtime`

### Job Framework

`jobs` has an extensible job system:

- Decorate a class with `@Job()` to register a new job type
- `JobsService` uses `@golevelup/nestjs-discovery` to auto-discover all `@Job()` decorated classes
- The discovered job class validates the payload (at most `MAX_JOB_ITEMS`, 10,000 items; per item its class-validator decorators plus `itemErrors(item)`, a hook for checks they can't express), then in one transaction creates the `Job` row and writes one outbox record per item; the outbox relay publishes them to a Pulsar topic named after the job type. A crash can therefore never leave a job whose messages weren't sent.
- `executor` defines a corresponding `PulsarConsumer<T>` subclass that processes messages from that topic
- Each message carries `jobId` and its item `index`. After `execute`, the executor calls `Acknowledge({ jobId, index })`; `JobsService.acknowledge` inserts a `JobItem (jobId, index)` row and bumps `completed` in one statement, so a redelivered message is counted once. `execute` must be safe to repeat too: `LoadProducts` sends `sourceRef = job:<jobId>:<index>` and `products` ignores a second insert with the same `source_ref`.
- Test hook: start the executor with `FAULT_ACK_FAILURES=<n>` (ignored when `NODE_ENV=production`) and its first n messages fail after `execute`, forcing redeliveries.

See `apps/jobs/src/app/jobs/fibonacci/fibonacci.job.ts` and `apps/executor/src/app/jobs/fibonacci/fibonacci.consumer.ts` for the reference implementation.

The `LedgerAudit` job (`apps/jobs/src/app/jobs/ledger-audit/`) is started nightly at 03:00 UTC by
`LedgerAuditScheduler` (`@nestjs/schedule`; `LEDGER_AUDIT_CRON` in the `jobs` env overrides the
cron expression, `off` disables it) or by hand with `executeJob(name: "LedgerAudit", data: {})`.
Its consumer (`apps/executor/src/app/jobs/ledger-audit/`) calls the wallet's gRPC `RunAudit` and
logs "no issues" or one ERROR line per issue; issues don't fail the job.

The `BackfillCandles` job (`apps/jobs/src/app/jobs/backfill-candles/`, phase 4 step 6) takes a range
`{ from, to?, coins? }` (default: every coin, up to yesterday), expanded to one item per coin-day, or
a list of `{ coin, day }`; days from 2020-01-01 to yesterday (UTC). Its consumer
(`apps/executor/src/app/jobs/backfill-candles/`) calls the market's gRPC `GenerateCandles`
(`MARKET_GRPC_SERVICE_URL`, default `localhost:5004`); `INVALID_ARGUMENT` and `FAILED_PRECONDITION`
(a live coin while the market has live prices off) are dead-lettered at once, `UNAVAILABLE` (every
exchange refused) is retried.

The `LoadProducts` job (`apps/jobs/src/app/jobs/products/load-products.job.ts`) follows the same pattern but its consumer (`apps/executor/src/app/jobs/products/load-products.consumer.ts`) additionally calls the `products` service over gRPC to persist the enriched product data via Drizzle.

### Wallet ledger (`wallet`)

NexusPay's money service (phase 2; top-up credits since phase 3): the only service that changes balances.

- **Schema** (`apps/wallet/src/app/ledger/schema.ts`): `assets` (USD, scale 2), `accounts`
  (owner + asset + kind, cached `balance`), `transactions` (`UNIQUE (type, external_ref)`),
  `entries` (signed amounts), `holds` (limit order reservations: ACTIVE | CAPTURED | RELEASED).
  Amounts are `bigint` minor units everywhere; never JS numbers.
- **Database guarantees** (custom migration `drizzle/0001_ledger_triggers.sql` plus constraints):
  a deferred trigger rejects at COMMIT any transaction whose entries don't sum to zero per
  asset; entries are append-only (UPDATE, DELETE, TRUNCATE raise); user accounts can't go
  negative (`user_balance_non_negative`; system accounts like `seed` may); an entry's asset must
  be its account's (`(account_id, asset)` foreign key).
- **`LedgerService.post({ type, externalRef, legs })`** is the only way to move money: idempotent
  by `(type, externalRef)` (returns `duplicate: true`, writes nothing), locks the touched accounts
  in ascending id order with `FOR UPDATE` (no deadlocks), maps the balance check to
  `InsufficientFundsError` and malformed postings to `InvalidPostingError`; on either, nothing is
  written. `outbox: (transactionId) => records` writes events in the same transaction through
  `DrizzleOutboxStore` (none for a duplicate or a refused posting). `ensureAccounts(userId, asset)` / `ensureSystemAccount(name, asset)` create accounts
  lazily.
- **Assets:** USD plus the market's coins NXC, BLIP, ORB, WISP (scale 8; seeded by
  `drizzle/0004_coin_assets.sql`) and BTC, ETH, HYPE, ZEC (`0006_live_coin_assets.sql`); a test
  checks the table against `ASSETS`. `balances` lists
  USD always (its accounts are created on first read) and a coin only once the user has accounts
  in it; `transfer` takes fiat only, because coins move through trades.
- **GraphQL** (`/wallet`, code-first, `apps/wallet/src/app/wallet/`): `balances`, `entries(asset, after,
  first)` (newest first, cursor = last entry id), `topUp(paymentId)` (the user's entry for a
  Stripe top-up, `null` until credited; the React app polls it after `payments` says SUCCEEDED), `transfer(input: { toEmail, asset, amount })`, all
  behind `GqlAuthGuard`. Money is the `MinorUnits` scalar: a decimal string of minor units, never a
  JSON number. Caller mistakes are `BAD_USER_INPUT` (or `BAD_REQUEST` from `ValidationPipe`) with
  messages that start with the field name. The app prints its schema to `apps/wallet/schema.gql`
  on startup (in `.prettierignore`); a test fails when the committed file is stale, so commit it
  after changing the API.
- **gRPC `WalletService`** (5003, `wallet.proto`): `Credit` (from `seed` or `stripe_clearing`;
  `seed` is refused in production), `GetBalances`, `RunAudit` (`LedgerService.audit()`: cached
  balances vs entries, unbalanced transactions, in one REPEATABLE READ snapshot), and the
  trading RPCs below. Errors: `INVALID_ARGUMENT` (caller mistakes), `FAILED_PRECONDITION`
  (insufficient funds, a hold no longer ACTIVE: nothing written), `NOT_FOUND` (unknown hold).
- **Trading** (`apps/wallet/src/app/trading/`, phase 4): `TradingService`, each call idempotent by
  its id. `PlaceHold` inserts an ACTIVE `holds` row (id = the limit order's id) and posts `hold`
  (available → held) in one transaction; `ReleaseHold` posts `release` (held → available).
  `SettleTrade` posts `trade` (`externalRef = tradeId`) against the `market_maker` system account,
  fee to `fees`; with `holdId` the user's side comes from the hold (locked `FOR UPDATE` before the
  duplicate check), the rest goes back to available and the hold is CAPTURED. A retry with other
  terms is refused. In the same transaction, when the market maker drops below 100 coins an
  `inventory` posting refills it to 1,000 from `genesis`. Writes `trade-executed` (Pulsar) and a
  realtime `fill`. GraphQL `positions` replays the user's trade metadata into quantity and
  average cost (faucet coins aren't counted).
- **Realtime balances:** every posting writes, per (user, asset) it touched, a RabbitMQ
  `realtime` / `user.<id>` record `{ type: 'balance', asset, available, held }` (absolute values).
  It locks both accounts of the pair, so for one (user, asset) a later change has a higher outbox
  id. Use `LedgerService.postIn(tx, input)` for work that must commit with a posting.
- **Top-ups:** `PaymentSucceededConsumer` (`apps/wallet/src/app/topups/`, Pulsar topic
  `payment-succeeded`, subscription `wallet`, Key_Shared) validates the message
  (`validateMessage`; bad data is dead-lettered) and posts `type: 'topup'`,
  `externalRef = paymentId`, `stripe_clearing −X / user available +X`, with the RabbitMQ
  `notifications` / `email.topup` record `{ userId, paymentId, amount, currency }` in the same
  transaction, so a redelivery credits once and emails once. `FAULT_CRASH_AFTER_CREDIT=1` (not in
  production) exits after the commit and before the ack. The wallet declares the notifications
  topology too (`RabbitModule` in `app.module.ts`), so an email published before the executor
  ever started still has a queue.
- **Outbox** (`OutboxModule`, global, `apps/wallet/src/app/outbox/`): one relay with the Pulsar
  and the RabbitMQ publisher. Each transfer writes `transfer-completed` (`{ transactionId, fromUserId, toUserId,
  asset, amount }`) in its transaction; `OutboxRelay` publishes it to Pulsar (no consumer yet).
- **Idempotency:** `transfer` is `@Idempotent()` and requires an `Idempotency-Key` header: a retry
  with the same key and input gets the stored response (`Idempotent-Replayed: true`), the same
  key with another input gets `UNPROCESSABLE_ENTITY`, a concurrent duplicate gets `CONFLICT`. The
  ledger `externalRef` is `transfer:<userId>:<key>`, so even a retry that takes over a claim
  after a crash posts once. Redis (`REDIS_URL`) is only the fast path; PostgreSQL
  (`idempotency_keys`) decides.
- **Load tests** (k6 in Docker, against running `auth` + `wallet`): `npx nx run wallet:load-test
  overdraft` (200 concurrent $1 transfers from $100: exactly 100 succeed), `deadlock` (100 each
  way), `same-key` (50 parallel requests, one key: one transfer). Scripts in `apps/wallet/load/`.
- Amounts cross boundaries through `@jobber/money` (`parseAmount`, `formatAmount`, `toWire`,
  `fromWire`): `bigint` in code, a decimal string of minor units on the wire.
- Tests run against a Testcontainers PostgreSQL 18 (`src/testing/test-database.ts`) and check
  after every test that each asset sums to zero and each cached balance equals its entries.
  `wallet.api.spec.ts` drives the GraphQL API over HTTP with only `auth` and Pulsar faked.

### Market (`market`)

NexusPay's fake coin market (phase 4, `apps/market`, port 3006, GraphQL at `/market`). It never
changes balances: trades settle through the wallet's gRPC (`WALLET_GRPC_SERVICE_URL`). Prices:
`docs/nexuspay/phase-4/03-market-prices.md`; orders: `04-market-orders.md`.

- **Coins** (`prices/coins.ts`): each has a `source`, `simulated` (NXC, BLIP, ORB, WISP: start
  price, `mu`, `sigma` per day, shock chance per minute) or `live` (BTC, ETH, HYPE, ZEC: Coinbase
  `BTC-USD` and Binance `BTCUSDT` pairs; phase 4.5, `docs/nexuspay/phase-4.5/`).
  `SIMULATED_COINS`, `LIVE_COINS`, `simulated(coin)`, `liveSymbols(coin)`.
- **Price providers** (`prices/providers/`, phase 4.5 step 2): `PriceProvider` with
  `CoinbaseProvider` (`ticker` + `heartbeat` on `ws-feed.exchange.coinbase.com`, candles 300 per
  request) and `BinanceProvider` (combined `miniTicker` stream and `klines` on the
  `*.binance.vision` market-data hosts). Prices leave a provider as unrounded cents (`floatCentsOf`
  moves the decimal point in the text), candles as `bigint` cents (`centsOf`). Both share
  `ReconnectingSocket` (1 s → 30 s jitter backoff, `alive` = a message in the last 5 s, a silent
  connection replaced after 30 s). Tests use `src/testing/fake-exchanges.ts` (`FakeCoinbase`,
  `FakeBinance`: silence, mute, drop, refuse, REST failures) on localhost.
- **Live prices** (`prices/live/`, phase 4.5 step 3; `docs/nexuspay/phase-4.5/03-live-ticks.md`):
  `MARKET_LIVE_PRICES=on` (unset = off: nothing reaches the internet; `.env` has `on`),
  `MARKET_PRICE_PROVIDERS` (preference order, default `binance,coinbase`: Coinbase's market data terms are stricter, `02-providers.md`), `COINBASE_WS_URL`,
  `COINBASE_REST_URL`, `BINANCE_WS_URL`, `BINANCE_REST_URL`. Only the simulator leader connects
  (`LivePrices.start` on leading, `stop` on stepping down). `RatePicker` (pure: given the time and
  which connections are alive) picks per coin each tick: healthy = connection alive + a price or
  heartbeat for the coin within 10 s; failover at once to the next healthy provider; failback
  after 30 s of steady health (a provider never healthy yet takes the coin at once); nobody
  healthy = no tick; a price >10% from the last published one is held until the same provider
  repeats it within 5 s (±2%) or another confirms it; >1% divergence logged. `PriceTicker.tick`
  appends the live picks to the simulated ticks (same Redis `seq`, RabbitMQ, candles, matcher).
  `live-prices.api.spec.ts` runs acceptance tests 2–6 against the fake exchanges.
- **Live history** (`prices/live/live-history.ts`, phase 4.5 step 4; `04-history.md`): `LiveHistory`
  asks the providers' REST candles in preference order (the next on any error) and writes with
  `insertMissing` (ticked minutes win). `loadDay` serves `GenerateCandles` for a live coin (day
  2020-01-01 to today, today up to the last completed minute; `FAILED_PRECONDITION` while live
  prices are off, `UNAVAILABLE` when every exchange refuses); `fillRecent` runs in the background
  when a replica starts leading: per coin, the range from the first to the last missing minute of
  the 24 h before the current one. `LiveModule` holds `LivePrices`, `LiveHistory` and the options,
  shared by `PricesModule` and `BackfillModule`. Jest's `setupFiles` (`src/testing/offline.ts`)
  deletes `MARKET_LIVE_PRICES` and the endpoint variables: Nx loads `apps/market/.env` into test
  tasks, and no test may reach the exchanges.
- **Simulator** (`src/app/prices/`): each simulated coin follows a geometric random walk, one step per second, from its own
  mulberry32 stream seeded by `MARKET_SEED` (unset: random, logged) and the coin code. Same seed,
  same ticks (`PriceSimulator`). Prices are published in whole USD cents per coin (`bigint`, at
  least 1); the float `mid` is kept for the next step.
- **One leader:** `SimulatorService` on every replica campaigns for Redis `market:simulator`
  (`SET NX PX 5000`, renewed every 2 s by a compare-and-PEXPIRE script, released on shutdown).
  `LeaderLock.held` counts the 5 s from when the command was sent, so a stalled leader stops
  before its key expires; every tick checks it. Followers retry at the key's expiry (from `PTTL`)
  or every 500 ms. `MARKET_SIMULATOR=off` keeps a replica out of the election.
- **Each tick** (`PriceTicker`): one Lua script per coin bumps `seq` and stores
  `price:<coin>` (`price`, `mid`, `seq`, `at`) in Redis, so `seq` keeps increasing across
  leaders; then RabbitMQ `realtime` / `prices.<coin>` (non-persistent, 5 s expiration,
  `messageId = price-<coin>-<seq>`, published directly, no outbox); then the in-memory 1-minute
  candle. A new leader resumes each walk from the stored `mid`.
- **Candles** (`candles`: `(coin, interval '1m', start)` key, OHLC `bigint` cents, a CHECK that
  it's a real candle): written when the next minute starts and when leadership ends; the upsert
  keeps the earlier open, widens high/low, takes the later close, so a minute written by two
  leaders merges. Refused writes are kept (up to a day) and retried.
- **GraphQL:** `coins` (latest tick from Redis with its `seq` and `source`, `live`, `open24h` from candles),
  `candles(coin, from, to)` (1-minute, oldest first, at most 24 h, default the last 24 h),
  `quote(coin, side, qty)` (signed in; `PRICES_UNAVAILABLE` if the price is older than 10 s;
  stores `{ userId, coin, side, qty, price, usdAmount, fee }` at `quote:<id>` for 10 s).
  Schema printed to `apps/market/schema.gql` (a test fails when stale).
- **Generated history** (`prices/backfill.ts`, gRPC `GenerateCandles` on `MARKET_GRPC_SERVICE_URL`
  5004, `backfill/market.controller.ts`): a day's 1,440 candles from a fixed seed, the coin and the
  day only (not `MARKET_SEED`), so every replica and repeat gives the same: daily anchors from a
  mean-reverting walk around the coin's start price (2020-01-01 on), a one-second Brownian bridge
  between consecutive anchors. `CandleStore.insertMissing` (`ON CONFLICT DO NOTHING`): live
  candles win, a repeat writes 0. Today and later are refused (`INVALID_ARGUMENT`). Live coins'
  days come from the exchanges instead (Live history, above).
- **Pricing** (`market/pricing.ts`, `bigint`): price = mid ± 0.2% (buy rounds up, sell down);
  `usdAmount = price · qty / 10^8` (buy up, sell down); fee = 0.5% rounded up. A property test
  checks the house never loses on rounding. Limit orders (`limitAmounts`) trade at the limit,
  no spread; a buy holds `usdAmount + fee` (`holdFor`), a sell its coins.
- **Orders** (`src/app/orders/`, table `orders`): id = the wallet's `tradeId` / `holdId`;
  `usdAmount` and `fee` are fixed at creation so every `SettleTrade` retry sends the same
  terms. Statuses `PLACING` (limit, hold not confirmed) → `OPEN` → `SETTLING` → `FILLED`, or
  `CANCELLED` / `EXPIRED` / `REJECTED`; every change is `UPDATE … WHERE status = <expected>`, so a
  cancel racing a fill has one winner. Only an `OPEN` order is matched, cancelled or expired.
  - `placeOrder(input)` (`@Idempotent()`, `request_key` stored too): MARKET takes the quote
    (Lua: only its owner; else `QUOTE_EXPIRED`), inserts `SETTLING`, settles; LIMIT inserts
    `PLACING` + outbox `order.expire` (bucket `ORDER_EXPIRY_BUCKET`, default `delay.24h`) in one
    transaction, then `PlaceHold`. `cancelOrder(id)` (`ORDER_NOT_OPEN` unless OPEN/CANCELLED),
    `orders(status, first)`.
  - `OrderSettlement` / `WalletClient`: refused (`FAILED_PRECONDITION`, `INVALID_ARGUMENT`,
    `NOT_FOUND`) → `REJECTED` with the wallet's reason; unknown (timeout 5 s, unavailable) → two
    retries with the same id, then left for recovery.
  - `OrderMatcher` (on the leader, `SimulatorService.onTick`): one claim `UPDATE … SET status =
    'SETTLING' WHERE status = 'OPEN' AND <crossed>`, then `SettleTrade` with `holdId`. Ticks
    during a running match widen a per-coin low/high range.
  - `OrderRecovery` (every replica, 10 s): retries `SETTLING`, `PLACING` and unreleased
    `CANCELLED`/`EXPIRED` orders unchanged for 30 s. `OrderCommandsConsumer` on
    `market.commands` (`order.*`) expires orders.
  - `FAULT_CRASH_BEFORE_SETTLE=1` (not in production) exits after storing a market order, before
    `SettleTrade` (acceptance test 7).
  - `outbox` and `idempotency_keys` have `schema.ts` files for drizzle-kit only; keep them out of
    `database.ts`'s runtime schema (`@jobber/idempotency/table` isn't aliased in the bundle).
- Tests: pure specs for the walk, pricing and candles; `leader-lock.spec.ts` on Testcontainers
  Redis; `market.api.spec.ts` runs real replicas against Testcontainers PostgreSQL, Redis and
  RabbitMQ with the production timings (only `auth` faked), including failover on shutdown and
  on a leader cut off from Redis. `orders.api.spec.ts` runs orders against
  `testing/fake-wallet.ts`: a real gRPC server on `wallet.proto` with an in-memory ledger
  (idempotent by id, holds, refusals) that can fail a call before or after applying it.

### Realtime gateway (`realtime`)

NexusPay's WebSocket gateway (phase 4 step 5, `apps/realtime`, port 3007, no database;
`docs/nexuspay/phase-4/05-realtime-gateway.md`).

- **Upgrade** (`gateway/realtime.gateway.ts`): `WebSocketServer({ noServer: true })` on Nest's
  HTTP server, path `/realtime`. Before `handleUpgrade`: wrong path 404, `Origin` not in
  `REALTIME_ALLOWED_ORIGINS` 403 (no `Origin` = not a browser, allowed), no/invalid
  `Authentication` cookie 401 (auth gRPC `Authenticate`, `SocketAuth`), auth unreachable or
  shutting down 503. Refusals are raw `HTTP/1.1 <status>` on the TCP socket.
- **Protocol** (`gateway/protocol.ts`): client `{ op: subscribe | unsubscribe, channel }`;
  server `welcome` (after the user's binding exists), `subscribed`, `unsubscribed`,
  `message { channel, seq, data }`, `error { code: BAD_REQUEST | FORBIDDEN | UNKNOWN_CHANNEL |
  TOO_MANY_SUBSCRIPTIONS }`, `resync`. Each socket is joined to its own `user.<id>`; any `user.*`
  subscribe is FORBIDDEN; public channels are `prices.<coin>`. `seq`: price body's `seq`, or the
  outbox id from `messageId` `outbox-<service>-<id>` (no seq → not forwarded). Frames over 1 KB
  close with 1009.
- **Feed** (`RealtimeFeed`, `TransientQueue` from `libs/rabbitmq`): one exclusive auto-delete
  queue per instance, `prices.*` always, `user.<id>` while the user has a socket here
  (`Registry` counts them). After a RabbitMQ reconnect: new queue, same bindings, `resync` to
  every socket.
- **Backpressure:** `bufferedAmount` > 1 MB drops price messages for that socket (never user
  messages); > 4 MB for 10 s closes it with 1013. **Heartbeat:** ping every 25 s, terminated after
  two missed pongs. **Shutdown:** 503 to new upgrades, every socket closed with 1012.
  `GatewayOptions` (`GATEWAY_OPTIONS`) holds the numbers; tests lower them.
- `GET /realtime/stats`: sockets, users, channels, bindings, counters, memory.
- Tests: `protocol.spec.ts`, `registry.spec.ts`; `gateway.api.spec.ts` runs replicas against
  Testcontainers RabbitMQ with `ws` clients (auth faked) and reads bindings from the management
  API. Load: `apps/realtime/load/prices-and-fills.js` (k6 via `scripts/k6.mjs`, which runs any
  project's `load/<name>.js`).

### Email worker (`executor`)

`apps/executor/src/app/notifications/`, loaded only when `RABBITMQ_URL` is set
(`ConditionalModule`), so executor deployments without RabbitMQ (docker-compose.apps.yaml, Helm)
start as before.

- `EmailConsumer` on `notifications.email` (routing key `email.topup`): validates
  `TopUpEmailMessage`, skips a `messageId` already in Redis (`email:sent:<messageId>`, set after
  sending, 7-day TTL), asks auth `GetUser` for the address, sends with nodemailer to `SMTP_URL`
  (`EMAIL_FROM`). An unknown user, bad data or a missing `messageId` go to the DLQ at once; SMTP,
  Redis or auth failures retry (5 s / 30 s / 5 min, 5 attempts), then
  `notifications.email.dlq` → `npx nx run rabbitmq:replay --queue=notifications.email`.
- A crash between sending and remembering can send twice; acceptable for an email, never for
  money.
- nodemailer 10 ships its own types (no `@types/nodemailer`).
- Tests (`email.consumer.spec.ts`): Testcontainers RabbitMQ, Redis and Mailpit (its API checks
  the inbox), retries shortened to 300 ms / 600 ms.

### Payments (`payments`)

NexusPay's Stripe Checkout top-ups (phase 3, `apps/payments`, port 3005). It never changes
balances: it announces `payment-succeeded` and the wallet credits it (phase 3, step 4).

- **Schema** (`apps/payments/src/app/payments/schema.ts`): `payments` (uuid id, `user_id`,
  `amount` bigint 100..100000, `currency` USD, `status` PENDING | SUCCEEDED | EXPIRED | FAILED,
  unique `stripe_session_id`), `stripe_events` (event id primary key: each webhook event applies
  once), `recon_issues` (money and records that disagree; nothing is credited), plus `outbox` and
  `idempotency_keys`. Every state change is `UPDATE … WHERE id = $1 AND status = 'PENDING'`.
- **GraphQL** (`/payments`, behind `GqlAuthGuard`): `createTopUp(input: { amount })`
  (`@Idempotent()`, needs an `Idempotency-Key` header; USD 1 to 1,000, at most USD 2,000 per user
  per rolling 24 h counting PENDING and SUCCEEDED, else `BAD_USER_INPUT`; Stripe down gives
  `PAYMENT_PROVIDER_UNAVAILABLE`), `payment(id)` (null unless it's the caller's),
  `payments(first)`. Schema printed to `apps/payments/schema.gql` (a test fails when stale).
- **`createTopUp`:** transaction 1 inserts PENDING and puts `payment.expire` in the outbox for the
  delay bucket `PAYMENT_EXPIRY_BUCKET` (`delay.30m`); then, outside any transaction,
  `checkout.sessions.create` (idempotency key `checkout-session:<paymentId>`, metadata and
  `client_reference_id` = payment id, `success_url = APP_URL/wallet?topup=<id>`, expires in
  31 min); then the session id is stored, or the payment is set FAILED.
- **Webhook** `POST /payments/webhooks/stripe`: `main.ts` creates the app with `rawBody: true`;
  `constructEvent` on the raw body or 400 (503 while `STRIPE_WEBHOOK_SECRET` is unset).
  `applyStripeEvent` runs in one transaction: insert the event id (a duplicate stops there), then
  `checkout.session.completed` + paid sets SUCCEEDED and writes `payment-succeeded` (Pulsar, key
  `userId`), unless the payment isn't PENDING or the amount, currency or session differs (a recon
  issue instead). `checkout.session.expired` sets EXPIRED.
- **Expiry** (`PaymentCommandsConsumer` on `payments.commands`): calls Stripe's
  `sessions.expire` first. If Stripe refuses because the session is complete and paid, it settles
  the payment like the webhook would; an unreachable Stripe throws and the command retries.
- **Stripe client** (`stripe.client.ts`): `stripe` 23.1.0 pinned, `apiVersion`
  `2026-10-28.endive` pinned; upgrade both together.
- **Secrets:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` live in `apps/payments/.env.local`
  (gitignored; `ConfigModule` reads it before `.env`). Every `apps/*/.env` is committed, so
  never put a secret there.
- **Stripe CLI** for local webhooks: `stripe login` once; `stripe listen --print-secret` gives the
  `whsec_…` for `.env.local` (the same for every session of that login; restart `payments` after
  changing it). Then
  `stripe listen --events "checkout.session.completed,checkout.session.expired" --forward-to localhost:3005/payments/webhooks/stripe`:
  CLI 1.55 refuses to start without `--events`, and PowerShell needs the list quoted.
  `stripe events resend <evt_id>` replays a webhook. The manual run is in
  `docs/nexuspay/02-repo-guide.md`. Watch an unpaid top-up expire after a minute with
  `PAYMENT_EXPIRY_BUCKET=delay.1m`.
- Tests (`payments.api.spec.ts`) run the real app against Testcontainers PostgreSQL and RabbitMQ
  (`delay.1m` shortened to 2 s) with `auth`, Pulsar and Stripe's Checkout API faked; webhook
  signatures are made with `stripe.webhooks.generateTestHeaderString`.

### Frontend (`ui-admin`)

Zoneless, standalone Angular 22 app (signals, lazy routes, Vitest via `@angular/build:unit-test`).
It deliberately uses the newest Angular APIs; keep new code on them:

- **Signal forms** (`@angular/forms/signals`: `form()`, `[formField]`, `[formRoot]`, submission
  `action`), not reactive forms. Server errors go through `serverErrors()`
  (`apps/ui-admin/src/app/shared/error-message.ts`), which attaches class-validator messages to the
  field they name. `signalFormsConfig` is provided per form component (not in `app.config.ts`)
  to keep signal forms out of the initial bundle.
- **Resource API** — Apollo queries are exposed as plain data streams by `JobsService` and
  consumed via `rxResource` (`value()`/`hasValue()`/`error()`/`reload()`). Guard `value()` with
  `hasValue()`: it throws in the error state.
- **Signal inputs** (`input()`, bound from route params/query via `withComponentInputBinding`),
  `linkedSignal` for derived-but-editable state, `@let` in templates.
- GraphQL stays on Apollo for now; new direct (non-GraphQL) HTTP calls should use `httpResource`.

- `apps/ui-admin/src/app/graphql.provider.ts` — two Apollo clients: the default one for `jobs` and a
  named `auth` client (`AUTH_CLIENT`). An error link clears the session and redirects to `/login`
  on a `FORBIDDEN` response from `GqlAuthGuard`.
- Endpoints are relative (`/api/auth`, `/api/jobs`); `apps/ui-admin/proxy.conf.json` strips `/api` and
  forwards to ports 3000/3001 during `nx serve ui-admin`, so the HttpOnly cookie is same-origin
  (`/api/jaeger` likewise maps to Jaeger's query API on 16686). The
  `/api` prefix keeps the proxy from capturing the UI's own `/jobs` routes on a page refresh.
- The JWT cookie is unreadable from JS and `auth` has no "current user" query, so `Session`
  (`apps/ui-admin/src/app/auth/session.ts`) remembers the user returned by `login` in `localStorage`.
- `job(id)` takes `Float!`, not `Int!` (the resolver arg is an untyped TS `number`).
- The job detail page draws the services a job passes through as an animated SVG
  (`apps/ui-admin/src/app/jobs/job-pipeline/`; layout and routes are plain data in `pipeline.ts`).
  By default the dots are illustrative, sent whenever the polled `completed` count rises.
  "Replay real trace" loads the job's trace (`Job.traceId`, stored by `jobs` when the job is
  created) from Jaeger through the dev proxy's `/api/jaeger` and replays the real spans
  (`trace.ts`): real order and gaps, slowed down, with real durations in the log. Its tests use
  real traces trimmed into `job-pipeline/testing/trace-fixtures.ts`.

### Frontend (`nexus`)

React 19 + Vite app for NexusPay (`apps/nexus`), generated with `@nx/react`. Its targets are
inferred by `@nx/vite/plugin`, `@nx/vitest` and `@nx/js/typescript`, which `nx.json` scopes to
`apps/nexus/**` so they don't add targets to the other projects.

- **Stack:** TanStack Router (code-based routes in `src/router.tsx`), TanStack Query,
  `graphql-request`, React Hook Form + Zod, Tailwind CSS v4 (`@tailwindcss/vite`).
- **Session:** `src/lib/session.ts` mirrors the Angular `Session` (user from `login` kept in
  `localStorage`), exposed to components through `useSyncExternalStore` (`useSession()`).
  Protected routes redirect in `beforeLoad`; `safeReturnUrl()` only allows same-app paths.
- **Server errors:** `applyServerErrors()` (`src/lib/errors.ts`) is the React counterpart of
  `serverErrors()`: class-validator messages go on the field they name, the rest on `root.server`.
- **API:** relative `/api/<service>` URLs; `vite.config.mts` proxies them with `/api` stripped
  (`/api/auth` → 3000, `/api/wallet` → 3004, `/api/payments` → 3005, `/api/market` → 3006,
  `/api/realtime` → 3007 with `ws: true`), keeping the HttpOnly cookie same-origin.
  `createQueryClient()` (`src/lib/query-client.ts`) clears the session and goes to `/login` on
  any `FORBIDDEN` answer.
- **GraphQL Codegen** (`apps/nexus/codegen.ts`, `npx nx run nexus:codegen`): client preset, one
  output per backend (`src/gql/auth`, `src/gql/wallet`, `src/gql/payments`, `src/gql/market`;
  documents from `features/auth`, `features/wallet`, `features/topup`, `features/market`) from
  the schema files the backends print on startup (`apps/{auth,wallet,payments,market}/schema.gql`;
  each has a test that fails when it is stale). Write documents with that output's `graphql()` (see `features/wallet/wallet-api.ts`)
  and rerun codegen; CI regenerates and fails on any difference. `src/gql` is excluded from
  Prettier and ESLint. `MinorUnits` and `DateTime` are strings; use `@jobber/money` to parse and
  format amounts.
- **Pages:** `/wallet` (balances, history with "Load more") and `/send` (one `Idempotency-Key` per
  transfer, reused when the same recipient and amount are retried; an in-flight ref ignores a
  double submit). `/topup` (one `Idempotency-Key` per amount, `createTopUp`, then
  `window.location.assign(checkoutUrl)` through the `goTo` prop; the button stays disabled while
  the browser leaves). Stripe returns to `/wallet?topup=<paymentId>`: `TopUpStatus`
  (`features/topup/top-up-status.tsx`) polls `payment(id)`, then the wallet's `topUp(paymentId)`,
  once a second for up to 30 s each, and invalidates `['wallet']` only after the credit.
  `/` redirects to `/wallet`.
- **Realtime** (`src/lib/realtime/`, phase 4 step 7): one `RealtimeClient` per tab (`main.tsx`),
  connected by the shell while signed in, URL `/api/realtime`. Ref-counted `subscribe(channel)`,
  reconnect 1 s → 30 s ×(0.5–1) jitter (1012: within a second), resubscribe on `welcome`,
  `onResynced` on every welcome and `resync` (refetch), drops a `seq` that isn't newer (per price
  channel, per asset for balances, per order for fills). `PriceBook` + `usePrice(coin)`
  (`useSyncExternalStore`); `useConnectionStatus` (header dot). `useUserFeed`
  (`features/market/use-user-feed.ts`, mounted in the shell): `balance` → `setQueryData` on
  `['wallet','balances']`, `fill` → invalidate orders/positions/history + toast, `resynced` →
  invalidate `['wallet']` and `['market','orders']`. Tests use `fakeRealtime()`
  (`src/testing/fake-socket.ts`) and `renderPage(Page, { realtime })`.
- **Market pages** (`src/features/market/`): `/markets` (live prices, 24 h change),
  `/trade/$coin` (`PriceChart` with `lightweight-charts` 5.2.1, lazy-loaded, live ticks via
  `applyTick`; `OrderForm`: market orders quote → countdown → re-quote at 0, `Idempotency-Key` =
  quote id; limit orders one key per side/qty/price; open orders with Cancel), `/portfolio`
  (`positions` at live prices, P/L). `TopUpStatus` waits for the credit on USD `balance`
  messages and `resynced`, polling only while the socket isn't open.
- **Tests:** Vitest + Testing Library; pages that call the API use MSW 3 (`graphql` comes from
  `msw/graphql`) through `src/testing/render-page.tsx` (`mockServer()`, `renderPage()`).
  `apps/nexus-e2e` runs Playwright (Chromium) against the real backends: global setup creates
  fresh users (sender, recipient, trader), funds two over gRPC, and starts the realtime gateway
  from `dist/apps/realtime` when 3007 is free (`gateway.ts`; teardown stops it). `trade.spec.ts`:
  trade flows and acceptance test 10 (kills that gateway, credits while it is down, restarts it;
  skipped if the gateway wasn't ours). Run `npx playwright install chromium` once.
- **UI components** (`src/components/ui`) are hand-written in shadcn/ui's style, not generated by
  its CLI.
- **ESLint:** `eslint-plugin-react` 7 crashes on ESLint 10 while auto-detecting the React
  version (`context.getFilename` was removed), so `apps/nexus/eslint.config.mjs` pins
  `settings.react.version`.

### Shared Libraries

- **`@jobber/graphql`** (`libs/graphql`) — `AbstractModel` (GraphQL base type), `GqlContext`, `GqlAuthGuard`
- **`@jobber/nestjs`** (`libs/nestjs`) — `init()` bootstrap helper used by all apps, `Jobs` enum
- **`@jobber/grpc`** (`libs/grpc`) — gRPC proto files and generated TypeScript types for `AuthService`, `ProductsService`, `JobsService`, `WalletService` and `MarketService` (`GenerateCandles`, served by `apps/market` on 5004), plus the `Packages` enum, `GRPC_LOADER_OPTIONS` and `GrpcStatus` (status codes for `RpcException`)
- **`@jobber/prisma`** (`libs/prisma`) — Prisma client used by `auth`
- **`@jobber/tracing`** (`libs/tracing`) — `startTracing(serviceName)`: OpenTelemetry SDK with http, express, Nest, GraphQL, gRPC and pg (only inside a traced request) instrumentation, exporting over OTLP/HTTP. Call it on the line right after `require('module-alias/register')` in `main.ts`, before anything loads NestJS: instrumentations patch modules when they are first required. Pulsar isn't instrumented; `send()` and the outbox write `traceparent` into message properties and `PulsarConsumer` continues the trace from them.
- **`@jobber/money`** (`libs/money`) — amounts as `bigint` minor units: `ASSETS` (USD, scale 2, `kind: 'fiat'`; coins NXC, BLIP, ORB, WISP (simulated) and BTC, ETH, HYPE, ZEC (real prices, phase 4.5), scale 8, `kind: 'coin'`), `COINS`, `FIAT`, `isCoin`, `isFiat`, `parseAmount` ("12.34" → `1234n`, never rounds), `formatAmount` (exact, via `Intl.NumberFormat` on a decimal string; coins as `1.50000000 NXC`, since `Intl` refuses non-ISO codes), `toWire`/`fromWire` (canonical decimal strings). No framework imports, so `nexus` can use it too.
- **`@jobber/idempotency`** (`libs/idempotency`) — `@Idempotent({ operation })` for GraphQL resolvers and HTTP handlers (`IdempotencyInterceptor`), `@IdempotencyKey()` to read the key in the handler, `DrizzleIdempotencyStore` + `idempotencyKeysTable()` (import the table from `@jobber/idempotency/table` in Drizzle schema files: drizzle-kit can't load the decorators), `RedisIdempotencyLock` (no offline queue: fails fast when Redis is down), `IdempotencyCleanup` (hourly expiry). The module provides `IDEMPOTENCY_STORE` and optionally `IDEMPOTENCY_LOCK`; see `apps/wallet/src/app/wallet/wallet.module.ts`.
- **`@jobber/outbox`** (`libs/outbox`) — transactional outbox. An app writes records in the same DB transaction as its state change (`PrismaOutboxStore.enqueue(tx, records)`, or `DrizzleOutboxStore.enqueue(tx, records)` for Drizzle apps), and `OutboxRelay` publishes them in the background: batches claimed with `FOR UPDATE SKIP LOCKED`, one ordered stream per transport (a RabbitMQ outage only holds back RabbitMQ records, each transport backs off on its own), published in id order, stopping at the first failure; `poke()` after a commit publishes right away. Each app creates the `outbox` table in its own migration (contract in `libs/outbox/src/lib/outbox.types.ts`; `jobs` maps it as the Prisma model `OutboxMessage`). `PulsarOutboxPublisher` uses one producer per topic named `outbox-<service>-<topic>` and the outbox id as `sequenceId`, so run one relay per service. `RabbitOutboxPublisher` (records with `transport: 'rabbitmq'`) publishes to the exchange `destination` with routing key `key` (a delay bucket such as `delay.30m` delays a command) and `messageId = outbox-<service>-<id>`; RabbitMQ doesn't deduplicate, so consumers dedupe on that id. One relay takes both publishers. Delivery is at-least-once.
- **`@jobber/rabbitmq`** (`libs/rabbitmq`) — `RabbitModule.forRoot / forRootAsync({ url, topology, connectionName })` registers one `RabbitConnection` and a `RabbitPublisher` app-wide. Used by `payments` (`commands` exchange, `payments.commands`, delay buckets), `market` (price ticks; `market.commands`, `order.expire`), `realtime` (its per-instance queue), `wallet` (publishes `email.topup` and realtime `user.<id>` messages) and `executor` (email worker).
  - Shared notifications contract (`notifications.ts`): `NOTIFICATIONS_EXCHANGE`, `EMAIL_QUEUE` (`notifications.email`, bound to `email.*`), `EMAIL_TOPUP`, `notificationsTopology(retry?)` (declared by publisher and consumer alike, with the same retry, or RabbitMQ refuses the redeclare) and `TopUpEmailMessage` (class-validator).
  - `TransientQueue` (`transient-queue.ts`): a server-named exclusive, auto-delete queue whose bindings change at runtime (`bind`, `unbind`, in call order) and are re-bound on a new queue after every reconnect (`onReady({ reconnected })`), consumed without acks. Built on `RabbitConnection.onConnect(hook)`, which runs after the topology and consumers on every connect.
  - Commands contract (`commands.ts`): `COMMANDS_EXCHANGE` (`commands`), `DELAY_BUCKETS` (`delay.1m`, `delay.30m`, `delay.24h`, all into `commands`) and `delayBucket(name)`. Every service declares the same buckets (RabbitMQ refuses a redeclare with another TTL), so they live only here.
  - Realtime contract (`realtime.ts`, phase 4): `REALTIME_EXCHANGE` (`realtime`, topic), `userChannel(id)` (`user.<id>`), `priceChannel(coin)` (`prices.<coin>`), `realtimeTopology()`, `RealtimeBalanceMessage`, `RealtimeFillMessage`, `RealtimePriceMessage` (`{ type: 'price', coin, price, seq, at, source }`, `source` one of `PRICE_TICK_SOURCES`: `simulator`, `coinbase`, `binance`). `mergeTopologies(...parts)` combines topologies (the wallet declares notifications + realtime).
  - The connection reconnects in the background (1 s → 30 s backoff) and re-declares the topology (`declareTopology()`: exchanges, quorum queues, `<queue>.retry.<n>` TTL queues, `<queue>.dlq`, delay buckets) on every connect. The app starts while RabbitMQ is down; publishes then reject at once with `RabbitUnavailableError` (the outbox retries them).
  - `RabbitPublisher.publish(exchange, routingKey, payload, { messageId, headers?, persistent?, expirationMs? })` sends JSON on a confirm channel, resolves when the broker confirms, and adds `traceparent` to the headers.
  - `RabbitConsumer<T>` (extend it, inject `RabbitConnection`, name the queue; default prefetch 10): `onMessage(data, meta)` gets `messageId`, `routingKey` (the original, kept through retries and delay buckets in `x-original-routing-key`), string `headers` and `attempt`. A throw copies the message to the next retry queue (`x-attempt` + 1, default delays 5 s / 30 s / 5 min, 5 attempts) and acks the original; after the last attempt, or at once for `NonRetryableError` or non-JSON, the copy goes to `<queue>.dlq` with `x-dead-letter-reason`.
  - Delay bucket: publish to the fanout exchange (e.g. `delay.30m`) with the command's routing key; after the TTL the message reaches the bucket's `target` exchange with that key. Never publish to the bucket queue through the default exchange (that replaces the key).
  - amqplib is pinned to 2.2.1 (it bundles its own types).
- **`@jobber/pulsar`** (`libs/pulsar`) — `PulsarModule`, `PulsarClient` (producer/consumer management), abstract `PulsarConsumer<T>` base class with JSON serialization, a `send()` helper (key, properties, `sequenceId`), job message DTOs (`FibonacciMessage`, `LoadProductsMessage`), `PaymentSucceededMessage` (topic `payment-succeeded`: `{ paymentId, userId, amount, currency }`, amount as a minor-units string, keyed by `userId`), `BackfillCandlesMessage` (`{ coin, day }`, checked by shape only; `BACKFILL_FIRST_DAY`), `TradeExecutedMessage` (topic `trade-executed`: `{ tradeId, transactionId, userId, coin, side, qty, usdAmount, fee }`, written by the wallet when it settles a trade, from phase 4 step 2), and `validateMessage(cls, data)`, which throws `NonRetryableError` (dead-letter, no retry) for an invalid payload
  - Consumers take `ConsumerOptions`: subscription (default `jobber`, which job consumers keep), type (default `Shared`), redelivery delay (5 s) and max redeliveries (5) before Pulsar moves the message to `<topic>-<subscription>-DLQ`. Give each service that consumes the same topic its own subscription, or they split the messages instead of each getting all of them.
  - `onMessage(data, meta)` gets the message id, partition key, properties and redelivery count. Throwing `NonRetryableError` (or sending unparseable JSON) dead-letters the message at once; any other error nacks it for redelivery. Only a failed handler nacks, never a failed ack, so handlers must tolerate the occasional repeat.
  - Consumers run in the executor's single event loop, so CPU-heavy work stalls every other consumer: `FibonacciMessage` caps `iterations` at `MAX_FIBONACCI_ITERATIONS` (1,000) for that reason.

`products` uses Drizzle ORM (not Prisma) for its own PostgreSQL access — schema in `apps/products/src/app/products/schema.ts`, migrations managed via `nx run products:generate-drizzle` / `migrate-drizzle`.

### Authentication Flow

1. User logs in via `auth` GraphQL mutation → receives JWT in HttpOnly cookie
2. Client sends cookie with requests to `jobs`
3. `jobs` extracts JWT and calls `auth` gRPC `AuthService.Authenticate` to validate and retrieve the user
4. `GqlAuthGuard` attaches the resolved user to GraphQL context

### Infrastructure

- PostgreSQL for `auth` user storage (Prisma ORM)
- Apache Pulsar for async job message passing (both running in Docker)
- Jaeger for traces. Every backend app calls `startTracing(<service>)` from `@jobber/tracing` and
  exports to `OTEL_EXPORTER_OTLP_ENDPOINT` (set in each `apps/*/.env`; unset it, or set
  `OTEL_SDK_DISABLED=true`, to turn tracing off). One job shows as one trace: the `jobs` GraphQL
  request → outbox `<topic> publish` → executor `<topic> process` → `Acknowledge` gRPC back into
  `jobs`. A top-up is one trace too: `payments` webhook → `payment-succeeded publish` → wallet
  `payment-succeeded process` → `notifications publish` → executor `notifications.email process`
  → `GetUser` in auth (auth's gRPC server spans are recorded).
- Redis backs the wallet's idempotency fast path (`REDIS_URL`); the wallet keeps working without
  it; the market keeps prices, quotes and the simulator leader lock there (it needs Redis); the executor's email worker keeps `email:sent:<messageId>` there (7 days). Mailpit catches
  the emails (`SMTP_URL`, UI on 8025). RabbitMQ carries the `payments` commands and the emails.
- RabbitMQ names its data directory after the host name, so the compose service has a fixed
  `hostname: rabbitmq`; without it a recreated container starts empty.

### Git Hooks

Pre-commit runs `lint-staged`: TypeScript files get auto-fixed with ESLint, all files get formatted with Prettier.

## API Examples

All GraphQL queries use the embedded GraphiQL IDE in the browser. All `jobs` queries require
authentication — log in at the `auth` endpoint first so the JWT cookie is set.

### 1. Create a user

**Endpoint:** `http://localhost:3000/auth`

```graphql
mutation {
  createUser(createUserInput: {
    email: "test@example.com"
    password: "Test@1234"
  }) {
    id
    email
  }
}
```

Password must be strong (uppercase, lowercase, number, special character).

### 2. Login

**Endpoint:** `http://localhost:3000/auth`

```graphql
mutation {
  login(loginInput: {
    email: "test@example.com"
    password: "Test@1234"
  }) {
    id
    email
  }
}
```

Sets an HttpOnly JWT cookie (`Authentication`) used to authorize requests to the `jobs` service.

### 3. List available job types

**Endpoint:** `http://localhost:3001/jobs` (requires auth cookie)

```graphql
query {
  jobsMetadata {
    name
    description
  }
}
```

### 4. Execute the Fibonacci job

**Endpoint:** `http://localhost:3001/jobs` (requires auth cookie)

```graphql
mutation {
  executeJob(executeJobInput: {
    name: "Fibonacci"
    data: { iterations: 10 }
  }) {
    id
    name
    size
    status
  }
}
```

### 5. Execute the LoadProducts job (inline data)

**Endpoint:** `http://localhost:3001/jobs` (requires auth cookie)

```graphql
mutation {
  executeJob(executeJobInput: {
    name: "LoadProducts"
    data: [
      { name: "Widget", category: "Electronics", price: 29.99, stock: 100, rating: 4.5, description: "A cool widget" },
      { name: "Gadget", category: "Tools", price: 49.99, stock: 50, rating: 3.8, description: "A handy gadget" }
    ]
  }) {
    id
    name
    size
    status
  }
}
```

### 6. Execute the LoadProducts job (file upload)

Upload a JSON file first, then execute the job with the returned filename.

**Upload** (use `curl.exe` on Windows to avoid the PowerShell alias):

```bash
curl.exe -X POST http://localhost:3001/jobs/uploads/upload \
  -F "file=@products.json;type=application/json" \
  --cookie "Authentication=<your-jwt>"
```

Returns `{ "message": "Uploaded file: file-123456.json" }`.

Sample `products.json`:

```json
[
  { "name": "Widget", "category": "Electronics", "price": 29.99, "stock": 100, "rating": 4.5, "description": "A cool widget" },
  { "name": "Gadget", "category": "Tools", "price": 49.99, "stock": 50, "rating": 3.8, "description": "A handy gadget" }
]
```

### 7. List all jobs

**Endpoint:** `http://localhost:3001/jobs` (requires auth cookie)

```graphql
query {
  jobs {
    id
    name
    size
    completed
    status
    started
    ended
  }
}
```

### 8. Get a specific job by ID

**Endpoint:** `http://localhost:3001/jobs` (requires auth cookie)

```graphql
query {
  job(id: 1) {
    id
    name
    size
    completed
    status
    started
    ended
  }
}
```

### 9. Wallet: balances, history and transfer

**Endpoint:** `http://localhost:3004/wallet` (requires the auth cookie: log in at `auth` first)

Run `npx nx run wallet:seed` first to get `alice@example.com` and `bob@example.com` (password
`Test@1234`) with $100 each. Amounts are strings of minor units: `"1250"` is $12.50. `transfer`
needs an `Idempotency-Key` request header (any unique string per transfer, reused on retries); in
GraphiQL, add it under "Headers": `{ "Idempotency-Key": "my-first-transfer" }`.

```graphql
query {
  balances { asset available held }
  entries(first: 20) { items { id type asset amount createdAt } nextCursor }
}
```

```graphql
mutation {
  transfer(input: { toEmail: "bob@example.com", asset: "USD", amount: "1250" }) {
    transactionId
    amount
    asset
  }
}
```

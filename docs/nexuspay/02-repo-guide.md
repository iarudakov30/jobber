# Repo guide

The jobber repo is an Nx monorepo (Nx 24, TypeScript 6, NestJS 12, Node 24). NexusPay grows inside
it instead of in a new repo, so it can reuse jobber's services and libraries. `CLAUDE.md` at the
repo root is the terse, always-current reference; this guide explains the same things for a
person.

## Layout

```
apps/
  auth/        NestJS — users, login, JWT cookie; GraphQL + gRPC server (Authenticate, FindUserByEmail, GetUser)
  jobs/        NestJS — @Job framework; GraphQL; outbox → Pulsar; gRPC server (Acknowledge)
  executor/    NestJS — Pulsar consumers for job topics; email worker on RabbitMQ
               (notifications.email → Mailpit); gRPC clients to jobs, products, wallet, auth
  products/    NestJS — product persistence (Drizzle); gRPC server (CreateProduct)
  wallet/      NestJS — NexusPay double-entry ledger (Drizzle); GraphQL; gRPC server
               (Credit, GetBalances, RunAudit); credits payment-succeeded;
               outbox → Pulsar + RabbitMQ
  payments/    NestJS — Stripe Checkout top-ups (Drizzle); GraphQL; signed webhook;
               outbox → Pulsar + RabbitMQ; payment.expire consumer
  ui-admin/    Angular 22 — the jobber jobs console
  nexus/       React 19 + Vite — the NexusPay app (login, Wallet, Send, Top up); GraphQL Codegen
  nexus-e2e/   Playwright tests of nexus against the real auth + wallet
libs/
  graphql/     AbstractModel, GqlContext, GqlAuthGuard
  grpc/        .proto contracts (auth, jobs, products, wallet) + generated TypeScript types,
               Packages enum, GRPC_LOADER_OPTIONS, GrpcStatus
  nestjs/      init() bootstrap helper, Jobs enum
  prisma/      Prisma client used by auth
  pulsar/      PulsarClient, PulsarConsumer<T>, send(), validateMessage(), job message DTOs,
               PaymentSucceededMessage
  outbox/      Transactional outbox: PrismaOutboxStore, DrizzleOutboxStore, OutboxRelay,
               PulsarOutboxPublisher, RabbitOutboxPublisher
  money/       bigint minor units: ASSETS, parseAmount, formatAmount, toWire/fromWire
  idempotency/ @Idempotent() (Idempotency-Key): PostgreSQL store, Redis fast path, cleanup
  rabbitmq/    RabbitConnection (reconnect), RabbitPublisher (confirms), RabbitConsumer<T>
               (retry queues, DLQ), delay buckets, DLQ replay script,
               notifications topology + TopUpEmailMessage
  tracing/     startTracing() — OpenTelemetry bootstrap
charts/jobber  Helm chart (minikube / EKS)
docs/          These documents and other guides
```

Each app and lib keeps its **runtime dependencies in its own `package.json`** (npm workspaces).
The root `package.json` holds only shared framework packages and workspace tooling. Libraries are
built separately to `dist/libs/<name>` and loaded at runtime through `module-alias` (see
`_moduleAliases` in the root `package.json`). A new lib therefore needs three entries: a path in
`tsconfig.base.json`, an alias in `package.json`, and `COPY` lines in each Dockerfile that uses it.

## Services and ports

| Service  | HTTP                                                         | gRPC | Database               | Notes                                                                                                                                                                                                                                                   |
| -------- | ------------------------------------------------------------ | ---- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| auth     | 3000 (`/auth` GraphQL)                                       | 5000 | `jobber-auth` (Prisma) | Sets the HttpOnly `Authentication` cookie                                                                                                                                                                                                               |
| jobs     | 3001 (`/jobs` GraphQL)                                       | 5002 | `jobber` (Prisma)      | Tables `Job`, `JobItem`, `outbox`                                                                                                                                                                                                                       |
| executor | 3002                                                         | —    | —                      | Consumes job topics (subscription `jobber`); with `RABBITMQ_URL` set, also the email worker on `notifications.email` (SMTP to Mailpit, `GetUser` from auth, Redis dedupe)                                                                               |
| products | 3003                                                         | 5001 | `products` (Drizzle)   | `products.source_ref` is unique                                                                                                                                                                                                                         |
| wallet   | 3004 (`/wallet` GraphQL)                                     | 5003 | `wallet` (Drizzle)     | Ledger; triggers keep postings balanced and entries append-only; `outbox`, `idempotency_keys`; Redis for the idempotency fast path; consumes `payment-succeeded` (subscription `wallet`, Key_Shared) and queues `email.topup`; `npx nx run wallet:seed` |
| payments | 3005 (`/payments` GraphQL, `POST /payments/webhooks/stripe`) | —    | `payments` (Drizzle)   | `payments`, `stripe_events`, `recon_issues`, `outbox`, `idempotency_keys`; RabbitMQ `payments.commands` + delay buckets; Stripe keys in `apps/payments/.env.local` (gitignored)                                                                         |
| ui-admin | 4200                                                         | —    | —                      | Angular; proxies `/api/*` to 3000/3001                                                                                                                                                                                                                  |
| nexus    | 4300                                                         | —    | —                      | React; Vite proxies `/api/auth` to 3000, `/api/wallet` to 3004 and `/api/payments` to 3005                                                                                                                                                                                      |

| Infrastructure (docker compose)      | Port(s)          | UI                                     |
| ------------------------------------ | ---------------- | -------------------------------------- |
| PostgreSQL                           | 5432             | —                                      |
| Pulsar (standalone, broker dedup on) | 6650             | —                                      |
| RabbitMQ (`rabbitmq:4-management`)   | 5672             | http://localhost:15672 (guest / guest) |
| Redis                                | 6379             | —                                      |
| Mailpit                              | 1025 (SMTP)      | http://localhost:8025                  |
| Jaeger                               | 4318 (OTLP/HTTP) | http://localhost:16686                 |

## Running it

```bash
docker compose up -d                      # all infrastructure
# or, when memory is tight:
docker compose up -d postgres pulsar jaeger

npm start                                 # nx serve for every app (watch mode)
npx nx serve jobs                         # a single app
```

Migrations:

```bash
npx nx run auth:migrate-prisma            # auth (Prisma)
cd apps/jobs && npx prisma migrate dev    # jobs (Prisma): Job, JobItem, outbox
npx nx run products:migrate-drizzle       # products (Drizzle)
npx nx run wallet:migrate-drizzle         # wallet (Drizzle); creates the database first
npx nx run payments:migrate-drizzle       # payments (Drizzle); likewise
npx nx run wallet:seed                    # with auth + wallet running: alice@/bob@example.com, $100 each
```

**Low-memory alternative.** `npm start` runs a webpack watcher per app. On a machine with little
free RAM, build once and run the bundles with plain Node instead. `--env-file` is needed because
some code reads `DATABASE_URL` straight from the environment:

```bash
npx nx run-many -t build -p auth jobs executor products --parallel=2
node --env-file=apps/auth/.env     dist/apps/auth/main.js
node --env-file=apps/jobs/.env     dist/apps/jobs/main.js
node --env-file=apps/products/.env dist/apps/products/main.js
node --env-file=apps/executor/.env dist/apps/executor/main.js
```

Then log in and run a job (see the API examples in `CLAUDE.md`), or open
http://localhost:4300 for the React app.

## Testing

```bash
npx nx affected -t lint test build                 # what CI runs
npx nx run-many -t lint test build --parallel=2    # everything, gentler on memory
npx nx test pulsar                                 # one project (Jest)
npx nx test wallet                                 # real PostgreSQL via Testcontainers: needs Docker
npx nx test outbox                                 # also Testcontainers (DrizzleOutboxStore)
npx nx test money                                  # amount parsing and formatting
npx nx test idempotency                            # Testcontainers PostgreSQL + Redis
npx nx test rabbitmq                               # Testcontainers RabbitMQ: retries, DLQ, delays
npx nx test payments                               # Testcontainers PostgreSQL + RabbitMQ; Stripe faked
npx nx test executor                               # email worker: Testcontainers RabbitMQ, Redis, Mailpit
npx nx run rabbitmq:replay --queue=<name>          # move <name>.dlq back to <name>
npx nx run wallet:load-test overdraft              # k6 in Docker against running auth + wallet
                                                   # (also: deadlock, same-key)
npx nx test nexus -- src/lib/session.spec.ts       # one file (nexus uses Vitest)
npx nx run nexus-e2e:e2e                           # Playwright; needs auth + wallet running
npx nx run nexus:codegen                           # regenerate GraphQL types (CI checks them)
```

**Fault injection** (both ignored when `NODE_ENV=production`):

- `FAULT_ACK_FAILURES=3` on the executor: its first 3 job messages fail right after doing their
  work, so Pulsar redelivers them. Proves a job still completes exactly once.
- `FAULT_CRASH_AFTER_CREDIT=1` on the wallet: the process exits right after a top-up credit
  commits and before the Pulsar ack. Restart without it: the redelivery is recognised
  ("already credited"), and there is still one credit and one email.

**A real top-up with the Stripe CLI** (spec acceptance tests 2 and 3; `stripe login` once):

1. Put the output of `stripe listen --print-secret` into `apps/payments/.env.local` as
   `STRIPE_WEBHOOK_SECRET`.
2. `stripe listen --events "checkout.session.completed,checkout.session.expired" --forward-to localhost:3005/payments/webhooks/stripe`
   (CLI 1.55 refuses to start without `--events`; in PowerShell keep the list quoted).
3. `docker compose up -d`, then serve `auth`, `wallet`, `payments`, `executor` and `nexus`.
4. In http://localhost:4300: Top up → $50 → pay with card 4242 4242 4242 4242, any future date,
   any CVC. Back on the Wallet page the notice goes from "Waiting for Stripe" to "$50.00 added".
5. `stripe events resend <evt_id>` (the id is in the `stripe listen` output) any number of
   times: still one credit and one email.

**Live check of a top-up without the Stripe CLI.** Start `payments` with any
`STRIPE_WEBHOOK_SECRET` (for example `whsec_local`). Then sign a `checkout.session.completed`
event for a real `createTopUp` with `stripe.webhooks.generateTestHeaderString` and POST it to
`/payments/webhooks/stripe`. Everything after Stripe (credit, email, trace) runs for real.

## Observing the system

- **Traces:** open Jaeger at http://localhost:16686 and pick service `jobs` or `executor`. One job
  is one trace: GraphQL request → outbox `<topic> publish` → executor `<topic> process` →
  `Acknowledge` gRPC back into `jobs`. A top-up is one trace too: `payments` webhook →
  `payment-succeeded publish` → wallet `payment-succeeded process` → `notifications publish`
  → executor `notifications.email process` → `GetUser` in auth. Set `OTEL_SDK_DISABLED=true`
  (or remove `OTEL_EXPORTER_OTLP_ENDPOINT` from an app's `.env`) to turn tracing off.
- **Outbox:** `select id, transport, destination, published_at from outbox order by id desc limit 10;`
  in the service's database (`jobber`, `wallet`, `payments`). Rows with `published_at IS NULL`
  are waiting for the relay. Each transport is its own ordered stream, so RabbitMQ rows waiting
  for a broker that is down don't hold back the Pulsar rows.
- **RabbitMQ:** the UI at http://localhost:15672 (guest / guest), or
  `docker exec jobber-rabbitmq-1 rabbitmqctl list_queues name messages`. A non-empty
  `<queue>.dlq` needs a look, then `npx nx run rabbitmq:replay --queue=<queue>`.
- **Emails:** Mailpit at http://localhost:8025.
- **Pulsar:**

  ```bash
  P="docker exec jobber-pulsar-1"
  $P bin/pulsar-admin topics stats persistent://public/default/Fibonacci          # backlog, consumers
  $P bin/pulsar-admin topics peek-messages -s jobber -n 2 persistent://public/default/Fibonacci
  $P bin/pulsar-admin topics stats persistent://public/default/Fibonacci-jobber-DLQ  # dead letters
  $P bin/pulsar-admin topics skip -n 1 -s jobber persistent://public/default/Fibonacci  # drop one message
  ```

## Gotchas (learned the hard way)

| Symptom                                                                                                                                                  | Cause and fix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm install` fails with `ERESOLVE` (`webpack-merge`, `eslint-plugin-import`)                                                                            | The repo installs with `npm install --legacy-peer-deps`. That skips peer dependencies, so add any peer a new plugin needs (e.g. `vite`) explicitly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| An Nx build "succeeds" but `dist/` is stale                                                                                                              | A missing peer (e.g. `webpack`) makes the build a silent no-op. Check for `webpack compiled successfully` or that `dist/` changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `npx nx run grpc:generate-ts-proto` fails with exit code `0xC0000135`                                                                                    | grpc-tools' `protoc.exe` can't load a DLL on this Windows machine. Generate in a Linux container instead (mount at `/work`, **not** `/lib`, which would hide the container's system libraries):<br>`docker run --rm --entrypoint /bin/sh -v "<repo>/libs/grpc/src/lib:/work" -w /work node:24-slim -c 'npm i -g ts-proto@2.11.4 grpc-tools@1.13.1 && grpc_tools_node_protoc --plugin=$(npm root -g)/ts-proto/protoc-gen-ts_proto --ts_proto_out=./types ./proto/*.proto --ts_proto_opt=nestJs=true --ts_proto_opt=exportCommonSymbols=false --ts_proto_opt=forceLong=string'`<br>then `npx prettier --write libs/grpc/src/lib/types`. Run it from PowerShell: Git Bash rewrites `-w /work` into `C:/Program Files/Git/work` (or prefix the command with `MSYS_NO_PATHCONV=1`). |
| `Failed to bind to address …:5000` (or another app port): `address already in use`                                                                       | An old service is still running, often a built one started with `node dist/apps/<app>/main.js`, which outlives the terminal. `npm stop` kills the **Node** processes on 3000–3004, 5000–5003, 4200 and 4300 and leaves anything else alone. Port 5000 (auth gRPC) also clashes with other local apps such as .NET services: run only one of them at a time.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `npm stop` printed "Ports cleared" but nothing stopped                                                                                                   | The old script used `fuser`, which doesn't exist on Windows, and hid the error. It is now `scripts/stop.mjs` (`netstat` on Windows, `lsof` elsewhere).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| After switching branches or merging, `nx` fails with `Cannot find module '@nx/vite/plugin'`                                                              | `node_modules` still matches the other branch's lock. Run `npm install --legacy-peer-deps`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Tests or the machine die with "out of memory"                                                                                                            | Too many dev servers plus parallel test workers. Stop servers (`npm stop`), use `--parallel=2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `nexus` lint crashes in `eslint-plugin-react` (`getFilename is not a function`)                                                                          | eslint-plugin-react 7 vs ESLint 10. `apps/nexus/eslint.config.mjs` pins `settings.react.version` to avoid the crashing code path.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| A job sits `IN_PROGRESS` and the executor's HTTP port stops answering                                                                                    | A CPU-heavy message is blocking the executor's single event loop (it happened with a 1,000,000-iteration Fibonacci job). Iterations are now capped at 1,000.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `pulsar-client produce -m '{"a":1,"b":2}'` sends two broken messages                                                                                     | The CLI splits `-m` on commas; pass `--separator '#'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `jobs` or `executor` tests fail with `TS2737: BigInt literals are not available` (or `TS2554` on `new Error(msg, { cause })`) after a shared lib changed | A shared library imported code that needs a newer target or lib (`@jobber/money`, the `cause` option), and every project that imports the library compiles it with its own settings. Keep shared libs to ES2021 features (set `cause` with `Object.assign`); run `npx nx affected -t test`, not just the lib's tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| A Vitest test fails with an error from a mock after the test finished                                                                                    | `beforeEach(() => mock.mockReset())` returns the mock, and Vitest treats a returned function as teardown and calls it. Use a braced body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `prettier --write CLAUDE.md` reformats the GraphQL examples                                                                                              | Run Prettier only on files you changed; the pre-commit hook already formats staged files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Environment variables added by NexusPay

| Variable                      | Where                       | Purpose                                                                                                  |
| ----------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | every backend `apps/*/.env` | Where traces go (Jaeger, `http://localhost:4318`); unset = tracing off                                   |
| `OTEL_SDK_DISABLED`           | optional                    | `true` turns tracing off                                                                                 |
| `FAULT_ACK_FAILURES`          | executor, tests only        | Fail the first n messages after `execute`                                                                |
| `RABBITMQ_URL`                | payments, wallet, executor  | `amqp://localhost:5672`; without it the executor starts without the email worker                         |
| `STRIPE_SECRET_KEY`           | `apps/payments/.env.local`  | Stripe test-mode secret key (`sk_test_…`); never in a committed file                                     |
| `STRIPE_WEBHOOK_SECRET`       | `apps/payments/.env.local`  | `whsec_…` from `stripe listen --print-secret`; stays the same for one `stripe login`, restart payments after a change |
| `APP_URL`                     | payments                    | Where Checkout returns the browser (`http://localhost:4300`)                                             |
| `PAYMENT_EXPIRY_BUCKET`       | payments                    | `delay.30m` (default) or `delay.1m` to watch an unpaid top-up expire after a minute                      |
| `REDIS_URL`                   | wallet, payments, executor  | Idempotency fast path; the email worker's sent marks                                                     |
| `SMTP_URL`                    | executor                    | `smtp://localhost:1025` (Mailpit)                                                                        |
| `EMAIL_FROM`                  | executor                    | Sender of NexusPay emails                                                                                |
| `FAULT_CRASH_AFTER_CREDIT`    | wallet, tests only          | `1`: exit after a top-up credit commits, before the ack                                                  |

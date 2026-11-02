# Repo guide

The jobber repo is an Nx monorepo (Nx 24, TypeScript 6, NestJS 12, Node 24). NexusPay grows inside
it instead of in a new repo, so it can reuse jobber's services and libraries. `CLAUDE.md` at the
repo root is the terse, always-current reference; this guide explains the same things for a
person.

## Layout

```
apps/
  auth/        NestJS — users, login, JWT cookie; GraphQL + gRPC server (Authenticate)
  jobs/        NestJS — @Job framework; GraphQL; outbox → Pulsar; gRPC server (Acknowledge)
  executor/    NestJS — Pulsar consumers for job topics; gRPC clients to jobs and products
  products/    NestJS — product persistence (Drizzle); gRPC server (CreateProduct)
  ui/          Angular 22 — the jobber jobs console
  nexus/       React 19 + Vite — the NexusPay app (on feature/nexus-react-app for now)
libs/
  graphql/     AbstractModel, GqlContext, GqlAuthGuard
  grpc/        .proto contracts + generated TypeScript types, Packages enum
  nestjs/      init() bootstrap helper, Jobs enum
  prisma/      Prisma client used by auth
  pulsar/      PulsarClient, PulsarConsumer<T>, send(), job message DTOs
  outbox/      Transactional outbox: PrismaOutboxStore, OutboxRelay, PulsarOutboxPublisher
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

| Service | HTTP | gRPC | Database | Notes |
| ------- | ---- | ---- | -------- | ----- |
| auth | 3000 (`/auth` GraphQL) | 5000 | `jobber-auth` (Prisma) | Sets the HttpOnly `Authentication` cookie |
| jobs | 3001 (`/jobs` GraphQL) | 5002 | `jobber` (Prisma) | Tables `Job`, `JobItem`, `outbox` |
| executor | 3002 | — | — | Consumes job topics, subscription `jobber` |
| products | 3003 | 5001 | `products` (Drizzle) | `products.source_ref` is unique |
| ui | 4200 | — | — | Angular; proxies `/api/*` to 3000/3001 |
| nexus | 4300 | — | — | React; Vite proxies `/api/auth` to 3000 |

| Infrastructure (docker compose) | Port(s) | UI |
| ------------------------------- | ------- | -- |
| PostgreSQL | 5432 | — |
| Pulsar (standalone, broker dedup on) | 6650 | — |
| Redis | 6379 | — |
| Mailpit | 1025 (SMTP) | http://localhost:8025 |
| Jaeger | 4318 (OTLP/HTTP) | http://localhost:16686 |

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
npx nx test nexus -- src/lib/session.spec.ts       # one file (nexus uses Vitest)
```

**Fault injection.** Start the executor with `FAULT_ACK_FAILURES=3` and its first 3 messages fail
right after doing their work, so Pulsar redelivers them. Use it to prove a job still completes
exactly once. The variable is ignored when `NODE_ENV=production`.

## Observing the system

- **Traces:** open Jaeger at http://localhost:16686 and pick service `jobs` or `executor`. One job
  is one trace: GraphQL request → outbox `<topic> publish` → executor `<topic> process` →
  `Acknowledge` gRPC back into `jobs`. Set `OTEL_SDK_DISABLED=true` (or remove
  `OTEL_EXPORTER_OTLP_ENDPOINT` from an app's `.env`) to turn tracing off.
- **Outbox:** `select id, destination, published_at from outbox order by id desc limit 10;` in the
  `jobber` database. Rows with `published_at IS NULL` are waiting for the relay.
- **Pulsar:**

  ```bash
  P="docker exec jobber-pulsar-1"
  $P bin/pulsar-admin topics stats persistent://public/default/Fibonacci          # backlog, consumers
  $P bin/pulsar-admin topics peek-messages -s jobber -n 2 persistent://public/default/Fibonacci
  $P bin/pulsar-admin topics stats persistent://public/default/Fibonacci-jobber-DLQ  # dead letters
  $P bin/pulsar-admin topics skip -n 1 -s jobber persistent://public/default/Fibonacci  # drop one message
  ```

## Gotchas (learned the hard way)

| Symptom | Cause and fix |
| ------- | ------------- |
| `npm install` fails with `ERESOLVE` (`webpack-merge`, `eslint-plugin-import`) | The repo installs with `npm install --legacy-peer-deps`. That skips peer dependencies, so add any peer a new plugin needs (e.g. `vite`) explicitly. |
| An Nx build "succeeds" but `dist/` is stale | A missing peer (e.g. `webpack`) makes the build a silent no-op. Check for `webpack compiled successfully` or that `dist/` changed. |
| `npx nx run grpc:generate-ts-proto` fails with exit code `0xC0000135` | grpc-tools' `protoc.exe` can't load a DLL on this Windows machine. Generate in a Linux container instead (mount at `/work`, **not** `/lib`, which would hide the container's system libraries):<br>`docker run --rm --entrypoint /bin/sh -v "<repo>/libs/grpc/src/lib:/work" -w /work node:24-slim -c 'npm i -g ts-proto@2.11.4 grpc-tools@1.13.1 && grpc_tools_node_protoc --plugin=$(npm root -g)/ts-proto/protoc-gen-ts_proto --ts_proto_out=./types ./proto/*.proto --ts_proto_opt=nestJs=true --ts_proto_opt=exportCommonSymbols=false'`<br>then `npx prettier --write libs/grpc/src/lib/types`. |
| Tests or the machine die with "out of memory" | Too many dev servers plus parallel test workers. Stop servers (`npm stop`), use `--parallel=2`. |
| `nexus` lint crashes in `eslint-plugin-react` (`getFilename is not a function`) | eslint-plugin-react 7 vs ESLint 10. `apps/nexus/eslint.config.mjs` pins `settings.react.version` to avoid the crashing code path. |
| A job sits `IN_PROGRESS` and the executor's HTTP port stops answering | A CPU-heavy message is blocking the executor's single event loop (it happened with a 1,000,000-iteration Fibonacci job). Iterations are now capped at 1,000. |
| `pulsar-client produce -m '{"a":1,"b":2}'` sends two broken messages | The CLI splits `-m` on commas; pass `--separator '#'`. |
| A Vitest test fails with an error from a mock after the test finished | `beforeEach(() => mock.mockReset())` returns the mock, and Vitest treats a returned function as teardown and calls it. Use a braced body. |
| `prettier --write CLAUDE.md` reformats the GraphQL examples | Run Prettier only on files you changed; the pre-commit hook already formats staged files. |

## Environment variables added by NexusPay

| Variable | Where | Purpose |
| -------- | ----- | ------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | every backend `apps/*/.env` | Where traces go (Jaeger, `http://localhost:4318`); unset = tracing off |
| `OTEL_SDK_DISABLED` | optional | `true` turns tracing off |
| `FAULT_ACK_FAILURES` | executor, tests only | Fail the first n messages after `execute` |

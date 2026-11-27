# Jobber

## Purpose

**Jobber** is a microservices-based application for **user authentication, background job management, and product data processing**. It's built as a distributed system using an **Nx monorepo** with independent backend services communicating over GraphQL, gRPC, Apache Pulsar and RabbitMQ, plus an **Angular web UI** for signing in and running jobs.

The same repo hosts **NexusPay**, a wallet and payments learning project: a double-entry ledger (`wallet`), Stripe top-ups (`payments`), a paper-trading coin market with simulated coins and four real ones priced from public exchange data (`market`), a WebSocket gateway (`realtime`) and a **React app** (`nexus`). It is documented in [docs/nexuspay](docs/nexuspay/README.md).

---

## Core Features

| Service      | Feature                                                       |
| ------------ | ------------------------------------------------------------- |
| **auth**     | User registration & login via GraphQL                         |
| **auth**     | JWT token generation stored in HttpOnly cookies               |
| **auth**     | Protected queries with guards and `@CurrentUser` decorator    |
| **auth**     | Password hashing with bcryptjs                                |
| **auth**     | gRPC server exposing `Authenticate` for internal token checks |
| **jobs**     | Extensible job framework with abstract base class             |
| **jobs**     | `@Job()` decorator for metadata (name, description)           |
| **jobs**     | Publishes job messages to Pulsar (Fibonacci, LoadProducts)    |
| **jobs**     | Validates incoming requests via gRPC call to `auth`           |
| **executor** | Pulsar consumers that process published job messages          |
| **executor** | Calls `products` over gRPC to persist enriched product data   |
| **products** | gRPC service for product creation                             |
| **products** | Drizzle ORM + PostgreSQL persistence                          |
| **ui-admin** | Register / sign in against `auth` (HttpOnly cookie session)   |
| **ui-admin** | Run jobs with a JSON payload, prefilled per job type          |
| **ui-admin** | Live job list and job detail pages with progress polling      |

---

## Tech Stack

### Core

- **Runtime**: Node.js + TypeScript
- **Framework**: NestJS v12
- **Monorepo**: Nx v24

### Frontend

- **Angular** v22 — zoneless, standalone components, lazy routes
- **Apollo Client** v4 via `apollo-angular` — GraphQL client for `auth` and `jobs`
- Signal forms, resource API (`rxResource`), signal inputs, `linkedSignal`
- **Vitest** for unit tests (`@angular/build:unit-test`)

### API Layer

- **GraphQL** (v16) + Apollo Server (v5) — code-first schema generation, used by `auth` and `jobs`
- **gRPC** (`@nestjs/microservices`) — internal service-to-service calls (`auth` ↔ `jobs`, `executor` ↔ `products`)
- **Swagger/OpenAPI** — auto-generated REST docs

### Messaging

- **Apache Pulsar** — async job queue; `jobs` publishes, `executor` consumes

### Database

- **PostgreSQL** (Docker Compose for local dev)
- **Prisma** v7 — ORM for `auth` (type-safe client + `@prisma/adapter-pg`)
- **Drizzle ORM** — ORM for `products`

### Auth & Security

- `@nestjs/jwt` + `passport-jwt` — JWT strategy
- `bcryptjs` — password hashing
- `cookie-parser` — HttpOnly cookie transport

### Validation

- `class-validator` + `class-transformer`

### Dev Tooling

- Jest v30, Husky, lint-staged, ESLint, Prettier, Compodoc

---

## Architecture

```
apps/
├── auth/       ← GraphQL auth service (users, JWT, Prisma) + gRPC server        (port 3000, gRPC 5000)
├── jobs/       ← Job registration, GraphQL API, outbox to Pulsar, gRPC server   (port 3001, gRPC 5002)
├── executor/   ← Pulsar consumers that run jobs; NexusPay email worker         (port 3002)
├── products/   ← gRPC service, Drizzle ORM, PostgreSQL persistence             (port 3003, gRPC 5001)
├── wallet/     ← NexusPay ledger: balances, transfers, holds, trades           (port 3004, gRPC 5003)
├── payments/   ← NexusPay Stripe Checkout top-ups and webhooks                 (port 3005)
├── market/     ← NexusPay prices (simulated + exchanges), candles, orders      (port 3006, gRPC 5004)
├── realtime/   ← NexusPay WebSocket gateway: live prices, balances, fills     (port 3007)
├── ui-admin/   ← Angular web UI, Apollo Client against auth + jobs              (port 4200)
├── nexus/      ← React app for NexusPay (Vite)                                 (port 4300)
└── nexus-e2e/  ← Playwright tests of the React app against the real backends
libs/
├── graphql/    ← Shared: AbstractModel, GqlContext, GqlAuthGuard
├── nestjs/     ← Shared: init() bootstrap helper, Jobs enum
├── grpc/       ← gRPC proto files + generated TypeScript types
├── prisma/     ← Prisma client (used by auth)
├── pulsar/     ← PulsarModule, PulsarClient, PulsarConsumer base class, messages
├── rabbitmq/   ← RabbitMQ connection, publisher, consumers with retries and DLQ
├── outbox/     ← Transactional outbox and its relay (Pulsar, RabbitMQ)
├── idempotency/← @Idempotent() for GraphQL and HTTP handlers
├── money/      ← Amounts as bigint minor units (USD and the market's coins)
└── tracing/    ← OpenTelemetry setup (traces to Jaeger)
```

Each service is independently buildable and deployable. Shared libraries provide common contracts (GraphQL base types, gRPC stubs, Pulsar messaging) so services stay decoupled.

---

## Run it locally

```sh
docker compose up -d   # PostgreSQL, Pulsar, RabbitMQ, Redis, Mailpit, Jaeger
npm start              # every app in watch mode: the backends and both UIs
```

On a fresh database, run the migrations once first: `npx nx run auth:migrate-prisma`,
`npx nx run jobs:migrate-prisma`, `npx nx run products:migrate-drizzle`,
`npx nx run wallet:migrate-drizzle`, `npx nx run payments:migrate-drizzle` and
`npx nx run market:migrate-drizzle`. With `auth` and `wallet` running, `npx nx run wallet:seed`
creates `alice@example.com` and `bob@example.com` (password `Test@1234`) with $100 each.

| What                                               | URL                                                                                |
| -------------------------------------------------- | ---------------------------------------------------------------------------------- |
| NexusPay (React)                                   | http://localhost:4300                                                              |
| ui-admin (Angular)                                 | http://localhost:4200                                                              |
| GraphiQL: auth / jobs / wallet / payments / market | http://localhost:3000/auth, :3001/jobs, :3004/wallet, :3005/payments, :3006/market |
| Realtime gateway stats                             | http://localhost:3007/realtime/stats                                               |
| RabbitMQ UI                                        | http://localhost:15672 (guest / guest)                                             |
| Mailpit                                            | http://localhost:8025                                                              |
| Jaeger                                             | http://localhost:16686                                                             |

Stop everything with `npm stop` and `docker compose down`. More (single apps, tests, low-memory
runs, gotchas) in [docs/nexuspay/02-repo-guide.md](docs/nexuspay/02-repo-guide.md).

---

## Authentication Flow

```
User → GraphQL Login Mutation → AuthResolver → AuthService
→ UsersService → PrismaService → PostgreSQL
→ JWT Generation → Cookie Response → Client
```

**Protected query access:**

```
Authenticated User → GraphQL Query with Cookie
→ GqlAuthGuard → JwtStrategy → CurrentUser Decorator
→ Resolver → Service → Database
```

`jobs` also validates every incoming request by calling `auth`'s gRPC `Authenticate` method directly, independent of the GraphQL guard flow above.

---

## Job Processing Flow

```
Client → jobs (GraphQL mutation) → JobsService discovers @Job() class
→ Job publishes message to Pulsar topic
→ executor (PulsarConsumer subscribed to topic) → onMessage()
→ (LoadProducts) → gRPC call to products → Drizzle insert → PostgreSQL
```

- Decorate a class with `@Job()` to register a new job type; `JobsService` auto-discovers all `@Job()` classes via `@golevelup/nestjs-discovery`.
- Each job publishes to a Pulsar topic named after the job type.
- `executor` defines a matching `PulsarConsumer<T>` subclass per topic.
- The `LoadProducts` job/consumer pair additionally calls the `products` gRPC service to persist enriched product data.
- Job data is validated before the job is created, so a rejected payload never leaves a job stuck in progress.

---

## Web UI

The `ui-admin` app is an Angular 22 frontend for the `auth` and `jobs` GraphQL APIs.

| Route       | Page                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `/register` | Create an account (then signs you in)                                 |
| `/login`    | Sign in; the `auth` service sets the HttpOnly `Authentication` cookie |
| `/jobs`     | Run a job and watch the job list update live (signed-in only)         |
| `/jobs/:id` | Progress, start and end time of a single job (signed-in only)         |

### Run it

```sh
docker compose up -d   # all infrastructure (see "Run it locally")
npm start              # every app, this UI included
```

On a fresh database, run the migrations once before `npm start` (the full list is under "Run it locally").

Then open <http://localhost:4200>, create an account and run a **Fibonacci** or **LoadProducts** job.

### How it talks to the backend

- During `nx serve ui-admin`, the dev server proxies `/api/auth` → `localhost:3000/auth` and `/api/jobs` → `localhost:3001/jobs` (`apps/ui-admin/proxy.conf.json`). The browser sees a single origin, so the HttpOnly cookie works without CORS. The `/api` prefix keeps the proxy from capturing the UI's own `/jobs` routes on a page refresh.
- Two Apollo clients are configured in `apps/ui-admin/src/app/graphql.provider.ts`: the default one for `jobs` and a named `auth` client.
- The cookie can't be read from JavaScript, so the UI remembers the signed-in user locally. If `jobs` answers `FORBIDDEN` (expired or missing cookie), the session is cleared and you are sent back to the login page.
- Server validation messages (e.g. "password is not strong enough") are shown under the field they refer to.

### Commands

```sh
npx nx serve ui-admin    # dev server on http://localhost:4200 (needs the backend running)
npx nx build ui-admin    # production build to dist/apps/ui-admin
npx nx test ui-admin     # unit tests (Vitest)
npx nx lint ui-admin
```

The UI isn't containerized or part of the Helm chart yet.

---

## Key Modules

### auth

- **AuthModule** — JWT config, guards, strategies
- **AuthService** — login, password verification, token generation
- **AuthResolver** — GraphQL `login` mutation
- **UsersService** — create/find users with hashed passwords
- **PrismaService** — PostgreSQL abstraction layer
- **JwtStrategy** — Passport strategy reading JWT from cookies
- **GqlAuthGuard** — GraphQL-specific authorization guard
- **AuthController** — gRPC `Authenticate` endpoint for internal calls

### jobs

- **AbstractJob** — base class for all job implementations
- **@Job() decorator** — attaches name/description metadata to job classes
- **JobsService** — discovers `@Job()` classes and manages publishing
- **FibonacciJob**, **LoadProductsJob** — job implementations

### executor

- **FibonacciConsumer**, **LoadProductsConsumer** — `PulsarConsumer<T>` subclasses processing messages per job topic
- **LoadProductsConsumer** also acts as a gRPC client to `products`

### products

- **ProductsController** — gRPC `createProduct` endpoint
- **ProductsService** — Drizzle-based persistence
- **schema.ts** — Drizzle table definitions

### Shared libraries

- **`@jobber/graphql`** — `AbstractModel`, `GqlContext`, `GqlAuthGuard`
- **`@jobber/nestjs`** — `init()` bootstrap helper used by all apps, `Jobs` enum
- **`@jobber/grpc`** — gRPC proto files and generated TypeScript types (`auth`, `products`)
- **`@jobber/prisma`** — Prisma client
- **`@jobber/pulsar`** — `PulsarModule`, `PulsarClient`, abstract `PulsarConsumer<T>` base class, job message DTOs

---

## Summary

A **NestJS microservices backend** demonstrating GraphQL-first APIs, JWT cookie authentication, gRPC for internal service calls, and Apache Pulsar for async job processing — spanning four independently deployable services (`auth`, `jobs`, `executor`, `products`) in an Nx monorepo, with an **Angular** web UI (`ui-admin`) on top.

[Learn more about this workspace setup and its capabilities](https://nx.dev/nx-api/nest?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) or run `npx nx graph` to visually explore what was created. Now, let's get you up to speed!

## Finish your CI setup

[Click here to finish setting up your workspace!](https://cloud.nx.app/connect/Q9ciqng6Ie)

## Infrastructure

Start PostgreSQL, Pulsar, RabbitMQ, Redis, Mailpit and Jaeger:

```sh
docker compose up -d
```

Stop them:

```sh
docker compose down
```

---

## Run tasks

### Serve

```sh
npx nx serve auth                 # Serve a single app (auth, jobs, executor, products, wallet, payments, market, realtime, ui-admin, nexus)
npx nx run-many -t serve          # Serve all apps in parallel

--skip-nx-cache                   # Run without cache
```

### Build

```sh
npx nx build auth          # Build auth app
npx nx run-many -t build          # Build all apps
```

### Test & Lint

```sh
npx nx test auth           # Test auth app
npx nx run-many -t test           # Test all apps
npx nx lint auth           # Lint auth app
```

To see all available targets for a project, run:

```sh
npx nx show project auth
```

These targets are either [inferred automatically](https://nx.dev/concepts/inferred-tasks?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) or defined in the `project.json` or `package.json` files.

[More about running tasks in the docs &raquo;](https://nx.dev/features/run-tasks?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)

## Add new projects

While you could add new projects to your workspace manually, you might want to leverage [Nx plugins](https://nx.dev/concepts/nx-plugins?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) and their [code generation](https://nx.dev/features/generate-code?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) feature.

Use the plugin's generator to create new projects.

To generate a new application, use:

```sh
npx nx g @nx/nest:app demo
```

To generate a new library, use:

```sh
npx nx g @nx/node:lib mylib
```

You can use `npx nx list` to get a list of installed plugins. Then, run `npx nx list <plugin-name>` to learn about more specific capabilities of a particular plugin. Alternatively, [install Nx Console](https://nx.dev/getting-started/editor-setup?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) to browse plugins and generators in your IDE.

[Learn more about Nx plugins &raquo;](https://nx.dev/concepts/nx-plugins?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) | [Browse the plugin registry &raquo;](https://nx.dev/plugin-registry?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects)

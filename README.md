# Jobber

## Purpose

**Jobber** is a microservices-based backend application for **user authentication, background job management, and product data processing**. It's built as a distributed system using an **Nx monorepo** with four independent services communicating over GraphQL, gRPC, and Apache Pulsar.

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

---

## Tech Stack

### Core

- **Runtime**: Node.js + TypeScript
- **Framework**: NestJS v11
- **Monorepo**: Nx v22

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
├── auth/       ← GraphQL auth service (users, JWT, Prisma) + gRPC server        (port 3000)
├── jobs/       ← Job registration, GraphQL API, Pulsar producer, gRPC client    (port 3001)
├── executor/   ← Pulsar consumer, executes jobs, gRPC client to products       (port 3002)
├── products/   ← gRPC service, Drizzle ORM, PostgreSQL persistence             (port 3003)
├── auth-e2e/
└── jobs-e2e/
libs/
├── graphql/    ← Shared: AbstractModel, GqlContext, GqlAuthGuard
├── nestjs/     ← Shared: init() bootstrap helper, Jobs enum
├── grpc/       ← gRPC proto files + generated TypeScript types (auth, products)
├── prisma/     ← Prisma client (used by auth)
└── pulsar/     ← PulsarModule, PulsarClient, PulsarConsumer base class, job messages
```

Each service is independently buildable and deployable. Shared libraries provide common contracts (GraphQL base types, gRPC stubs, Pulsar messaging) so services stay decoupled.

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

A **NestJS microservices backend** demonstrating GraphQL-first APIs, JWT cookie authentication, gRPC for internal service calls, and Apache Pulsar for async job processing — spanning four independently deployable services (`auth`, `jobs`, `executor`, `products`) in an Nx monorepo.

[Learn more about this workspace setup and its capabilities](https://nx.dev/nx-api/nest?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) or run `npx nx graph` to visually explore what was created. Now, let's get you up to speed!

## Finish your CI setup

[Click here to finish setting up your workspace!](https://cloud.nx.app/connect/Q9ciqng6Ie)

## Infrastructure

Start PostgreSQL and Apache Pulsar:

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
npx nx serve auth                 # Serve a single app (auth, jobs, executor, products)
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

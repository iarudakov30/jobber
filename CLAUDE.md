# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Start all services

```bash
npm start                          # serves auth, jobs-lib, executor concurrently
```

### Individual app commands

```bash
npx nx serve <app>                 # serve with watch mode
npx nx build <app>                 # build
npx nx test <app>                  # run tests
npx nx lint <app>                  # lint
```

Apps: `auth`, `jobs`, `executor`

### Run a single test file

```bash
npx nx test auth --testFile=apps/auth/src/app/auth/auth.service.spec.ts
```

### Run all affected tasks (CI pattern)

```bash
npx nx affected -t lint test build
```

### Infrastructure

```bash
docker compose up -d               # start PostgreSQL + Apache Pulsar
docker compose down
```

### Database

```bash
npx nx run auth:migrate-db  # run Prisma migrations
npx nx run auth:generate    # regenerate Prisma client
```

### Proto generation

```bash
npm run generate-ts-proto          # regenerate TypeScript from proto/auth.proto
```

### Utilities

```bash
npm stop                           # kill services on ports 3000, 3001, 3002
npm run cache-clean                # reset Nx cache and npm cache
```

## Architecture

Nx monorepo with three NestJS microservices and two shared libraries.

### Services

| Service    | Port | Role                                                     |
| ---------- | ---- | -------------------------------------------------------- |
| `auth`     | 3000 | User auth (GraphQL + PostgreSQL/Prisma + gRPC server)    |
| `jobs`     | 3001 | Job management (GraphQL + Pulsar producer + gRPC client) |
| `executor` | 3002 | Job execution (Pulsar consumer)                          |

### Communication Patterns

1. **GraphQL (external)** — clients talk to `auth` and `jobs` via Apollo GraphQL APIs
2. **gRPC (internal)** — `jobs` calls `auth` to validate JWT tokens on every incoming request; contract in `proto/auth.proto`
3. **Apache Pulsar (async)** — `jobs` publishes job messages to Pulsar topics; `executor` subscribes and processes them

### Job Framework

`jobs` has an extensible job system:

- Decorate a class with `@Job()` to register a new job type
- `JobsService` uses `@golevelup/nestjs-discovery` to auto-discover all `@Job()` decorated classes
- The discovered job class receives the job payload and publishes it to a Pulsar topic named after the job type
- `executor` defines a corresponding `PulsarConsumer<T>` subclass that processes messages from that topic

See `apps/jobs/src/app/jobs/fibonacci/fibonacci.job.ts` and `apps/executor/src/app/jobs/fibonacci/fibonacci.consumer.ts` for the reference implementation.

### Shared Libraries

- **`@jobber/nestjs`** (`libs/nestjs`) — `AbstractModel` (GraphQL base type), `GqlContext`, `GqlAuthGuard`, and the `init()` bootstrap helper used by all three apps
- **`@jobber/pulsar`** (`libs/pulsar`) — `PulsarModule`, `PulsarClient` (producer/consumer management), and abstract `PulsarConsumer<T>` base class with JSON serialization

### Authentication Flow

1. User logs in via `auth` GraphQL mutation → receives JWT in HttpOnly cookie
2. Client sends cookie with requests to `jobs`
3. `jobs` extracts JWT and calls `auth` gRPC `AuthService.Authenticate` to validate and retrieve the user
4. `GqlAuthGuard` attaches the resolved user to GraphQL context

### Infrastructure

- PostgreSQL for `auth` user storage (Prisma ORM)
- Apache Pulsar for async job message passing (both running in Docker)

### Git Hooks

Pre-commit runs `lint-staged`: TypeScript files get auto-fixed with ESLint, all files get formatted with Prettier.

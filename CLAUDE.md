# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Start all services

```bash
npm start                          # serves jobber-auth, jobber-jobs, jobber-executor concurrently
```

### Individual app commands

```bash
npx nx serve <app>                 # serve with watch mode
npx nx build <app>                 # build
npx nx test <app>                  # run tests
npx nx lint <app>                  # lint
```

Apps: `jobber-auth`, `jobber-jobs`, `jobber-executor`

### Run a single test file

```bash
npx nx test jobber-auth --testFile=apps/jobber-auth/src/app/auth/auth.service.spec.ts
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
npx nx run jobber-auth:migrate-db  # run Prisma migrations
npx nx run jobber-auth:generate    # regenerate Prisma client
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

| Service           | Port | Role                                                     |
| ----------------- | ---- | -------------------------------------------------------- |
| `jobber-auth`     | 3000 | User auth (GraphQL + PostgreSQL/Prisma + gRPC server)    |
| `jobber-jobs`     | 3001 | Job management (GraphQL + Pulsar producer + gRPC client) |
| `jobber-executor` | 3002 | Job execution (Pulsar consumer)                          |

### Communication Patterns

1. **GraphQL (external)** — clients talk to `jobber-auth` and `jobber-jobs` via Apollo GraphQL APIs
2. **gRPC (internal)** — `jobber-jobs` calls `jobber-auth` to validate JWT tokens on every incoming request; contract in `proto/auth.proto`
3. **Apache Pulsar (async)** — `jobber-jobs` publishes job messages to Pulsar topics; `jobber-executor` subscribes and processes them

### Job Framework

`jobber-jobs` has an extensible job system:

- Decorate a class with `@Job()` to register a new job type
- `JobsService` uses `@golevelup/nestjs-discovery` to auto-discover all `@Job()` decorated classes
- The discovered job class receives the job payload and publishes it to a Pulsar topic named after the job type
- `jobber-executor` defines a corresponding `PulsarConsumer<T>` subclass that processes messages from that topic

See `apps/jobber-jobs/src/app/jobs/fibonacci/fibonacci.job.ts` and `apps/jobber-executor/src/app/jobs/fibonacci/fibonacci.consumer.ts` for the reference implementation.

### Shared Libraries

- **`@jobber/nestjs`** (`libs/nestjs`) — `AbstractModel` (GraphQL base type), `GqlContext`, `GqlAuthGuard`, and the `init()` bootstrap helper used by all three apps
- **`@jobber/pulsar`** (`libs/pulsar`) — `PulsarModule`, `PulsarClient` (producer/consumer management), and abstract `PulsarConsumer<T>` base class with JSON serialization

### Authentication Flow

1. User logs in via `jobber-auth` GraphQL mutation → receives JWT in HttpOnly cookie
2. Client sends cookie with requests to `jobber-jobs`
3. `jobber-jobs` extracts JWT and calls `jobber-auth` gRPC `AuthService.Authenticate` to validate and retrieve the user
4. `GqlAuthGuard` attaches the resolved user to GraphQL context

### Infrastructure

- PostgreSQL for `jobber-auth` user storage (Prisma ORM)
- Apache Pulsar for async job message passing (both running in Docker)

### Git Hooks

Pre-commit runs `lint-staged`: TypeScript files get auto-fixed with ESLint, all files get formatted with Prettier.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Start all services

```bash
npm start                          # serves auth, executor concurrently
```

### Individual app commands

```bash
npx nx serve <app>                 # serve with watch mode
npx nx build <app>                 # build
npx nx test <app>                  # run tests
npx nx lint <app>                  # lint
```

Apps: `auth`, `jobs`, `executor`, `products`

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

### Helm

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
npx nx run auth:migrate-db  # run Prisma migrations
npx nx run auth:generate    # regenerate Prisma client

npx nx run products:generate-drizzle  # generate Drizzle migrations from schema
npx nx run products:migrate-drizzle   # run Drizzle migrations
```

### Proto generation

```bash
npx nx run grpc:generate-ts-proto  # regenerate TypeScript from libs/grpc/src/lib/proto/auth.proto
```

### Utilities

```bash
npm stop                           # kill services on ports 3000, 3001, 3002
npm run cache-clean                # reset Nx cache and npm cache
```

## Architecture

Nx monorepo with four NestJS microservices and five shared libraries.

### Services

| Service    | Port | Role                                                        |
| ---------- | ---- | ----------------------------------------------------------- |
| `auth`     | 3000 | User auth (GraphQL + PostgreSQL/Prisma + gRPC server)       |
| `jobs`     | 3001 | Job management (GraphQL + Pulsar producer + gRPC client)    |
| `executor` | 3002 | Job execution (Pulsar consumer + gRPC client to `products`) |
| `products` | 3003 | Product persistence (gRPC server + PostgreSQL/Drizzle)      |

### Communication Patterns

1. **GraphQL (external)** — clients talk to `auth` and `jobs` via Apollo GraphQL APIs
2. **gRPC (internal)** — `jobs` calls `auth` to validate JWT tokens on every incoming request; `executor` calls `products` to persist job results; contracts in `libs/grpc/src/lib/proto/*.proto`
3. **Apache Pulsar (async)** — `jobs` publishes job messages to Pulsar topics; `executor` subscribes and processes them

### Job Framework

`jobs` has an extensible job system:

- Decorate a class with `@Job()` to register a new job type
- `JobsService` uses `@golevelup/nestjs-discovery` to auto-discover all `@Job()` decorated classes
- The discovered job class receives the job payload and publishes it to a Pulsar topic named after the job type
- `executor` defines a corresponding `PulsarConsumer<T>` subclass that processes messages from that topic

See `apps/jobs/src/app/jobs/fibonacci/fibonacci.job.ts` and `apps/executor/src/app/jobs/fibonacci/fibonacci.consumer.ts` for the reference implementation.

The `LoadProducts` job (`apps/jobs/src/app/jobs/products/load-products.job.ts`) follows the same pattern but its consumer (`apps/executor/src/app/jobs/products/load-products.consumer.ts`) additionally calls the `products` service over gRPC to persist the enriched product data via Drizzle.

### Shared Libraries

- **`@jobber/graphql`** (`libs/graphql`) — `AbstractModel` (GraphQL base type), `GqlContext`, `GqlAuthGuard`
- **`@jobber/nestjs`** (`libs/nestjs`) — `init()` bootstrap helper used by all apps, `Jobs` enum
- **`@jobber/grpc`** (`libs/grpc`) — gRPC proto files and generated TypeScript types for `AuthService` and `ProductsService`, plus the `Packages` enum
- **`@jobber/prisma`** (`libs/prisma`) — Prisma client used by `auth`
- **`@jobber/pulsar`** (`libs/pulsar`) — `PulsarModule`, `PulsarClient` (producer/consumer management), abstract `PulsarConsumer<T>` base class with JSON serialization, and job message DTOs (`FibonacciMessage`, `LoadProductsMessage`)

`products` uses Drizzle ORM (not Prisma) for its own PostgreSQL access — schema in `apps/products/src/app/products/schema.ts`, migrations managed via `nx run products:generate-drizzle` / `migrate-drizzle`.

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

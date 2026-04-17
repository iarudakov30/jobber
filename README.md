# Jobber

## Purpose

**Jobber** is a microservices-based backend application for **user authentication and background job management**. It's built as a distributed system using an **Nx monorepo** with two independent services.

---

## Core Features

| Service  | Feature                                                    |
| -------- | ---------------------------------------------------------- |
| **auth** | User registration & login via GraphQL                      |
| **auth** | JWT token generation stored in HttpOnly cookies            |
| **auth** | Protected queries with guards and `@CurrentUser` decorator |
| **auth** | Password hashing with bcryptjs                             |
| **jobs** | Extensible job framework with abstract base class          |
| **jobs** | `@Job()` decorator for metadata (name, description)        |
| **jobs** | Example Fibonacci job implementation                       |

---

## Tech Stack

### Core

- **Runtime**: Node.js + TypeScript
- **Framework**: NestJS v11
- **Monorepo**: Nx v22

### API Layer

- **GraphQL** (v16) + Apollo Server (v5) — code-first schema generation
- **Swagger/OpenAPI** — auto-generated REST docs

### Database

- **PostgreSQL** (Docker Compose for local dev)
- **Prisma** v7 — ORM with type-safe client + `@prisma/adapter-pg`

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
├── auth/     ← GraphQL auth service (users, JWT, Prisma)
├── jobs/     ← Job execution service (abstract jobs, decorators)
├── auth-e2e/
└── jobs-e2e/
libs/
└── nestjs/          ← Shared: AbstractModel, GqlContext interface
```

Each service is independently buildable. A shared `@jobber/nestjs` library provides common GraphQL base types and context interfaces.

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

### jobs

- **AbstractJob** — base class for all job implementations
- **@Job() decorator** — attaches name/description metadata to job classes
- **FibonacciJob** — example job implementation
- **JobsModule** — job registration and management

### @jobber/nestjs (shared lib)

- **AbstractModel** — base GraphQL `ObjectType` with ID field
- **GqlContext** — typed Express Request/Response for GraphQL context

---

## Summary

A **professional-grade NestJS backend starter** demonstrating modern patterns: GraphQL-first API design, JWT cookie authentication, Prisma ORM, and Nx monorepo tooling — with a job processing system designed for future expansion into async/background task execution.

[Learn more about this workspace setup and its capabilities](https://nx.dev/nx-api/nest?utm_source=nx_project&utm_medium=readme&utm_campaign=nx_projects) or run `npx nx graph` to visually explore what was created. Now, let's get you up to speed!

## Finish your CI setup

[Click here to finish setting up your workspace!](https://cloud.nx.app/connect/Q9ciqng6Ie)

## Database

Start the PostgreSQL container:

```sh
docker compose up -d
```

Stop it:

```sh
docker compose down
```

---

## Run tasks

### Serve

```sh
npx nx serve auth          # Serve auth app
npx nx serve jobs-lib          # Serve jobs-lib app
npx nx run-many -t serve          # Serve all apps in parallel

--skip-nx-cache                   # Run without cache

```

### Build

```sh
npx nx build auth          # Build auth app
npx nx build jobs-lib          # Build jobs-lib app
npx nx run-many -t build          # Build all apps
```

### Test & Lint

```sh
npx nx test auth           # Test auth app
npx nx test jobs-lib           # Test jobs-lib app
npx nx run-many -t test           # Test all apps
npx nx lint auth           # Lint auth app
npx nx lint jobs-lib           # Lint jobs-lib app
```

To see all available targets for a project, run:

```sh
npx nx show project auth
npx nx show project jobs-lib
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

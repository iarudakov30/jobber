# NexusPay — start here

NexusPay is a learning project built inside the jobber monorepo: a wallet and payments platform
with a simulated ("paper trading") crypto market as its UI. It exists to practise the parts of
backend engineering that matter most when money is involved — a double-entry ledger, idempotency,
the transactional outbox, safe retries and tracing — on top of the services jobber already has.

These documents let anyone (including future you) pick the project up cold and understand both
**what** was built and **why** each decision was made.

## Read in this order

| # | Document | What it answers |
| - | -------- | --------------- |
| 1 | [Purpose and architecture](01-purpose-and-architecture.md) | Why the project exists, the target architecture, the logic chain of every money flow |
| 2 | [Repo guide](02-repo-guide.md) | How the monorepo is laid out, how to run, test and debug it, known gotchas |
| 3 | [Roadmap](03-roadmap.md) | The five phases, what each delivers, the decisions already taken |
| 4 | [Phase 1 — step by step](phase-1/README.md) | What was actually built in phase 1, step by step, and how each step was verified |

The full design spec, with detailed per-phase specs (scope, design, tasks, acceptance tests,
risks), lives in Claude Docs:
[NexusPay — Wallet & Payments Pet Project Spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko).
These repo docs summarise it; when they disagree, the code and these docs describe what was
actually built, and the spec describes the plan.

## Status

| Phase | Content | State |
| ----- | ------- | ----- |
| 1. Groundwork | Pulsar consumer options + DLQ, transactional outbox, idempotent job acks, tracing + infra, React app with login | **Done** |
| 2. Ledger core | `apps/wallet`, double-entry ledger, transfers, `libs/money`, `libs/idempotency`, Wallet/Send screens | Next |
| 3. Stripe + RabbitMQ | `apps/payments`, Checkout, signed webhooks, `libs/rabbitmq`, email, delayed commands | Planned |
| 4. Market + realtime | `apps/market`, price simulator, orders and holds, `apps/realtime` WebSocket gateway | Planned |
| 5. Hardening | Refunds, disputes, reconciliation, airdrops, rate limits, roles, Ops screen, Helm | Planned |

## Branches (phase 1)

Nothing from phase 1 is merged into `main` yet. The backend work is a stack of branches, each
built on the previous one, so they must be merged in this order:

```mermaid
flowchart LR
  M((main)) --> R["feature/nexus-react-app<br/>d57b258 React app + login"]
  M --> P["feature/pulsar-consumer-options<br/>e5561ad Pulsar options + DLQ"]
  P --> O["feature/jobs-outbox<br/>bf1262c Outbox"]
  O --> A["feature/idempotent-job-acks<br/>a59cac2 Idempotent acks"]
  A --> T["feature/tracing-infra<br/>548599d Tracing + infra"]
  T --> D["docs/nexuspay<br/>these docs"]
```

| Order | Branch | Commit | Step |
| ----- | ------ | ------ | ---- |
| — | `feature/nexus-react-app` | `d57b258` | [React app with login](phase-1/00-react-app.md) (independent, from `main`) |
| 1 | `feature/pulsar-consumer-options` | `e5561ad` | [Step 1 — Pulsar consumer options and dead-lettering](phase-1/01-pulsar-consumer.md) |
| 2 | `feature/jobs-outbox` | `bf1262c` | [Step 2 — Transactional outbox](phase-1/02-outbox.md) |
| 3 | `feature/idempotent-job-acks` | `a59cac2` | [Step 3 — Count each job item once](phase-1/03-idempotent-acks.md) |
| 4 | `feature/tracing-infra` | `548599d` | [Step 4 — Tracing and infrastructure](phase-1/04-tracing-infra.md) |
| 5 | `docs/nexuspay` | — | These documents |

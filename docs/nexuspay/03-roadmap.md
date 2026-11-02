# Roadmap

Five phases, about 10 weeks of evenings. Each phase ends with a passing test, not just a working
demo. Phase 1 changed only existing jobber code (plus the React shell), so the reliability patterns
were learned on familiar ground before any money moves. The detailed per-phase specs (design,
task checklists, acceptance tests, risks) are in the
[Claude Docs spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko), under the "Phase specs" tab.

## Phase 1 — Groundwork in existing code (done)

Make jobber's messaging and jobs framework safe enough to build money on, and start the React app.

| Step | Delivered | Details |
| ---- | --------- | ------- |
| React app | `apps/nexus` with Login and Register | [00-react-app](phase-1/00-react-app.md) |
| 1 | Pulsar consumer options, dead-letter topics, message metadata | [01-pulsar-consumer](phase-1/01-pulsar-consumer.md) |
| 2 | Transactional outbox; jobs and their messages created atomically | [02-outbox](phase-1/02-outbox.md) |
| 3 | Each job item counted once; `LoadProducts` safe to redeliver | [03-idempotent-acks](phase-1/03-idempotent-acks.md) |
| 4 | Tracing end to end; Redis, Mailpit, Jaeger; Pulsar broker dedup | [04-tracing-infra](phase-1/04-tracing-infra.md) |

**Done when:** a Pulsar stop/start and a forced `LoadProducts` redelivery both leave the job
`COMPLETED` with no duplicate products. Both were verified, along with the end-to-end trace.

## Phase 2 — Ledger core + React screens (~2.5 weeks)

- `apps/wallet` (3004): Drizzle ledger schema (`assets`, `accounts`, `transactions`, `entries`), a
  deferred trigger that rejects unbalanced transactions, an append-only trigger on entries,
  `LedgerService.post()` (idempotent by `external_ref`, locks in id order).
- GraphQL `balances`, `entries`, `transfer`; gRPC `WalletService` (`Credit`, `GetBalances`,
  `RunAudit`); `wallet.proto` with money as `int64` sent as strings.
- `libs/money` (bigint minor units, parse and format), `libs/idempotency` (`Idempotency-Key`
  interceptor: PostgreSQL row as the guarantee, Redis lock as the fast path), the outbox's Drizzle
  store.
- `LedgerAudit` nightly job. React: Wallet screen, Send form, GraphQL Codegen.
- **Done when:** k6 fires 200 concurrent $1 transfers from a $100 wallet and exactly 100 succeed
  with no overdraft; 50 parallel requests with one `Idempotency-Key` create exactly one transfer.

## Phase 3 — Stripe top-up + RabbitMQ (~2 weeks)

- `apps/payments` (3005): `createTopUp`, Stripe Checkout, signed webhook (`rawBody`), payment
  state machine with conditional `UPDATE … WHERE status = 'PENDING'`.
- Never call Stripe inside a DB transaction. Expiry calls `sessions.expire` first, which closes the
  race with a payment at minute 29:59.
- `libs/rabbitmq` (confirm channels, `RabbitConsumer<T>`, explicit retry queues, DLQs), delay
  buckets as fanout exchange + TTL queue. A fanout exchange keeps the routing key, while
  publishing straight to the queue would replace it.
- Wallet consumes `payment-succeeded`; the email worker in executor sends through Mailpit.
- **Done when:** a test-card top-up credits once and emails once, replaying the webhook 10× still
  credits once, and an unpaid payment expires.

## Phase 4 — Fake market + realtime (~3 weeks)

- `apps/market` (3006): seeded random-walk price simulator (one leader via a Redis lock), candles,
  10-second quotes in Redis, market and limit orders, `SettleTrade`, holds, `order.expire`.
- Rounding favours the house: the buyer's cost rounds up and the seller's proceeds round down.
- `apps/realtime` (3007): raw `ws` server with cookie auth during the upgrade, per-instance
  RabbitMQ queue with per-user bindings, heartbeats, backpressure. `seq` only increases, and
  clients refetch a snapshot after reconnecting.
- React: realtime hooks (`usePrice`, `useUserFeed`), Markets, Trade and Portfolio screens.
- **Done when:** a limit order holds, then fills, cancels or expires with correct balances, and
  clients survive a realtime replica being killed.

## Phase 5 — Hardening (~1 week)

- Refunds (hold first), disputes (shortfall to `dispute_losses`, wallet frozen), `Reconcile` and
  `Airdrop` jobs, roles in auth, rate limits (`@nestjs/throttler` with Redis), Ops screen, Helm
  deployments for the new apps.
- **Done when:** the reconciliation job reports zero issues after a scripted day of real
  test-mode activity.
- Optional stretch: swap `auth` for Keycloak.

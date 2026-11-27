# Roadmap

Five phases, about 10 weeks of evenings. Each phase ends with a passing test, not just a working
demo. Phase 1 changed only existing jobber code (plus the React shell), so the reliability patterns
were learned on familiar ground before any money moves. The detailed per-phase specs (design,
task checklists, acceptance tests, risks) are in the
[Claude Docs spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko), under the "Phase specs" tab.

## Phase 1 — Groundwork in existing code (done)

Make jobber's messaging and jobs framework safe enough to build money on, and start the React app.

| Step      | Delivered                                                        | Details                                             |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------- |
| React app | `apps/nexus` with Login and Register                             | [00-react-app](phase-1/00-react-app.md)             |
| 1         | Pulsar consumer options, dead-letter topics, message metadata    | [01-pulsar-consumer](phase-1/01-pulsar-consumer.md) |
| 2         | Transactional outbox; jobs and their messages created atomically | [02-outbox](phase-1/02-outbox.md)                   |
| 3         | Each job item counted once; `LoadProducts` safe to redeliver     | [03-idempotent-acks](phase-1/03-idempotent-acks.md) |
| 4         | Tracing end to end; Redis, Mailpit, Jaeger; Pulsar broker dedup  | [04-tracing-infra](phase-1/04-tracing-infra.md)     |

**Done when:** a Pulsar stop/start and a forced `LoadProducts` redelivery both leave the job
`COMPLETED` with no duplicate products. Both were verified, along with the end-to-end trace.

## Phase 2 — Ledger core + React screens (~2.5 weeks, done)

Done in six steps, each logged in [phase-2/README.md](phase-2/README.md): ledger core, contracts
and libs, wallet API, idempotency (with the k6 runs), nightly audit, React screens. All spec
acceptance tests pass.

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

## Phase 3 — Stripe top-up + RabbitMQ (~2 weeks, done)

Progress, step by step: [phase-3/README.md](phase-3/README.md). Steps 1 (`libs/rabbitmq`), 2 (contracts:
`RabbitOutboxPublisher`, `PaymentSucceededMessage`, `GetUser`) 3 (`apps/payments`)
4 (wallet credit, email worker) and 5 (top-up screen, live run with the Stripe CLI) are done:
all 11 acceptance tests pass.

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

## Phase 4 — Fake market + realtime (~3 weeks, done)

Progress, step by step: [phase-4/README.md](phase-4/README.md). Steps 1 (contracts), 2
(wallet trading: holds, `SettleTrade`, market maker inventory, `positions`, realtime balance and
fill messages), 3 (`apps/market` prices: seeded simulator on one leader, ticks, candles,
quotes), 4 (orders: market and limit orders, matching, cancel, expiry, recovery) and 5
(`apps/realtime`: the WebSocket gateway), 6 (the `BackfillCandles` job and `GenerateCandles`)
and 7 (React: realtime client, Markets, Trade and Portfolio, Playwright) are done: all 14
acceptance tests pass.

- `apps/market` (3006): seeded random-walk price simulator (one leader via a Redis lock), candles,
  10-second quotes in Redis, market and limit orders, `SettleTrade`, holds, `order.expire`.
- Rounding favours the house: the buyer's cost rounds up and the seller's proceeds round down.
- `apps/realtime` (3007): raw `ws` server with cookie auth during the upgrade, per-instance
  RabbitMQ queue with per-user bindings, heartbeats, backpressure. `seq` only increases, and
  clients refetch a snapshot after reconnecting.
- React: realtime hooks (`usePrice`, `useUserFeed`), Markets, Trade and Portfolio screens.
- **Done when:** a limit order holds, then fills, cancels or expires with correct balances, and
  clients survive a realtime replica being killed.

## Phase 4.5 — Real prices (~3–5 days, in progress)

Progress, step by step: [phase-4.5/README.md](phase-4.5/README.md). Step 1 (contracts: the four
real coins as assets, a price source per coin, `source` on ticks), step 2 (Coinbase and
Binance adapters with fake exchanges for tests), step 3 (per-coin failover and failback, the
bad print guard, live ticks on the leader) and step 4 (history from the exchanges' candles, the
last 24 h filled on leadership) are done.

- Four real coins, BTC, ETH, HYPE and ZEC, priced from Binance (USDT pairs), with Coinbase Exchange
  (USD pairs) as a per-coin fallback and a failback once Binance is steadily healthy; the four
  simulated coins stay.
- A bad print guard holds back a jump over 10% until it is confirmed; with no provider healthy a
  coin has no price and can't be traded.
- Real 1-minute history from the exchanges through `BackfillCandles`, and the last 24 h filled
  when a replica starts leading.
- **Done when:** the four real coins tick live in the app, survive one provider failing, and trade
  end to end like the simulated ones.

## Phase 5 — Hardening (~1 week)

- Refunds (hold first), disputes (shortfall to `dispute_losses`, wallet frozen), `Reconcile` and
  `Airdrop` jobs, roles in auth, rate limits (`@nestjs/throttler` with Redis), Ops screen, Helm
  deployments for the new apps.
- **Done when:** the reconciliation job reports zero issues after a scripted day of real
  test-mode activity.
- Optional stretch: swap `auth` for Keycloak.

## Alongside the phases — production drills

Four break-measure-fix experiments on the existing services, done whenever there's a gap between
phases: a rollout under load without lost requests, event loop blocking in `executor`, a crash
inside a consumer, a memory leak hunt in `wallet`. Task lists and results:
[production-drills.md](production-drills.md). Drill 1 also brings health probes and SIGTERM
handling to the Helm chart, which phase 5 needs for the new apps anyway.

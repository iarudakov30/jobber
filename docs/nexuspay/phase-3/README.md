# Phase 3 — step by step

Phase 3 brings money in from outside: a top-up through Stripe Checkout (test mode) credits the
wallet once and sends one email, and an unpaid top-up expires. It also adds RabbitMQ for email,
retries and delayed commands. The plan (scope, design, tasks, acceptance tests, risks) is the
"3. Stripe + RabbitMQ" tab of the [spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko).
Each step follows the same pattern as before: why, what changed, how it works, how it was
verified, lessons. Work is committed straight to `main`.

| Step                | Delivers                                                                                                                                                                               | Doc                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 1. RabbitMQ library | `libs/rabbitmq` (connection with reconnect, confirm publisher, `RabbitConsumer<T>` with retry queues and DLQ, delay buckets, DLQ replay), RabbitMQ in compose; spec acceptance test 10 | [01-rabbitmq.md](01-rabbitmq.md)   |
| 2. Contracts        | `RabbitOutboxPublisher` in `libs/outbox`, `PaymentSucceededMessage` in `libs/pulsar`, `GetUser` in `auth.proto`                                                                        | [02-contracts.md](02-contracts.md) |
| 3. Payments service | `apps/payments` (3005): schema, `createTopUp`, Stripe client, signed webhook, `payment.expire` consumer; spec acceptance tests 1, 4, 5, 6                                              | —                                  |
| 4. Credit and email | Wallet `PaymentSucceededConsumer` (`stripe_clearing` → user), `email.topup` via RabbitMQ, email worker in executor; spec tests 7, 8, 9                                                 | —                                  |
| 5. Top-up screen    | `/topup` page and the polling return on `/wallet`; the manual run with Stripe CLI and a test card; spec acceptance tests 2, 3, 11                                                      | —                                  |

The steps are a proposed order, not part of the spec; adjust as they're built. Steps 3 and 5 need
a Stripe test-mode account (`STRIPE_SECRET_KEY`) and the Stripe CLI for local webhooks.

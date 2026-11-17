# Step 1 — RabbitMQ library

- **Where:** committed directly to `main`.

## Why

Pulsar carries facts that several services read (`payment-succeeded`, `transfer-completed`). Phase
3 also needs things Pulsar is clumsy at:

- **A work queue with retries spaced out in time.** An email to a mail server that is down should
  wait 5 s, then 30 s, then 5 min, and land in a dead-letter queue (DLQ) after the 5th attempt.
  Pulsar's nack retries at one fixed delay.
- **Delayed commands.** "Expire this payment in 30 minutes" must survive a restart, so a timer in
  the process won't do.

RabbitMQ does both with plain queue features (per-queue TTL and dead-letter exchanges). This step
builds the library every later step uses, before any payment code exists.

## What changed

| Area                   | Change                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `libs/rabbitmq` (new)  | `RabbitConnection`, `RabbitPublisher`, `RabbitConsumer<T>`, `NonRetryableError`, `declareTopology()`, `RabbitModule.forRoot / forRootAsync` |
| DLQ replay             | `libs/rabbitmq/scripts/replay.mjs`, target `npx nx run rabbitmq:replay --queue=<name>`                                       |
| `docker-compose.yaml`  | `rabbitmq:4-management` (5672, UI on 15672, guest / guest), fixed `hostname` and a `rabbitmq_data` volume                    |
| Workspace              | `@jobber/rabbitmq` in `tsconfig.base.json` and `_moduleAliases`; `amqplib` 2.2.1 pinned in the lib's `package.json`          |
| Tests                  | 11 tests against a Testcontainers RabbitMQ (`rabbitmq:4-management`, the compose image, so it is pulled once)                 |

No app uses the library yet: payments, the wallet and the executor start using it in steps 3 and 4.

## How it works

### Connection

`RabbitConnection` owns one AMQP connection and a background loop:

```
connect → declare the topology → open a channel per consumer → mark connected
   ↑                                                                 │
   └──── wait 1 s, 2 s, 4 s … 30 s ◄──── connection closed or connect failed
```

- **The topology is declared on every connect.** If someone deleted an exchange while the service
  was disconnected, it comes back with its bindings.
- **The app starts even when RabbitMQ is down.** Publishes then fail at once with
  `RabbitUnavailableError` instead of waiting. The outbox relay retries them, so a message waits
  in the outbox table, not in memory.
- **Publishes go through a confirm channel.** `publish()` resolves only when the broker confirms.
  A publish the broker refuses (an unknown exchange closes the channel with 404) rejects with the
  broker's reason, and the next publish opens a fresh channel.
- The logs say "RabbitMQ unavailable" once per outage and "RabbitMQ is back" when it returns.

amqplib 2 has a built-in `recovery` option. The library uses its own loop instead, as the spec
asks: it re-declares the topology and restarts consumers explicitly, and that is the part worth
seeing and testing.

### Topology

```ts
RabbitModule.forRootAsync({
  useFactory: (config: ConfigService) => ({
    url: config.getOrThrow('RABBITMQ_URL'),
    connectionName: 'payments',
    topology: {
      exchanges: [{ name: 'commands', type: 'topic' }],
      queues: [{ name: 'payments.commands', bindings: [{ exchange: 'commands', routingKey: 'payment.*' }] }],
      delayBuckets: [{ name: 'delay.30m', ttlMs: 30 * 60_000, target: 'commands' }],
    },
  }),
  inject: [ConfigService],
});
```

For each queue, `declareTopology()` creates:

| Queue                   | Arguments                                                    | Role                                     |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `<queue>`               | quorum                                                       | The work queue, bound as configured      |
| `<queue>.retry.<n>`     | quorum, `x-message-ttl` = delay n, dead-letters to `<queue>` | One waiting room per retry delay         |
| `<queue>.dlq`           | quorum                                                       | Messages that ran out of attempts        |

The default retry is 5 s, 30 s, 5 min, at most 5 attempts. A delay bucket is a fanout exchange
plus a queue of the same name with a TTL, dead-lettering into `target`.

All queues are quorum queues. On one local node that only shows the API: quorum queues need three
nodes to survive a node failure.

### A failed message

```
attempt 1 fails ─► copy to <queue>.retry.1 (x-attempt 2), ack the original
                   … 5 s TTL … dead-lettered back to <queue>
attempt 2 fails ─► <queue>.retry.2 (30 s) … attempt 3 ─► retry.3 (5 min) … attempts 4, 5 ─► retry.3
attempt 5 fails ─► copy to <queue>.dlq (x-attempt 5, x-dead-letter-reason), ack the original
NonRetryableError or JSON that won't parse ─► <queue>.dlq at once
```

- **Retries are explicit.** The attempt number travels in an `x-attempt` header that the
  consumer sets. It doesn't count RabbitMQ's `x-death` entries, and it strips them from the copy
  so they don't pile up.
- **The routing key survives.** A copy sent through the default exchange gets the queue name as
  its key, so the original goes along in `x-original-routing-key`. The consumer reports it as
  `meta.routingKey`.
- **Copy first, then ack.** If the copy can't be published, the original is requeued instead, so a
  crash duplicates a message and never loses one. Delivery is at-least-once, so `onMessage` must
  tolerate repeats.
- **Tracing.** The publisher writes `traceparent` into the headers, and the consumer runs each
  delivery in a `<queue> process` span that continues that trace. Retries keep the headers, so
  all attempts join the same trace.

### Delay buckets keep the routing key

Exchange `delay.30m` (fanout) → queue `delay.30m` (TTL 30 min, dead-letter exchange `commands`).
Publish to the **exchange** `delay.30m` with key `payment.expire`. A fanout ignores the key but
keeps it, and dead-lettering keeps it too, so after 30 minutes the message reaches `commands` as
`payment.expire` and is routed to `payments.commands`. Publishing to the queue `delay.30m` through
the default exchange would have replaced the key with `delay.30m`.

### DLQ replay

`npx nx run rabbitmq:replay --queue=notifications.email` moves what is in
`notifications.email.dlq` back to `notifications.email` as first attempts. It keeps each
message's id and original routing key and drops the attempt count and the dead-letter reason. It
only moves the messages that were in the DLQ when it started, so a message that fails again
isn't replayed in a loop. `RABBITMQ_URL` defaults to `amqp://localhost:5672`.

## How it was verified

- **`npx nx test rabbitmq`:** 11 tests against `rabbitmq:4-management` in Testcontainers:
  - **Delivery:** a message arrives with its id, routing key and headers as attempt 1.
  - **Retry timing:**
    - with delays of 300 ms and 600 ms and 3 attempts, the gaps between attempts were at least
      300 ms and 600 ms;
    - the routing key stayed `email.retry` on every attempt;
    - the DLQ copy had `x-attempt: 3`, the error text as its reason, and the original key;
    - no 4th attempt came within a second.
  - **Recovery and dead-lettering:**
    - a message that fails once succeeds on attempt 2 and never reaches the DLQ;
    - `NonRetryableError` and non-JSON payloads go straight to the DLQ.
  - **Delay bucket (spec acceptance test 10):** a command published to an 800 ms bucket reached
    `commands` as `payment.expire` after at least 800 ms. The test uses a short bucket; `delay.1m`
    works the same way.
  - **Publishing:**
    - a publish to an unknown exchange rejects with the broker's `NOT_FOUND`, and the next publish
      goes through;
    - a publish against an unreachable broker rejects with `RabbitUnavailableError` in under
      500 ms.
  - **Replay:** a dead-lettered message, replayed by running the real script, came back as
    attempt 1 with its routing key, and the DLQ was empty afterwards.
  - **Nest wiring:** `RabbitModule.forRootAsync` connected on init, its consumer received a
    message, and `app.close()` disconnected.
  - **Reconnect:** we deleted the `notifications` exchange and then ran
    `rabbitmqctl close_all_connections`. The connection came back, re-declared the exchange and
    its binding, and the consumer received the next message.
- **Replay through Nx against the compose RabbitMQ:** a message put in `replay-demo.dlq` with
  `x-attempt: 5`, a reason and `x-original-routing-key: email.topup` was moved by
  `npx nx run rabbitmq:replay --queue=replay-demo`. It arrived in `replay-demo` with only
  `x-original-routing-key` left, and the DLQ was empty. The demo queues were deleted afterwards.
- `npx nx run-many -t lint test build -p rabbitmq`: green; `dist/libs/rabbitmq` built.

## Lessons

- **amqplib is at 2.x and bundles its own types**, so `@types/amqplib` isn't needed. The newest
  releases (2.3.x, 2.4.0) were days old, so the lib pins 2.2.1, which had been out for over two
  weeks. A caret range would have installed 2.4.0.
- **`await` flattens a promise inside a promise.** `connectOnce()` first returned
  `Promise<Promise<void>>` (connected, then closed), and TypeScript typed the awaited value as
  `void`. It now returns `{ closed }`.
- **A refused publish reports only "channel closed".** amqplib fails the pending confirm with that
  text, while the broker's reason (`404 NOT_FOUND - no exchange …`) arrives first as the channel's
  `error` event. The connection keeps that error and rethrows it with the reason.
- **RabbitMQ names its data directory after the host name.** Without a fixed `hostname` in
  compose, a recreated container starts with an empty node and the queues are gone.
- **npm now blocks install scripts by default.** The install printed `install-scripts` warnings
  for packages that were already built (`pulsar-client` still loads); a fresh clone may need
  `npm install-scripts approve <pkg>` for the native ones.

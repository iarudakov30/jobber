# Step 2 — Contracts

- **Where:** committed directly to `main`.

## Why

Steps 3 and 4 build three services that talk to each other: `payments` announces a paid top-up,
`wallet` credits it and queues an email, and the email worker in `executor` sends it. Each link
needs a shared contract, and it is cheaper to settle and test those contracts before any of the
services exist:

- **`payments` and `wallet` need RabbitMQ messages that commit with their state change.** The
  outbox could only publish to Pulsar. `payments` will enqueue `payment.expire` on `delay.30m` in
  the same transaction that creates the payment, and `wallet` will enqueue `email.topup` in the
  same transaction as the credit. If the process dies after the commit, the message still goes out.
- **`wallet` must trust what it reads from `payment-succeeded`.** The message moves money, so a
  malformed one has to be rejected and dead-lettered, not half-processed or retried forever.
- **The email worker needs the recipient's address.** Messages carry only `userId` (an email
  address in a queue would be personal data kept in a second place), so `auth` must answer "who is
  user 7?".

## What changed

| Area            | Change                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/outbox`   | `RabbitOutboxPublisher` (transport `rabbitmq`): exchange = `destination`, routing key = `key`, `messageId` = `outbox-<service>-<id>`                       |
| `libs/pulsar`   | `PaymentSucceededMessage`, `PAYMENT_SUCCEEDED_TOPIC` (`payment-succeeded`), `PAYMENT_CURRENCIES`; `validateMessage(cls, data)`                             |
| `auth.proto`    | `rpc GetUser(GetUserRequest) returns (User)`; TypeScript regenerated (only `auth.ts` changed)                                                              |
| `apps/auth`     | `AuthController.getUser` (`INVALID_ARGUMENT` for an id below 1, `NOT_FOUND` for an unknown one), `UsersService.findById` (never returns the password hash) |
| `libs/rabbitmq` | The refused-publish error sets `cause` by hand, so projects that import the library don't need `lib: es2022`                                               |

## How it works

### Rabbit records in the outbox

The outbox table already had a `transport` column for this. A record such as

```ts
{ transport: 'rabbitmq', destination: 'delay.30m', key: 'payment.expire', payload: { paymentId } }
```

is published by `RabbitOutboxPublisher` as `publish('delay.30m', 'payment.expire', payload, …)`.
The relay picks the publisher by transport, so one relay serves both brokers, and `wallet` will
write a Pulsar and a Rabbit record in the same transaction.

The two publishers deal differently with a record the relay sends twice (it published, then
crashed before marking the row):

- **Pulsar** drops the copy itself: a fixed producer name plus the outbox id as `sequenceId`, with
  broker deduplication on.
- **RabbitMQ** has no such feature. Each message carries `messageId = outbox-<service>-<id>`,
  stable across resends, and a consumer that must not repeat its work dedupes on it. The email
  worker will keep `email:sent:<messageId>` in Redis for 7 days.

Messages are persistent, and `publish` resolves only on the broker's confirm. If the broker
refuses (an unknown exchange) or is down, the relay keeps the record and everything after it, and
retries with backoff.

### `PaymentSucceededMessage`

```ts
{ paymentId: uuid, userId: int ≥ 1, amount: "5000", currency: "USD" }
```

The amount is minor units as a decimal string, like every amount on a wire in this project: JSON
numbers lose precision above 2^53. The message is keyed by `userId`, so the wallet's Key_Shared
subscription handles one user's top-ups in order. The wallet will credit with
`externalRef = paymentId`, so a redelivered message credits once.

`validateMessage(PaymentSucceededMessage, data)` runs class-validator and returns a typed instance.
It throws `NonRetryableError` listing every broken field, because invalid data never becomes valid
on a retry. `PulsarConsumer` dead-letters that error at once. `RabbitConsumer` matches the error by
name, so the same helper works for Rabbit messages.

### `GetUser`

```proto
rpc GetUser(GetUserRequest) returns (User);   // User = { id, email }
```

proto3 sends `0` for a field the caller forgot, so an id below 1 answers `INVALID_ARGUMENT`
without querying. An unknown id answers `NOT_FOUND`, which the email worker will treat as
non-retryable. Like `FindUserByEmail`, it is meant for other services, not browsers, and returns
only the id and the email.

## How it was verified

- **`npx nx test outbox`:** 3 unit tests for `RabbitOutboxPublisher` (arguments, empty routing
  key, a refusal passed on). Then 4 tests that run the real `OutboxRelay` against RabbitMQ in
  Testcontainers, using an in-memory store with the store's contract:
  - a record arrives with `messageId: outbox-wallet-1`, routing key `email.topup` and the
    `traceparent` it was written with;
  - a Pulsar record and a Rabbit record in one batch each reach their own broker;
  - a record sent to a 500 ms delay bucket reached `commands` after at least 450 ms as
    `payment.expire`, with the same `messageId`;
  - the broker refused a record for an exchange that didn't exist yet (`404 NOT_FOUND`), and the
    relay stopped there with records 2 and 3 unpublished. Once the exchange existed, the next tick
    published both, in order.
- **`npx nx test pulsar`:** `validateMessage` accepts a valid message. It rejects a non-UUID
  `paymentId`, a zero or string `userId`, a numeric, decimal, zero or negative `amount`, an unknown
  currency, and payloads that aren't objects. Every rejection is a `NonRetryableError`.
- **`npx nx test auth`:** `getUser` returns only `{ id, email }`, answers `NOT_FOUND` for an
  unknown id, and answers `INVALID_ARGUMENT` for 0, -1 and 1.5 without querying.
- `npx nx affected -t lint test build`: green for all 18 affected projects.

## Lessons

- **A shared library's imports become every consumer's compile settings.** At first the message
  checked its currency against `ASSETS` from `@jobber/money`. That pulled bigint literals into
  every project that imports `@jobber/pulsar`, and the `jobs` and `executor` tests (which target
  ES2015) failed with `TS2737`. `new Error(msg, { cause })` in `libs/rabbitmq` caused the same kind
  of failure (`lib: es2022`) once `libs/outbox` imported it. The currency list now lives next to
  the message, and the error sets `cause` by hand. The libraries' own tests had passed both times;
  only `nx affected` caught it.
- **RabbitMQ doesn't deduplicate, so the id has to be stable.** A random `messageId` per publish
  would defeat the email worker's dedupe exactly when it matters, on a relay resend.

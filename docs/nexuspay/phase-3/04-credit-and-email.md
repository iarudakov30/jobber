# Step 4 — Credit and email

- **Where:** committed directly to `main`.

## Why

After step 3, `payments` announced a paid top-up and nothing listened. This step closes the
loop: the wallet credits the money and the user gets one email. Both ends have to survive the
same faults as everything before. The message comes again after a crash, a broker or the mail
server is down, two replicas get the same message. Yet the result must be exactly one credit,
and an email that arrives once, maybe late.

## What changed

| Area                       | Change                                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/wallet`              | `PaymentSucceededConsumer` (`topups/`): Pulsar `payment-succeeded`, subscription `wallet`, Key_Shared; posts `topup` from `stripe_clearing` and queues `email.topup` in the same transaction |
| `apps/wallet`              | `OutboxModule` (global): one relay with the Pulsar and the RabbitMQ publisher; `RabbitModule` declares the notifications topology; `FAULT_CRASH_AFTER_CREDIT` test hook                      |
| `apps/executor`            | Email worker (`notifications/`): `EmailConsumer` on `notifications.email`, nodemailer 10.3.1 to `SMTP_URL`, auth `GetUser`, Redis `email:sent:<messageId>`; loaded only with `RABBITMQ_URL`  |
| `libs/rabbitmq`            | `notifications.ts`: exchange, queue and routing key names, `notificationsTopology()`, `TopUpEmailMessage`; `errorText()` no longer returns `""` for errors with an empty message             |
| `libs/outbox`              | **Fix:** one ordered stream per transport. `processBatch(limit, publish, transport?)`, and the relay backs off each transport on its own                                                     |
| `apps/executor/Dockerfile` | Copies `libs/money` and `libs/rabbitmq`, which the executor now uses                                                                                                                         |
| Docs                       | Architecture: a "what runs today" diagram with every service, broker, Redis, Stripe, Mailpit and Jaeger; the top-up sequence as built; repo guide and CLAUDE.md brought up to date           |

## How it works

### The credit

```
payment-succeeded { paymentId, userId, amount: "5000", currency: "USD" }   (key = userId)
  → validateMessage: invalid → NonRetryableError → dead-letter topic, no retry
  → one DB transaction:
      transactions (type 'topup', external_ref = paymentId)   UNIQUE (type, external_ref)
      entries      stripe_clearing −5000, user:available +5000
      outbox       rabbitmq → notifications / email.topup { userId, paymentId, amount, currency }
  → ack
```

`stripe_clearing` is a system account. It goes negative by what Stripe owes us, and phase 5's
reconciliation matches it against Stripe's payouts. A second delivery of the same message
(redelivery after a crash, a replay, a second replica) hits the unique key. `LedgerService.post`
then answers `duplicate: true` and writes nothing: no entries, and no second email record. The
email exists exactly when the credit does, because both are in one transaction.

Key_Shared with the `userId` key sends one user's top-ups to one consumer at a time, in order. A
separate subscription name (`wallet`) means the wallet gets every message, whoever else listens
to the topic later.

### The email

```
notifications.email (routing key email.topup)
  → validate TopUpEmailMessage; a missing messageId or unknown routing key → DLQ
  → Redis EXISTS email:sent:<messageId> → already sent: ack, done
  → auth GetUser(userId) → NOT_FOUND → DLQ
  → nodemailer → SMTP_URL (Mailpit)
  → Redis SET email:sent:<messageId> EX 7 days
```

The `messageId` is `outbox-wallet-<outbox id>`, stable across relay resends (step 2). If the
process crashes between sending and the Redis `SET`, the email goes out twice. The spec accepts
that for an email, and it would never be acceptable for money. When Redis is down the check
throws and the message is retried, rather than sent unchecked.

Failures that might pass (SMTP, Redis or auth unreachable) retry after 5 s, 30 s and 5 min, then
wait in `notifications.email.dlq`. `npx nx run rabbitmq:replay --queue=notifications.email`
sends them back once the cause is fixed.

### Who declares the queue

A topic exchange silently drops a message that no queue is bound for. If only the executor
declared `notifications.email`, an email published while the executor had never run would be lost.
So the wallet (publisher) and the executor (consumer) both declare `notificationsTopology()`. It
is one function, so the arguments match, and RabbitMQ refuses to redeclare a queue with different
ones.

### The outbox fix: one stream per broker

Acceptance test 8 (RabbitMQ down) failed the first time it ran live. With RabbitMQ stopped, a
paid top-up was **not credited**. `payments` writes `payment.expire` (RabbitMQ) when the top-up
starts, and `payment-succeeded` (Pulsar) when it's paid. The relay published strictly in id order
and stopped at the first failure. So the unsendable `payment.expire` blocked the
`payment-succeeded` behind it, and an outage of one broker stopped the other.

Now `processBatch` takes a transport, and the relay runs one batch per transport. Order still
holds within a broker, which is what consumers rely on. A failing transport backs off on its own
(200 ms doubling to 2 s), while the others keep going. The wallet's outbox has the same mix
(`transfer-completed` on Pulsar, `email.topup` on RabbitMQ), and the fix covers it too.

## How it was verified

- **`npx nx test wallet`:** 59 tests, 8 of them new, against Testcontainers PostgreSQL:
  - a credit moves `stripe_clearing −X / user +X` and writes exactly one `email.topup` outbox
    record;
  - 5 redeliveries after a credit (acceptance 7 in miniature) still give one transaction, one
    balance and one email record;
  - 10 concurrent first deliveries of one payment give one credit;
  - two top-ups of one user add up;
  - a numeric amount, a zero amount, another currency or a missing `paymentId` is a
    `NonRetryableError`, and nothing is written.
- **`npx nx test executor`:** 4 new tests against Testcontainers RabbitMQ, Redis and Mailpit,
  reading Mailpit's API:
  - the email goes to the address auth returns, with the subject "Your top-up of $50.00 is in
    your NexusPay wallet";
  - the same `messageId` twice sends one email, and the Redis mark has a 7-day TTL;
  - an unknown user and bad data go straight to the DLQ, with no email;
  - acceptance 9 with short retries: SMTP down, three attempts, then the DLQ and no email. After
    the replay script ran with SMTP back, exactly one email arrived.
- **`npx nx test outbox`:** 28 tests. New ones:
  - the Drizzle store claims only the requested transport;
  - the relay publishes Pulsar while RabbitMQ fails, backs off only RabbitMQ, and leaves a
    transport alone when it has no publisher for it;
  - the Prisma store sends the transport filter.
- **Live, with `auth`, `payments`, `wallet` and `executor` running.** A real Checkout session was
  created at Stripe, and the `completed` webhook was signed locally with the Stripe SDK; the Stripe
  CLI comes in step 5.
  - **Happy path:** the balance went from 0 to $50.00 and one email arrived in Mailpit, even after
    the webhook was resent 10 times. Jaeger showed one trace of 34 spans:

    ```
         0 ms payments  POST (webhook)
        24 ms payments  payment-succeeded publish
       138 ms wallet    payment-succeeded process
       216 ms wallet    notifications publish
       226 ms executor  notifications.email process
       246 ms auth      grpc.auth.AuthService/GetUser
    ```

  - **Acceptance 7:** the wallet was started with `FAULT_CRASH_AFTER_CREDIT=1`. It credited,
    logged the fault and exited before the ack. Restarted without the flag, it got the message
    again and logged "already credited". The result was one `topup` transaction, a $50.00 balance,
    one email record and one email.
  - **Acceptance 8:** with `docker compose stop rabbitmq`, a top-up was credited 295 ms after the
    webhook, and no email came. After `docker compose start rabbitmq` the email arrived once, 23 s
    later (broker start plus reconnect backoff). The first attempt is the one that found the outbox
    bug above.
  - **Acceptance 9, with the real timings:** `docker compose stop mailpit`, then a top-up.
    The executor tried at 22:51:22, 22:51:27 (+5 s), 22:52:06 (+30 s, plus the time the
    connection attempt took), 22:57:07 (+5 min) and 23:02:07 (+5 min). The 5th failure moved the
    message to `notifications.email.dlq`. After `docker compose start mailpit` and
    `npx nx run rabbitmq:replay --queue=notifications.email`, exactly one email arrived and every
    `notifications.email*` queue was empty.
  - The same run showed the retry log saying `retrying in 5000 ms: ` with **no reason**. The fix is
    in "Lessons". Rerun after it: `failed on attempt 1; retrying in 5000 ms: connect ECONNREFUSED
::1:1025; connect ECONNREFUSED 127.0.0.1:1025; ESOCKET`, then sent on attempt 2 once Mailpit
    was back.
- `npx nx test rabbitmq`: 14 tests, 3 new for `errorText`.
- `npx nx affected -t lint test build`: green for all 19 affected projects.

## Lessons

- **An error can have an empty message.** nodemailer reports a refused connection as an
  `AggregateError` (one attempt on ::1, one on 127.0.0.1) whose `message` is `""`. So the logs
  and the DLQ's `x-dead-letter-reason` said nothing. `errorText()` in `libs/rabbitmq` now falls
  back to the inner errors and the code. An operator reads the DLQ reason first, so it must
  never be blank.
- **Don't run `nx affected` next to `nx serve`.** The build target cleans `dist/apps/<app>`,
  and the serve watchers of payments and wallet stopped without restarting. `npm stop` frees
  only the ports, so stop the `nx serve` processes too, or a watcher can bring an old app back.

- **A shared outbox mixes brokers, so it must not mix their failures.** In-order publishing is
  right within one stream and wrong across two. Only a live "broker down" run showed it: every
  unit test used one transport.
- **Whoever publishes to a topic exchange declares the queue too.** Otherwise the first messages
  vanish without an error.
- **Four projects now start RabbitMQ in Testcontainers.** Under `nx affected` they boot at once, and
  one of them missed Testcontainers' default 30 s wait for "Server startup complete", which failed
  every test in that suite. Each spec now allows 120 s (`withStartupTimeout`).
- **Check the stale "known gaps".** auth's gRPC server spans, listed as missing since phase 1,
  show up in today's traces. The note in CLAUDE.md was wrong and is gone.
- **nodemailer 10 ships its own types.** The compiler reported errors against
  `nodemailer/dist/cjs/nodemailer.d.ts`, not `@types/nodemailer`, so the separately installed
  `@types/nodemailer` 8.x was removed.

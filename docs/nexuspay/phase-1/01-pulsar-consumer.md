# Step 1 — Pulsar consumer options and dead-lettering

- **Branch:** `feature/pulsar-consumer-options` (commit `e5561ad`), from `main`.

## Why

The Pulsar library (`libs/pulsar`) had three problems that would hurt a payments system:

1. **Every consumer used one hard-coded subscription, `jobber`, in Exclusive mode.** A second
   service subscribing to the same topic (e.g. wallet *and* notifications on
   `payment-succeeded`) would be rejected, and executor couldn't run two replicas.
2. **A failing message was negatively acknowledged forever.** No delay, no limit, no dead-letter
   topic: one poison message retried endlessly.
3. **Handlers only got the payload.** No message id, key or properties, so they couldn't dedupe
   and had nowhere to receive trace context.

## What changed

| Area | Change |
| ---- | ------ |
| `PulsarClient.createConsumer` | Takes `ConsumerOptions` (`subscription`, `subscriptionType`, `maxRedeliverCount`, `nackRedeliverDelayMs`) |
| Defaults | Subscription `jobber` (existing job consumers keep their cursor), type `Shared`, 5 s redelivery delay, 5 redeliveries, then `<topic>-<subscription>-DLQ` |
| `PulsarConsumer.onMessage(data, meta)` | `meta` = message id, partition key, properties, redelivery count |
| `NonRetryableError` | Thrown by a handler → straight to the DLQ, no retries |
| `send(producer, data, { key, properties, sequenceId })` | Helper for producers; `createProducer(topic, { producerName })` |
| Shutdown | Consumers are now closed on module destroy |
| `FibonacciMessage` | `iterations` is an integer between 1 and 1,000 |

## How it works

The consumer's message handling, in order:

1. Parse the JSON. If it can't be parsed, publish the raw bytes to the dead-letter topic and ack
   the original.
2. Call `onMessage(data, meta)`.
   - It succeeded → acknowledge.
   - It threw `NonRetryableError` → dead-letter it and ack.
   - It threw anything else → `negativeAcknowledge`. Pulsar redelivers after 5 s, and after 5
     redeliveries it moves the message to the DLQ itself (`deadLetterPolicy`).
3. If publishing to the DLQ fails, the message is nacked instead, so it is never dropped.
4. The ack is outside the handler's `try`: if only the ack fails, the work is done and must not be
   nacked into a second run. Pulsar may still redeliver an unacked message, so **handlers must
   tolerate repeats** (step 3 makes the job handlers do that).

Dead-letter policies only work on `Shared` and `Key_Shared` subscriptions, so the client adds
the policy only for those types.

## How it was verified

- 15 unit tests (consumer paths, client config, the `send` helper).
- Against the real broker:
  - the executor subscribed with the new options and the broker reported the `jobber`
    subscription as `Shared` with its cursor kept;
  - three invalid-JSON messages were dead-lettered at once;
  - a message for a nonexistent job failed on delivery 1, was retried 5 times, and Pulsar moved
    it to `Fibonacci-jobber-DLQ`, leaving the backlog at 0.

## Lessons

- **A queued 1,000,000-iteration Fibonacci job froze the executor.** It's computed synchronously
  with big integers, so the event loop blocked for minutes, the HTTP port stopped answering, and
  every message behind it stalled. This was already true on `main`. The cap is now 1,000
  iterations: measured, 1,000 takes about 30 ms and 10,000 about 9 s. The stuck message was
  skipped with `pulsar-admin topics skip` and job #24 marked `FAILED`.
- Switching an existing subscription from Exclusive to Shared works only after every Exclusive
  consumer has disconnected, so restart all executors together.
- `pulsar-client produce -m` splits on commas; use `--separator`.

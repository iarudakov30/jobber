# Phase 1 — step by step

Phase 1 made jobber's existing messaging and jobs framework safe enough to build a payments system
on, and started the React app. Every step below follows the same pattern:

1. **Why:** the concrete problem in the code as it was.
2. **What changed:** files and behaviour.
3. **How it works:** the logic, so you can rebuild it.
4. **How it was verified:** the exact checks run against real services, with results.
5. **Lessons:** what went wrong or surprised us along the way.

| Step | Problem it removes | Doc |
| ---- | ------------------ | --- |
| React app | No NexusPay frontend yet | [00-react-app.md](00-react-app.md) |
| 1. Pulsar consumer | A failing message was retried forever; two services couldn't share a topic; handlers couldn't dedupe | [01-pulsar-consumer.md](01-pulsar-consumer.md) |
| 2. Outbox | A crash between "create job" and "send messages" left a job that never finished | [02-outbox.md](02-outbox.md) |
| 3. Idempotent acks | A redelivered message was counted twice; `LoadProducts` inserted duplicates | [03-idempotent-acks.md](03-idempotent-acks.md) |
| 4. Tracing + infra | No way to follow one job across services; outbox resends not deduplicated | [04-tracing-infra.md](04-tracing-infra.md) |

How the pieces fit together after phase 1, for one job:

```mermaid
sequenceDiagram
  participant C as Client
  participant J as jobs
  participant DB as jobs DB
  participant P as Pulsar
  participant E as executor
  participant PR as products
  C->>J: executeJob (GraphQL, cookie checked via auth gRPC)
  J->>DB: one tx: insert Job + one outbox row per item (with traceparent)
  J-->>C: job id (IN_PROGRESS)
  J->>P: relay publishes outbox rows (sequenceId = outbox id; broker drops resends)
  P->>E: Shared subscription "jobber", consumer span continues the trace
  E->>PR: execute (e.g. CreateProduct with sourceRef job:{id}:{index}, duplicate ignored)
  E->>J: Acknowledge({jobId, index}) over gRPC
  J->>DB: one statement: insert JobItem (dupe = no-op) + bump completed / COMPLETED
  Note over E,P: failure → nack, retried every 5 s, after 5 redeliveries → {topic}-jobber-DLQ
```

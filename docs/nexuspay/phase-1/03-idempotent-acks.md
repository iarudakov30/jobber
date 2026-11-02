# Step 3 — Count each job item once

- **Branch:** `feature/idempotent-job-acks` (commit `a59cac2`), on top of step 2.

## Why

Step 1 made redeliveries a normal, expected event. Two places in the job pipeline weren't ready for
that:

1. **`JobsService.acknowledge(jobId)` incremented `completed` on every call.** A redelivered
   message counted twice, so `completed` could pass `size` and the job never reached `COMPLETED`.
2. **`LoadProducts` inserted a product per message.** A redelivery inserted a duplicate.

The same two ideas, "count once" and "apply the side effect once", are what will later keep
a wallet from being credited twice.

## What changed

| Area | Change |
| ---- | ------ |
| Messages | Every job message carries its item `index` (set by `AbstractJob`) |
| `jobs.proto` | `AcknowledgeRequest { jobId, index }` |
| jobs DB | New `JobItem (jobId, index)` table, primary key on both |
| `JobsService.acknowledge(jobId, index)` | One SQL statement; repeat = no-op; unknown job or out-of-range index rejected |
| `products.proto` / products DB | `sourceRef` on `CreateProductRequest`; `products.source_ref` unique |
| `LoadProductsConsumer` | Sends `sourceRef = job:<jobId>:<index>`; products inserts with `ON CONFLICT DO NOTHING` |
| Executor | `FAULT_ACK_FAILURES=<n>` test hook |

## How it works

The acknowledgement is a single statement, so the insert, the count and the `COMPLETED`
transition can't race:

```sql
WITH acked AS (
  INSERT INTO "JobItem" ("jobId", "index")
  SELECT id, $index FROM "Job" WHERE id = $jobId AND $index >= 0 AND $index < size
  ON CONFLICT DO NOTHING          -- second ack of the same item inserts nothing
  RETURNING 1
)
UPDATE "Job" SET
  completed = completed + (SELECT count(*) FROM acked),
  status = CASE WHEN status = 'IN_PROGRESS' AND completed + (SELECT count(*) FROM acked) = size
                THEN 'COMPLETED' ELSE status END,
  ended  = CASE WHEN … same condition … THEN now() ELSE ended END
WHERE id = $jobId
RETURNING id, size, completed, status;
```

- In a `SET` clause, `completed` is the row's value *before* the update, which is why the
  expression works.
- Concurrent acks for different items serialise on the `Job` row lock. Concurrent acks for the
  same item hit the primary key, and one of them inserts nothing.
- `JobItem` rows are created **when an item is acknowledged**, not when the job is created. The
  spec suggested pre-creating them, but inserting on ack gives the same guarantee without writing up
  to 10,000 extra rows in the job-creation transaction.
- An earlier draft updated the `Job` row twice in one statement (two CTEs). PostgreSQL applies
  only one of those updates, so it was replaced with the single `UPDATE` above.

**Test hook:** with `FAULT_ACK_FAILURES=3`, the executor throws right after `execute` for its
first 3 messages. The work is done but not acknowledged, so Pulsar redelivers them, which is the
exact situation this step protects against.

## How it was verified

- 12 job tests, including 3 for `acknowledge` (single statement, unknown job, out-of-range
  index); all touched projects lint, test and build.
- **Forced redelivery:** a 10-product `LoadProducts` job with `FAULT_ACK_FAILURES=3`. Items 0–2
  were redelivered and their products inserted twice, yet the job ended `COMPLETED` 10/10 with 10
  `JobItem` rows and exactly 10 new products.
- **Repeated acks over gRPC:** acknowledging items 0 and 9 again left the job at 10/10. Index 10
  and an unknown job were both rejected. They arrive as gRPC "Internal server error", which is how
  this Nest setup maps `BadRequestException` over gRPC.

## Lessons

- **`npx nx run grpc:generate-ts-proto` can't run on the Windows dev machine:** `protoc.exe` fails
  with a missing DLL (`0xC0000135`). The types were regenerated in a Linux container with the
  same `ts-proto`/`grpc-tools` versions; the output differed only by the two new fields. The
  command is in the [repo guide](../02-repo-guide.md#gotchas-learned-the-hard-way). Mount the folder
  at `/work`: mounting it at `/lib` hides the container's system libraries and nothing starts.
- Three jobs created before this change are still `IN_PROGRESS` and won't finish on their own.
  Messages published before the change have no `index`.

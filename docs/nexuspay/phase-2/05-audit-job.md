# Step 5 — Nightly ledger audit

- **Where:** committed directly to `main`.

## Why

The database triggers stop a bad posting from being written. Nothing yet noticed the books going
wrong some other way: a manual SQL fix, a bug in a future migration, a restore that lost entries.
The audit recomputes every balance from its entries and checks every transaction's sums. Step 3
added it as gRPC `RunAudit`; this step runs it every night through the existing job pipeline, so
it is visible like any other job: a `Job` row, a trace in Jaeger and an `executor` log line.

## What changed

| Area          | Change                                                                                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/nestjs` | `Jobs.LEDGER_AUDIT = 'LedgerAudit'`                                                                                                                                                           |
| `libs/pulsar` | `LedgerAuditMessage` (`trigger?: 'schedule' \| 'manual'`)                                                                                                                                     |
| `jobs`        | `LedgerAuditJob` (`@Job`); `LedgerAuditScheduler` (cron `0 3 * * *` UTC, `LEDGER_AUDIT_CRON` to change it or `off`); `ScheduleModule.forRoot()`; dependencies `@nestjs/schedule` 12, `cron` 4 |
| `executor`    | `LedgerAuditConsumer` (topic `LedgerAudit`) calling `WalletService.RunAudit`; wallet gRPC client (`WALLET_GRPC_SERVICE_URL` in `apps/executor/.env`)                                          |
| Tests         | 8 in `jobs` (job validation, schedule, failure handling), 3 in `executor` (no issues, issues, wallet down)                                                                                    |

## How it works

```
03:00 UTC  jobs: LedgerAuditScheduler (cron, span "ledger-audit schedule")
             → JobsService.executeJob('LedgerAudit', { trigger: 'schedule' })
             → Job row + outbox record, one transaction  →  Pulsar topic LedgerAudit
           executor: LedgerAuditConsumer
             → wallet gRPC RunAudit  →  LedgerService.audit()
             → log "no issues", or one ERROR line per issue
             → Acknowledge → Job COMPLETED
```

- **Same path as every job.** The scheduler only calls `executeJob`. The run gets a `Job` row (it
  shows in the Angular console and in `jobs { … }`), at-least-once delivery, the DLQ after 5
  failed deliveries, and a trace: the cron tick starts a span, so the `Job` has a `traceId`.
- **Issues are findings, not failures.** The consumer logs them at ERROR level and the job still
  completes. A failed `RunAudit` call (wallet down) throws, so Pulsar redelivers it. That's safe
  because the audit only reads.
- **Starting it by hand:** `executeJob(executeJobInput: { name: "LedgerAudit", data: {} })` on
  `jobs` (`trigger` defaults to manual in the log).
- **The schedule:** `LEDGER_AUDIT_CRON` takes any cron expression (UTC), or `off`. Each `jobs`
  replica schedules its own run. With more than one replica the audit runs more than once a
  night, which is harmless and simpler than leader election.

## How it was verified

- `npx nx test jobs`:
  - **Validation:** `{}`, `{ trigger: 'schedule' }` and `{ trigger: 'manual' }` each create a
    one-item job with the expected outbox record; `{ trigger: 'cron' }` is rejected.
  - **Schedule:** the default is `0 3 * * *` with the next run at 03:00 UTC;
    `LEDGER_AUDIT_CRON` overrides it, and `off` registers nothing.
  - **Ticks:** a tick starts `LedgerAudit` with `trigger: 'schedule'`, and a failure to start it
    is logged without breaking the schedule.
- `npx nx test executor`:
  - **Sound books:** "no issues" is logged (including when proto-loader omits the empty
    `issues`).
  - **Issues:** each is logged as an ERROR line, and the job still succeeds.
  - **Wallet unreachable:** the handler throws, so Pulsar redelivers.
- **With real services:** the built `auth`, `wallet`, `jobs` (with `LEDGER_AUDIT_CRON='* * * * *'`)
  and `executor`, plus PostgreSQL, Pulsar and Redis from compose.
  - `jobs` logged "Ledger audit scheduled (* * * * * UTC); next run …22:30:00Z".
  - At 22:30:00 it started job 38. The executor logged "Ledger audit (job 38, schedule): no
    issues" 0.2 s later, and job 38 was `COMPLETED`.
  - **Spec acceptance test 7, through the job:**
    - `UPDATE accounts SET balance = balance + 1` on account 2, then `executeJob` "LedgerAudit"
      over GraphQL as alice.
    - The executor logged exactly one issue: "balance_drift: account 2 (user 19 USD available):
      balance 8751, entries sum to 8750".
    - After the balance was put back, the 22:31 scheduled run (job 40) reported no issues.
  - All three jobs ended `COMPLETED`.
- `npx nx run-many -t lint test build`: all 16 projects green.

## Lessons

- **`@Cron()` takes a fixed string, so it can't come from config.** To make the schedule
  configurable (and testable with a per-minute cron), the scheduler builds a `CronJob` itself at
  bootstrap and registers it with `SchedulerRegistry`. `ScheduleModule` still stops it on
  shutdown.
- **A message class needs at least one class-validator decorator.** Otherwise `validate()`
  (`forbidUnknownValues`) rejects every payload. The optional `trigger` field serves both
  purposes: the log says who started the audit.
- **Empty repeated gRPC fields can arrive as `undefined`** (proto-loader without
  `arrays: true`), so the consumer reads `issues = []` by default.

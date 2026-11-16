# Phase 2 — step by step

Phase 2 builds the double-entry ledger in `apps/wallet` and the first React money screens. The
plan (scope, design, tasks, acceptance tests) is the "2. Ledger core + React shell" tab of the
[spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko). Each step follows the phase 1 pattern:
why, what changed, how it works, how it was verified, lessons.

From phase 2 on, work is committed straight to `main` (no feature branches).

| Step                  | Delivers                                                                                                                                  | Doc                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1. Ledger core        | `apps/wallet` (3004), ledger schema and triggers, `LedgerService.post`, `ensureAccounts`; spec acceptance test 1                          | [01-ledger.md](01-ledger.md)               |
| 2. Contracts and libs | `libs/money`, `wallet.proto` + `FindUserByEmail`, `DrizzleOutboxStore`                                                                    | [02-contracts.md](02-contracts.md)         |
| 3. Wallet API         | GraphQL `balances` / `entries` / `transfer`, gRPC `WalletService` (incl. `RunAudit`), outbox relay, `wallet:seed`; spec acceptance test 7 | [03-wallet-api.md](03-wallet-api.md)       |
| 4. Idempotency        | `libs/idempotency` (`@Idempotent()`, PostgreSQL row + Redis lock), k6 load tests; spec acceptance tests 2–6                               | [04-idempotency.md](04-idempotency.md)     |
| 5. Audit job          | `LedgerAudit` job in jobs (nightly, `@nestjs/schedule`) + executor consumer calling `RunAudit`; spec acceptance test 7 through the job    | [05-audit-job.md](05-audit-job.md)         |
| 6. React screens      | Wallet and Send pages, GraphQL Codegen, MSW tests, Playwright (`nexus-e2e`); spec acceptance tests 9–11                                   | [06-react-screens.md](06-react-screens.md) |

The steps after 1 are a proposed order, not part of the spec; adjust as they're built.

**Phase 2 is done.** All eleven spec acceptance tests pass. Test 1 is the ledger tests (step 1);
tests 2–6 are the k6 runs (step 4); test 7 is the audit (steps 3 and 5); test 8 is `libs/money`
(step 2); tests 9–11 are Playwright, the codegen CI check and the full build (step 6). Not done as
specified: `shadcn/ui init` (see step 6).

# Phase 2 — step by step

Phase 2 builds the double-entry ledger in `apps/wallet` and the first React money screens. The
plan (scope, design, tasks, acceptance tests) is the "2. Ledger core + React shell" tab of the
[spec](https://claude.ai/artifact/4YUyyamSZtgiVJcjZYsBko). Each step follows the phase 1 pattern:
why, what changed, how it works, how it was verified, lessons.

From phase 2 on, work is committed straight to `main` (no feature branches).

| Step                  | Delivers                                                                                                                                  | Doc                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 1. Ledger core        | `apps/wallet` (3004), ledger schema and triggers, `LedgerService.post`, `ensureAccounts`; spec acceptance test 1                          | [01-ledger.md](01-ledger.md)         |
| 2. Contracts and libs | `libs/money`, `wallet.proto` + `FindUserByEmail`, `DrizzleOutboxStore`                                                                    | [02-contracts.md](02-contracts.md)   |
| 3. Wallet API         | GraphQL `balances` / `entries` / `transfer`, gRPC `WalletService` (incl. `RunAudit`), outbox relay, `wallet:seed`; spec acceptance test 7 | [03-wallet-api.md](03-wallet-api.md) |
| 4. Idempotency        | `libs/idempotency` (`@Idempotent()`, PostgreSQL row + Redis lock), k6 load tests                                                          | Next                                 |
| 5. Audit job          | `LedgerAudit` job in jobs (nightly) + executor consumer calling `RunAudit`                                                                | Planned                              |
| 6. React screens      | Wallet and Send pages, GraphQL Codegen, Playwright                                                                                        | Planned                              |

The steps after 1 are a proposed order, not part of the spec; adjust as they're built.

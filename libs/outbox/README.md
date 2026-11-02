# outbox

Transactional outbox: write messages in the same database transaction as the state change, and let `OutboxRelay` publish them afterwards. See `src/lib/outbox.types.ts` for the table every app must create.

Run `nx test outbox` to execute the unit tests via [Jest](https://jestjs.io).

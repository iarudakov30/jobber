# Step 4 — Idempotency

- **Where:** committed directly to `main`.

## Why

A client that sends a transfer and gets no answer (timeout, dropped connection, double click) has
to retry. Before this step, a retry was a second transfer. With an `Idempotency-Key` header, a
retry gets the first answer instead. The same key with a different request is refused. This step
also runs the spec's load tests against the real services, so the guarantees from steps 1–3 are
shown over HTTP rather than only in-process.

## What changed

| Area                     | Change                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `libs/idempotency` (new) | `@Idempotent()` + `IdempotencyInterceptor` (GraphQL and HTTP), `@IdempotencyKey()`, `DrizzleIdempotencyStore`, `idempotencyKeysTable()` (also at `@jobber/idempotency/table`), `RedisIdempotencyLock` (ioredis 6), `IdempotencyCleanup`; 21 tests |
| `apps/wallet`            | `transfer` is `@Idempotent({ operation: 'transfer' })`; migration `0003_idempotency_keys`; `REDIS_URL`; ledger `externalRef = transfer:<userId>:<key>`; transfer terms stored in the transaction's `metadata`                                     |
| Load tests               | `apps/wallet/load/{overdraft,deadlock,same-key}.js` (k6), run in Docker by `npx nx run wallet:load-test <name>` (`scripts/k6.mjs`, `grafana/k6:1.4.2`)                                                                                            |
| Tests                    | `wallet.api.spec.ts` now also starts a Redis container; 8 idempotency tests (51 wallet tests in all)                                                                                                                                              |

## How it works

### One request

```
Idempotency-Key: 3f6c…            scope = <userId>:transfer:<key>
                                  hash  = SHA-256(canonical JSON of the GraphQL args)
1. key missing or malformed     → 400 BAD_REQUEST
2. Redis SET idem:<scope> NX PX 30000
     taken                      → 409 CONFLICT ("still in progress")
     Redis down                 → skip (logged once), PostgreSQL alone decides
3. PostgreSQL claim (idempotency_keys)
     new key                    → claimed (in_progress, lease 30 s)
     other hash                 → 422 UNPROCESSABLE_ENTITY
     completed, same hash       → stored response, header Idempotent-Replayed: true
     in progress, lease running → 409 CONFLICT
     in progress, lease expired → taken over (claimed)
4. run the handler
     success → store the response (completed, expires in 24 h)
     failure → delete the claim, so the same key can be retried
5. release the Redis key (compare-and-delete: only if it's still ours)
```

Each PostgreSQL decision is one atomic statement: `INSERT … ON CONFLICT DO NOTHING`, or an
`UPDATE … WHERE status = 'in_progress' AND locked_until <= now()` for a takeover. Two requests
can't both win, with or without Redis.

- **Errors:** GraphQL errors carry explicit codes (`BAD_REQUEST`, `CONFLICT`,
  `UNPROCESSABLE_ENTITY`) and `extensions.status`. Nest's Apollo driver maps only some HTTP
  statuses to codes and would report a 409 as `INTERNAL_SERVER_ERROR`. HTTP handlers get the
  plain status codes.
- **Stored responses** are JSON with tagged `bigint` and `Date` values (`{"$bigint":"1250"}`), so
  a replay passes the same values through the `MinorUnits` scalar as the original did.

### The crash gap, closed in the ledger

The key and the ledger posting are committed in different transactions. If the process dies
after the ledger commit but before the response is stored, the claim stays `in_progress`. Once
its lease expires, a retry takes it over and runs `transfer` again. The second run is harmless:

- The ledger `externalRef` is `transfer:<userId>:<key>`, so the second `post()` hits the
  `(type, external_ref)` unique index and returns the first transaction (`duplicate: true`).
- On a duplicate, `transfer` compares the stored terms (`metadata`: from, to, asset, amount) with
  the request. The same terms return the original transfer. Different terms (a key reused after
  its 24 h response expired) are refused with "Idempotency-Key was already used for a different
  transfer".

### Redis is only a fast path

`RedisIdempotencyLock` runs with no offline queue and no per-command retries. While Redis is down,
`SET` fails at once instead of waiting, requests go straight to PostgreSQL, and the client
reconnects in the background. The lock logs "Redis unavailable …" once and "Redis is back" when
it returns.

### Expiry

`IdempotencyCleanup` deletes keys past `expires_at` every hour. It also deletes claims still
`in_progress` a day after they were created. A completed key past its TTL that hasn't been deleted
yet is treated as new.

## How it was verified

- **`npx nx test idempotency`** (21 tests, Testcontainers PostgreSQL and Redis):
  - **Store:**
    - claim, mismatch, replay and release
    - a lease takeover gives the key to exactly 1 of 10 concurrent retries
    - a new key goes to exactly 1 of 20 concurrent claims
    - a key past its TTL is reused, and cleanup deletes it
  - **Interceptor on an HTTP controller:**
    - a missing or malformed key gets 400
    - a retry gets the same body with `Idempotent-Replayed: true`, and the handler runs once
    - a different body gets 422
    - after a failed handler, the same key can be retried
    - 20 simultaneous requests run the handler once (the rest get 409 or the replay), with or
      without the lock
  - **Redis lock:**
    - only the holder can release
    - the TTL frees the key
    - an unreachable Redis returns `unavailable` in under 500 ms
- **`npx nx test wallet`** (51 tests): eight new idempotency tests over HTTP with real Redis:
  - **Keys:** no key gets `BAD_REQUEST`; a retry returns the identical response.
  - **Concurrency:** 50 parallel requests with one key make one transfer (spec test 4), with
    Redis up and with it reporting unavailable (spec test 6).
  - **Reuse:** the same key with a different amount gets `UNPROCESSABLE_ENTITY` (spec test 5).
  - **Refusals:** a refused overdraft can be retried with the same key after funding.
  - **Crash gap:** a simulated crash (claim set back to an expired `in_progress`) posts once and
    returns the first transfer. A key reused for a different transfer after expiry is refused.
- **k6 against the built `auth` and `wallet`**, with PostgreSQL and Redis from compose and k6 in
  Docker:

| Spec test                  | Script                                       | Result                                                                                               |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2. No overdraft under load | `overdraft` (200 VUs, $1 each from $100)     | 100 succeeded, 100 refused (insufficient funds), 0 other; A = 0, B = $100.00; `RunAudit`: no issues  |
| 3. Deadlock-free           | `deadlock` (100 VUs each way)                | 200 of 200 succeeded; both back at $100.00; no issues                                                |
| 4. Same key in parallel    | `same-key` (50 VUs, one key)                 | 1 transfer, 49 `CONFLICT`; B = $1.00                                                                 |
| 5. Key reuse, new body     | `same-key` teardown                          | `UNPROCESSABLE_ENTITY`; still one transfer                                                           |
| 6. Redis down              | `docker compose stop redis`, then `same-key` | 1 transfer, 49 `CONFLICT`; the wallet logged "Redis unavailable", then "Redis is back" after `start` |

- `npx nx run-many -t lint test build`: all 16 projects green.

## Lessons

- **drizzle-kit loads schema files with esbuild, which can't compile parameter decorators.**
  Importing `idempotencyKeysTable` from `@jobber/idempotency` pulled in the interceptor and
  failed. Nx still reported `generate-drizzle` as successful. The table factory now lives in a
  decorator-free file with its own path, `@jobber/idempotency/table`.
- **A lost Redis connection may never emit `error`.** Docker Desktop's port proxy accepts the TCP
  connection and then drops it, so ioredis emits only `close` and `reconnecting`. The lock treats
  `close` as down too (except during its own shutdown).
- **A test module's `useValue` is read when the class is declared,** before `beforeAll` runs, so
  it captured `undefined`. Use `useFactory: () => store` for anything created in `beforeAll`.
- **The 200-VU runs take about 2 s per request.** Every transfer queues for one of the wallet's 10
  pool connections and the same two account rows. That's expected for a hot pair of accounts, and
  it's the case the row locks exist for.
- **Git Bash heredocs broke on long scripts** with mixed quotes ("unexpected EOF while looking for
  matching `''`"). Writing the files directly avoided it.

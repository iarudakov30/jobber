# idempotency

`@Idempotent()` for NestJS GraphQL resolvers and HTTP handlers: a request carrying an
`Idempotency-Key` header runs at most once per key, and a retry gets the stored response.
PostgreSQL holds the guarantee (`DrizzleIdempotencyStore`, table from `idempotencyKeysTable()`);
Redis (`RedisIdempotencyLock`) only turns concurrent duplicates away early.

Run `nx test idempotency` to execute the tests (Docker required: Testcontainers).

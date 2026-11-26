// The decorator-free entry point: drizzle-kit can't load the full library (see the table file).
import { idempotencyKeysTable } from '@jobber/idempotency/table';

/** Keys of `@Idempotent()` requests (placeOrder), managed by `DrizzleIdempotencyStore`. */
export const idempotencyKeys = idempotencyKeysTable();

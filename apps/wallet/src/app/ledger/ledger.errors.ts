/** The posting is malformed: it would never be accepted, so retrying won't help. */
export class InvalidPostingError extends Error {
  override readonly name = 'InvalidPostingError';
}

/** A user account would go below zero. Nothing was written. */
export class InsufficientFundsError extends Error {
  override readonly name = 'InsufficientFundsError';

  constructor(readonly accountId: bigint) {
    super(`Insufficient funds in account ${accountId}`);
  }
}

/**
 * Whether `error` (or an error it wraps: Drizzle puts the `pg` error in `cause`) is a
 * PostgreSQL violation of the named constraint.
 */
export function isConstraintViolation(
  error: unknown,
  constraint: string,
): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if ((e as { constraint?: string }).constraint === constraint) {
      return true;
    }
  }
  return false;
}

/** Injection token for the `IdempotencyStore` the interceptor uses. */
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');
/** Injection token for the optional `IdempotencyLock` (Redis fast path). */
export const IDEMPOTENCY_LOCK = Symbol('IDEMPOTENCY_LOCK');

export interface IdempotentOptions {
  /** Part of the key's scope; default `<Class>.<method>`. */
  operation?: string;
  /** How long a claim is exclusive before a retry may take it over. Default 30 s. */
  leaseMs?: number;
  /** How long a completed response is replayed. Default 24 h. */
  ttlMs?: number;
}

export type ClaimResult =
  /** This request owns the key now: run the handler. */
  | { kind: 'claimed' }
  /** The key completed earlier with the same request: return `response`. */
  | { kind: 'replay'; response: string }
  /** The key was used with a different request. */
  | { kind: 'mismatch' }
  /** Another request with this key is running and its lease hasn't expired. */
  | { kind: 'in_progress' };

/** Durable record of keys: the guarantee. */
export interface IdempotencyStore {
  claim(
    scope: string,
    requestHash: string,
    leaseMs: number,
  ): Promise<ClaimResult>;
  /** Stores the handler's response, encoded with `encodeResponse`, for replays. */
  complete(
    scope: string,
    requestHash: string,
    response: string,
    ttlMs: number,
  ): Promise<void>;
  /** Forgets a claim whose handler failed, so the client can retry with the same key. */
  release(scope: string, requestHash: string): Promise<void>;
  /** Deletes expired keys and long-abandoned claims; returns how many. */
  deleteExpired(): Promise<number>;
}

export type LockResult =
  | { status: 'acquired'; token: string }
  | { status: 'taken' }
  /** The lock service is unreachable; carry on without it. */
  | { status: 'unavailable' };

/** A best-effort lock that turns most concurrent duplicates away before they reach the store. */
export interface IdempotencyLock {
  acquire(scope: string, ttlMs: number): Promise<LockResult>;
  release(scope: string, token: string): Promise<void>;
}

/** What the interceptor puts on the request for the handler (`@IdempotencyKey()`). */
export interface IdempotencyRequestContext {
  key: string;
  /** `<userId>:<operation>:<key>` */
  scope: string;
}

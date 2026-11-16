import { Logger, OnApplicationShutdown } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

import { IdempotencyLock, LockResult } from './idempotency.types';

// Deletes the key only if it still holds our token: after our TTL ran out, another request may
// own it.
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * The Redis fast path: `SET idem:<scope> <token> NX PX <ttl>`. It only turns concurrent
 * duplicates away before they reach PostgreSQL; correctness never depends on it. When Redis is
 * down, commands fail at once (no offline queue) and `acquire` reports `unavailable`, so
 * requests carry on with the PostgreSQL row alone while the client reconnects in the background.
 */
export class RedisIdempotencyLock
  implements IdempotencyLock, OnApplicationShutdown
{
  private readonly logger = new Logger(RedisIdempotencyLock.name);
  private reportedDown = false;
  private shuttingDown = false;

  constructor(private readonly redis: Redis) {
    const down = (reason: string) => {
      if (!this.reportedDown && !this.shuttingDown) {
        this.reportedDown = true;
        this.logger.warn(
          `Redis unavailable (${reason}); idempotency runs on PostgreSQL alone until it's back`,
        );
      }
    };
    // A listener is required either way: an unhandled 'error' event would crash the process.
    // A lost connection often shows only as 'close' (Docker Desktop's port proxy accepts the
    // TCP connection, then drops it), so both count.
    redis.on('error', (error: Error) => down(error.message));
    redis.on('close', () => down('connection closed'));
    redis.on('ready', () => {
      if (this.reportedDown) {
        this.logger.log('Redis is back');
      }
      this.reportedDown = false;
    });
  }

  static connect(url: string): RedisIdempotencyLock {
    return new RedisIdempotencyLock(
      new Redis(url, {
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        connectTimeout: 1000,
        retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
      }),
    );
  }

  /** Resolves once connected. For tests and startup checks: requests never wait for Redis. */
  whenReady(): Promise<void> {
    if (this.redis.status === 'ready') {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.redis.once('ready', () => resolve()));
  }

  async acquire(scope: string, ttlMs: number): Promise<LockResult> {
    const token = randomUUID();
    try {
      const set = await this.redis.set(
        `idem:${scope}`,
        token,
        'PX',
        ttlMs,
        'NX',
      );
      return set === 'OK' ? { status: 'acquired', token } : { status: 'taken' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  async release(scope: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE, 1, `idem:${scope}`, token);
    } catch {
      // The key expires on its own.
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.redis.disconnect();
  }
}

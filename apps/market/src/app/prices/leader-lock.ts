import Redis from 'ioredis';

// Extends or deletes the key only while it still holds our id: after our TTL ran out, another
// replica may own it.
const RENEW = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end`;
const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * A lease in Redis: `SET <key> <owner> NX PX <ttl>`, extended while the owner is alive.
 *
 * `held` is measured on our side from the moment each acquire or renew was *sent*. Redis starts
 * the TTL when the command arrives, a little later, so our lease always runs out before the key
 * does. A leader that stalls (GC pause, lost connection) stops considering itself the leader
 * before any other replica can take the key.
 */
export class LeaderLock {
  private leaseUntil = 0;

  constructor(
    private readonly redis: Redis,
    readonly key: string,
    readonly owner: string,
    readonly ttlMs: number,
  ) {}

  /** Takes the lock if it's free, or extends it if we already own it. */
  async acquire(): Promise<boolean> {
    const sent = Date.now();
    const result = await this.redis.set(
      this.key,
      this.owner,
      'PX',
      this.ttlMs,
      'NX',
    );
    if (result === 'OK') {
      this.leaseUntil = sent + this.ttlMs;
      return true;
    }
    return this.renew();
  }

  /** Extends our lease; false (and no longer held) if the key isn't ours anymore. */
  async renew(): Promise<boolean> {
    const sent = Date.now();
    const renewed = await this.redis.eval(
      RENEW,
      1,
      this.key,
      this.owner,
      this.ttlMs,
    );
    this.leaseUntil = renewed === 1 ? sent + this.ttlMs : 0;
    return renewed === 1;
  }

  /** Gives the lock up at once, so another replica doesn't wait for the TTL. */
  async release(): Promise<void> {
    this.leaseUntil = 0;
    await this.redis.eval(RELEASE, 1, this.key, this.owner);
  }

  /** Whether we may act as the leader right now. */
  get held(): boolean {
    return Date.now() < this.leaseUntil;
  }

  /** Milliseconds until the current owner's key expires; negative if there is no key. */
  async expiresInMs(): Promise<number> {
    return this.redis.pttl(this.key);
  }
}

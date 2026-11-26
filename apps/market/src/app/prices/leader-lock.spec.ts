import Redis from 'ioredis';
import { TestRedis, startTestRedis } from '../../testing/test-redis';
import { LeaderLock } from './leader-lock';

let redis: TestRedis;
const clients: Redis[] = [];
let key: string;
let n = 0;

beforeAll(async () => {
  redis = await startTestRedis();
}, 120_000);

afterAll(async () => {
  for (const client of clients) {
    client.disconnect();
  }
  redis?.client.disconnect();
  await redis?.container.stop();
});

beforeEach(() => {
  key = `lock-${++n}`;
});

/** A replica: its own connection, like a separate process. */
function replica(owner: string, ttlMs = 1_000): LeaderLock {
  const client = new Redis(redis.url);
  clients.push(client);
  return new LeaderLock(client, key, owner, ttlMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LeaderLock', () => {
  it('lets exactly one of many replicas take a free lock', async () => {
    const locks = Array.from({ length: 10 }, (_, i) => replica(`r${i}`));
    const won = await Promise.all(locks.map((lock) => lock.acquire()));
    expect(won.filter(Boolean)).toHaveLength(1);
    const leader = locks[won.indexOf(true)];
    expect(leader.held).toBe(true);
    expect(locks.filter((l) => l.held)).toEqual([leader]);
    expect(await redis.client.get(key)).toBe(leader.owner);
  });

  it('renews its own lock and keeps it past the TTL', async () => {
    const a = replica('a', 300);
    const b = replica('b', 300);
    expect(await a.acquire()).toBe(true);
    for (let i = 0; i < 5; i++) {
      await sleep(100);
      expect(await a.renew()).toBe(true);
      expect(await b.acquire()).toBe(false);
    }
    expect(a.held).toBe(true);
  });

  it('acquire succeeds again for the owner (a retry after an unknown outcome)', async () => {
    const a = replica('a');
    expect(await a.acquire()).toBe(true);
    expect(await a.acquire()).toBe(true);
    expect(await redis.client.get(key)).toBe('a');
  });

  it('passes to another replica once the leader stops renewing', async () => {
    const a = replica('a', 300);
    const b = replica('b', 300);
    await a.acquire();
    expect(await b.acquire()).toBe(false);
    const expiresIn = await b.expiresInMs();
    expect(expiresIn).toBeGreaterThan(0);
    expect(expiresIn).toBeLessThanOrEqual(300);

    await sleep(expiresIn + 20);
    // The old leader's lease ran out on its side before the key expired in Redis.
    expect(a.held).toBe(false);
    expect(await b.acquire()).toBe(true);
    // And it can't take it back by renewing.
    expect(await a.renew()).toBe(false);
    expect(a.held).toBe(false);
    expect(await redis.client.get(key)).toBe('b');
  });

  it('release hands the lock over at once, and never deletes someone else’s', async () => {
    const a = replica('a', 10_000);
    const b = replica('b', 10_000);
    await a.acquire();
    await a.release();
    expect(a.held).toBe(false);
    expect(await b.acquire()).toBe(true);

    await a.release(); // a no longer owns it
    expect(await redis.client.get(key)).toBe('b');
  });

  it('a stalled leader considers its lease over no later than Redis does', async () => {
    const a = replica('a', 200);
    await a.acquire();
    const deadline = Date.now() + (await a.expiresInMs());
    while (a.held) {
      await sleep(5);
    }
    // Our side gave up first (or in the same few milliseconds).
    expect(Date.now()).toBeLessThanOrEqual(deadline + 10);
  });
});

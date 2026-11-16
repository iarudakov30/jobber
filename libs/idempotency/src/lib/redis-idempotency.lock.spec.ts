import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { RedisIdempotencyLock } from './redis-idempotency.lock';

let container: StartedTestContainer;
let lock: RedisIdempotencyLock;

beforeAll(async () => {
  container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  lock = RedisIdempotencyLock.connect(
    `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
  );
  await lock.whenReady();
}, 180_000);

afterAll(async () => {
  await lock?.onApplicationShutdown();
  await container?.stop();
});

describe('RedisIdempotencyLock', () => {
  it('lets one holder in at a time, and only the holder release', async () => {
    const first = await lock.acquire('u1:op:k1', 10_000);
    expect(first.status).toBe('acquired');
    expect(await lock.acquire('u1:op:k1', 10_000)).toEqual({ status: 'taken' });

    await lock.release('u1:op:k1', 'not-the-token');
    expect(await lock.acquire('u1:op:k1', 10_000)).toEqual({ status: 'taken' });

    await lock.release('u1:op:k1', (first as { token: string }).token);
    expect((await lock.acquire('u1:op:k1', 10_000)).status).toBe('acquired');
  });

  it('frees the key when its TTL runs out', async () => {
    expect((await lock.acquire('u1:op:short', 50)).status).toBe('acquired');
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect((await lock.acquire('u1:op:short', 50)).status).toBe('acquired');
  });

  it('reports unavailable at once when Redis is unreachable', async () => {
    // Nothing listens on port 1.
    const down = RedisIdempotencyLock.connect('redis://127.0.0.1:1');
    const started = Date.now();

    expect(await down.acquire('u1:op:k', 10_000)).toEqual({
      status: 'unavailable',
    });
    expect(Date.now() - started).toBeLessThan(500);
    await down.release('u1:op:k', 'token'); // doesn't throw either
    await down.onApplicationShutdown();
  });
});

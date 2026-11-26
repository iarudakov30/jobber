import Redis from 'ioredis';
import { GenericContainer, StartedTestContainer } from 'testcontainers';

export interface TestRedis {
  container: StartedTestContainer;
  url: string;
  /** For the test's own reads and writes. */
  client: Redis;
}

/** A Redis 7 in Docker (Testcontainers). */
export async function startTestRedis(): Promise<TestRedis> {
  const container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return { container, url, client: new Redis(url) };
}

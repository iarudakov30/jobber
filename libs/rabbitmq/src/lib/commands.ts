import type { DelayBucketSpec } from './topology';

/**
 * Commands between services (`payment.expire`, `order.expire`): a topic exchange each service
 * binds its own queue to, with its own routing-key prefix.
 */
export const COMMANDS_EXCHANGE = 'commands';

/**
 * Publish a command to one of these, with the command's routing key, to deliver it to
 * `commands` later. Every service that delays commands declares the same buckets: RabbitMQ
 * refuses to redeclare a queue with another TTL, so they live here, in one place.
 */
export const DELAY_BUCKETS: DelayBucketSpec[] = [
  { name: 'delay.1m', ttlMs: 60_000, target: COMMANDS_EXCHANGE },
  { name: 'delay.30m', ttlMs: 30 * 60_000, target: COMMANDS_EXCHANGE },
  { name: 'delay.24h', ttlMs: 24 * 60 * 60_000, target: COMMANDS_EXCHANGE },
];

/** The bucket called `name` among `buckets`; throws on a name that isn't there (a typo in config). */
export function delayBucket(
  name: string,
  buckets: DelayBucketSpec[] = DELAY_BUCKETS,
): DelayBucketSpec {
  const bucket = buckets.find((b) => b.name === name);
  if (!bucket) {
    throw new Error(
      `Unknown delay bucket "${name}": one of ${buckets.map((b) => b.name).join(', ')}`,
    );
  }
  return bucket;
}

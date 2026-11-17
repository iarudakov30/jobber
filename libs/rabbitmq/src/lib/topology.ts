import type { Channel } from 'amqplib';

export interface ExchangeSpec {
  name: string;
  type: 'topic' | 'direct' | 'fanout' | 'headers';
}

export interface BindingSpec {
  exchange: string;
  routingKey: string;
}

export interface RetrySpec {
  /**
   * Wait before each retry. Attempt 2 waits `delaysMs[0]`, attempt 3 `delaysMs[1]`, and so on;
   * attempts past the end of the list reuse the last delay.
   */
  delaysMs: number[];
  /** Attempts in all, the first delivery included. After the last one the message is dead-lettered. */
  maxAttempts: number;
}

export interface QueueSpec {
  name: string;
  bindings: BindingSpec[];
  /** Default `DEFAULT_RETRY`. */
  retry?: RetrySpec;
}

/**
 * A delay bucket: a fanout exchange and a queue of the same name whose messages expire after
 * `ttlMs` and are dead-lettered into `target`. A fanout exchange ignores the routing key but
 * keeps it, so a message published to the bucket with key `payment.expire` reaches `target`
 * with that key once its time is up.
 */
export interface DelayBucketSpec {
  name: string;
  ttlMs: number;
  /** The exchange the messages go to when they expire. */
  target: string;
}

export interface RabbitTopology {
  exchanges?: ExchangeSpec[];
  queues?: QueueSpec[];
  delayBuckets?: DelayBucketSpec[];
}

/** 5 s, 30 s, then 5 min between attempts; dead-lettered after the 5th. */
export const DEFAULT_RETRY: RetrySpec = {
  delaysMs: [5_000, 30_000, 300_000],
  maxAttempts: 5,
};

/** The queue a failed message waits in before going back to `queue`; `n` counts from 1. */
export function retryQueueName(queue: string, n: number): string {
  return `${queue}.retry.${n}`;
}

/** Where `queue`'s messages go after their last attempt, or at once for a non-retryable error. */
export function deadLetterQueueName(queue: string): string {
  return `${queue}.dlq`;
}

const QUORUM = { 'x-queue-type': 'quorum' };

/**
 * Declares everything in `topology`. Safe to repeat (the connection does it on every connect),
 * as long as an existing queue's arguments don't change: RabbitMQ refuses that with
 * PRECONDITION_FAILED, so a new TTL needs a new name.
 *
 * Every queue is a durable quorum queue. On a single local node that only shows the API; quorum
 * queues need three nodes to actually survive one failing.
 */
export async function declareTopology(
  channel: Channel,
  topology: RabbitTopology,
): Promise<void> {
  for (const exchange of topology.exchanges ?? []) {
    await channel.assertExchange(exchange.name, exchange.type, {
      durable: true,
    });
  }

  for (const bucket of topology.delayBuckets ?? []) {
    await channel.assertExchange(bucket.name, 'fanout', { durable: true });
    await channel.assertQueue(bucket.name, {
      durable: true,
      arguments: {
        ...QUORUM,
        'x-message-ttl': bucket.ttlMs,
        // No x-dead-letter-routing-key: the message keeps the key it was published with.
        'x-dead-letter-exchange': bucket.target,
      },
    });
    await channel.bindQueue(bucket.name, bucket.name, '');
  }

  for (const queue of topology.queues ?? []) {
    const { delaysMs, maxAttempts } = queue.retry ?? DEFAULT_RETRY;
    if (maxAttempts < 1 || (maxAttempts > 1 && delaysMs.length === 0)) {
      throw new Error(
        `Queue ${queue.name}: retry needs maxAttempts >= 1 and a delay for each retry`,
      );
    }
    await channel.assertQueue(queue.name, {
      durable: true,
      arguments: QUORUM,
    });
    for (const binding of queue.bindings) {
      await channel.bindQueue(queue.name, binding.exchange, binding.routingKey);
    }
    for (const [i, delayMs] of delaysMs.entries()) {
      // Through the default exchange: the routing key names the queue to go back to.
      await channel.assertQueue(retryQueueName(queue.name, i + 1), {
        durable: true,
        arguments: {
          ...QUORUM,
          'x-message-ttl': delayMs,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue.name,
        },
      });
    }
    await channel.assertQueue(deadLetterQueueName(queue.name), {
      durable: true,
      arguments: QUORUM,
    });
  }
}

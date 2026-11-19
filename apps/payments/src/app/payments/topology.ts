import {
  DEFAULT_RETRY,
  DelayBucketSpec,
  RabbitTopology,
} from '@jobber/rabbitmq';

export const COMMANDS_EXCHANGE = 'commands';
export const PAYMENTS_COMMANDS_QUEUE = 'payments.commands';
/** Routing key of the command that expires an unpaid top-up. Payload `{ paymentId }`. */
export const PAYMENT_EXPIRE = 'payment.expire';

/** Publish a command to one of these (with its own routing key) to deliver it later. */
export const DELAY_BUCKETS: DelayBucketSpec[] = [
  { name: 'delay.1m', ttlMs: 60_000, target: COMMANDS_EXCHANGE },
  { name: 'delay.30m', ttlMs: 30 * 60_000, target: COMMANDS_EXCHANGE },
  { name: 'delay.24h', ttlMs: 24 * 60 * 60_000, target: COMMANDS_EXCHANGE },
];

/**
 * What `payments` declares on every connect: the `commands` exchange, its queue (retries
 * 5 s / 30 s / 5 min, then `payments.commands.dlq`) and the delay buckets.
 */
export function paymentsTopology(
  buckets: DelayBucketSpec[] = DELAY_BUCKETS,
): RabbitTopology {
  return {
    exchanges: [{ name: COMMANDS_EXCHANGE, type: 'topic' }],
    queues: [
      {
        name: PAYMENTS_COMMANDS_QUEUE,
        bindings: [{ exchange: COMMANDS_EXCHANGE, routingKey: 'payment.*' }],
        retry: DEFAULT_RETRY,
      },
    ],
    delayBuckets: buckets,
  };
}

import {
  COMMANDS_EXCHANGE,
  DEFAULT_RETRY,
  DELAY_BUCKETS,
  DelayBucketSpec,
  RabbitTopology,
} from '@jobber/rabbitmq';

// Shared with the market's order.expire: one definition, so both declare the same buckets.
export { COMMANDS_EXCHANGE, DELAY_BUCKETS };

export const PAYMENTS_COMMANDS_QUEUE = 'payments.commands';
/** Routing key of the command that expires an unpaid top-up. Payload `{ paymentId }`. */
export const PAYMENT_EXPIRE = 'payment.expire';

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

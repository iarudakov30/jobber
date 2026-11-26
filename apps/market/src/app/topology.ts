import {
  COMMANDS_EXCHANGE,
  DEFAULT_RETRY,
  DELAY_BUCKETS,
  DelayBucketSpec,
  RabbitTopology,
  mergeTopologies,
  realtimeTopology,
} from '@jobber/rabbitmq';

export const MARKET_COMMANDS_QUEUE = 'market.commands';
/** Expires a limit order that is still open. Payload `{ orderId }`; arrives through a delay bucket. */
export const ORDER_EXPIRE = 'order.expire';

/**
 * What the market declares on every connect: the `realtime` exchange for ticks, the `commands`
 * exchange with `market.commands` (bound to `order.*`; retries 5 s / 30 s / 5 min, then
 * `market.commands.dlq`) and the shared delay buckets.
 */
export function marketTopology(
  buckets: DelayBucketSpec[] = DELAY_BUCKETS,
): RabbitTopology {
  return mergeTopologies(realtimeTopology(), {
    exchanges: [{ name: COMMANDS_EXCHANGE, type: 'topic' }],
    queues: [
      {
        name: MARKET_COMMANDS_QUEUE,
        bindings: [{ exchange: COMMANDS_EXCHANGE, routingKey: 'order.*' }],
        retry: DEFAULT_RETRY,
      },
    ],
    delayBuckets: buckets,
  });
}

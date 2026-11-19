import { IsIn, IsInt, IsUUID, Matches, Min } from 'class-validator';

import { DEFAULT_RETRY, RabbitTopology, RetrySpec } from './topology';

/** Topic exchange for messages to users; the routing key names the channel and the event. */
export const NOTIFICATIONS_EXCHANGE = 'notifications';
/** The email worker's queue (in executor), bound to `email.*`. */
export const EMAIL_QUEUE = 'notifications.email';
/** Routing key of the "your top-up arrived" email. Payload: `TopUpEmailMessage`. */
export const EMAIL_TOPUP = 'email.topup';

/**
 * The notifications part of the topology. Both the publisher (wallet) and the consumer
 * (executor) declare it, so a message published before the worker ever started still has a
 * queue to wait in: a topic exchange drops messages no queue is bound for. Both must pass the
 * same `retry`, because RabbitMQ refuses to redeclare a queue with other arguments.
 */
export function notificationsTopology(
  retry: RetrySpec = DEFAULT_RETRY,
): RabbitTopology {
  return {
    exchanges: [{ name: NOTIFICATIONS_EXCHANGE, type: 'topic' }],
    queues: [
      {
        name: EMAIL_QUEUE,
        bindings: [{ exchange: NOTIFICATIONS_EXCHANGE, routingKey: 'email.*' }],
        retry,
      },
    ],
  };
}

/**
 * Sent by the wallet, in the same transaction as the top-up credit. Only the user id travels:
 * the worker asks `auth` for the address, so it isn't copied into queues and logs.
 */
export class TopUpEmailMessage {
  @IsInt()
  @Min(1)
  userId: number;

  @IsUUID()
  paymentId: string;

  /** Minor units as a decimal string: `"5000"` is $50.00. */
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string',
  })
  amount: string;

  @IsIn(['USD'])
  currency: string;
}

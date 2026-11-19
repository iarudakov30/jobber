import { RabbitPublisher } from '@jobber/rabbitmq';

import { OutboxPublisher, OutboxRecord } from './outbox.types';

/**
 * Publishes outbox records to the RabbitMQ exchange named by `destination`, with `key` as the
 * routing key. For a delayed command, the destination is a delay bucket (`delay.30m`) and the key
 * the command's (`payment.expire`).
 *
 * RabbitMQ has no broker-side deduplication like Pulsar's, so each message carries a stable
 * `messageId` (`outbox-<serviceName>-<id>`): a record the relay resends after a crash arrives
 * with the same id, and consumers that must not repeat work (the email worker) dedupe on it.
 * Messages are persistent and the publish resolves only on the broker's confirm.
 */
export class RabbitOutboxPublisher implements OutboxPublisher {
  readonly transport = 'rabbitmq' as const;

  constructor(
    private readonly rabbitPublisher: RabbitPublisher,
    private readonly serviceName: string,
  ) {}

  async publish(record: OutboxRecord): Promise<void> {
    await this.rabbitPublisher.publish(
      record.destination,
      record.key ?? '',
      record.payload,
      {
        messageId: `outbox-${this.serviceName}-${record.id}`,
        headers: record.headers,
        persistent: true,
      },
    );
  }
}

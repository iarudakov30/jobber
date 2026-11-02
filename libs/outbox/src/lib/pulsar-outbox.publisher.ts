import { PulsarClient, send } from '@jobber/pulsar';

import { OutboxPublisher, OutboxRecord } from './outbox.types';

type Producer = Awaited<ReturnType<PulsarClient['createProducer']>>;

/**
 * Publishes outbox records to the Pulsar topic named by `destination`.
 *
 * Each topic gets one producer named `outbox-<serviceName>-<topic>`, and every message carries
 * its outbox id as `sequenceId`. With broker deduplication enabled, Pulsar then drops a record
 * the relay resends after a crash. Pulsar allows one producer per name, so run a single relay
 * per service (more replicas would need distinct names).
 */
export class PulsarOutboxPublisher implements OutboxPublisher {
  readonly transport = 'pulsar' as const;
  private readonly producers = new Map<string, Promise<Producer>>();

  constructor(
    private readonly pulsarClient: PulsarClient,
    private readonly serviceName: string,
  ) {}

  async publish(record: OutboxRecord): Promise<void> {
    const producer = await this.producer(record.destination);
    await send(producer, record.payload, {
      key: record.key ?? undefined,
      properties: record.headers,
      sequenceId: Number(record.id),
    });
  }

  private producer(topic: string): Promise<Producer> {
    let producer = this.producers.get(topic);
    if (!producer) {
      producer = this.pulsarClient.createProducer(topic, {
        producerName: `outbox-${this.serviceName}-${topic}`,
      });
      // Don't cache a failed connection attempt; the next publish retries it.
      producer.catch(() => this.producers.delete(topic));
      this.producers.set(topic, producer);
    }
    return producer;
  }
}

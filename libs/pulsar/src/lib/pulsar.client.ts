import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Client,
  Consumer,
  Message,
  Producer,
  SubscriptionType,
} from 'pulsar-client';

/** Subscription used when a consumer doesn't name one; job consumers keep their cursor on it. */
export const DEFAULT_SUBSCRIPTION = 'jobber';

export interface ConsumerOptions {
  /** Each consuming service needs its own subscription to receive every message. */
  subscription?: string;
  /** Default `Shared`, so several replicas can consume and a dead-letter topic can be used. */
  subscriptionType?: SubscriptionType;
  /** Redeliveries before Pulsar moves a message to the dead-letter topic. Default 5. */
  maxRedeliverCount?: number;
  /** Delay before a negatively acknowledged message is redelivered. Default 5000 ms. */
  nackRedeliverDelayMs?: number;
}

export interface ProducerOptions {
  /** A fixed name lets the broker deduplicate resends by `sequenceId`. */
  producerName?: string;
}

/** Where `topic` messages go after exhausting their redeliveries on `subscription`. */
export function deadLetterTopic(topic: string, subscription: string): string {
  return `${topic}-${subscription}-DLQ`;
}

@Injectable()
export class PulsarClient implements OnModuleDestroy {
  private readonly client = new Client({
    serviceUrl: this.configService.getOrThrow<string>('PULSAR_SERVICE_URL'),
  });
  private readonly producers: Producer[] = [];
  private readonly consumers: Consumer[] = [];

  constructor(private readonly configService: ConfigService) {}

  async createProducer(topic: string, options: ProducerOptions = {}) {
    const producer = await this.client.createProducer({
      blockIfQueueFull: true,
      topic,
      ...(options.producerName && { producerName: options.producerName }),
    });

    this.producers.push(producer);
    return producer;
  }

  async createConsumer(
    topic: string,
    listener: (message: Message) => void,
    options: ConsumerOptions = {},
  ) {
    const subscription = options.subscription ?? DEFAULT_SUBSCRIPTION;
    const subscriptionType = options.subscriptionType ?? 'Shared';
    const consumer = await this.client.subscribe({
      topic,
      subscription,
      subscriptionType,
      nAckRedeliverTimeoutMs: options.nackRedeliverDelayMs ?? 5000,
      // Pulsar only supports dead-lettering on Shared and Key_Shared subscriptions.
      ...((subscriptionType === 'Shared' ||
        subscriptionType === 'KeyShared') && {
        deadLetterPolicy: {
          deadLetterTopic: deadLetterTopic(topic, subscription),
          maxRedeliverCount: options.maxRedeliverCount ?? 5,
        },
      }),
      listener,
    });
    this.consumers.push(consumer);
    return consumer;
  }

  async onModuleDestroy() {
    for (const consumer of this.consumers) {
      await consumer.close();
    }
    for (const producer of this.producers) {
      await producer.close();
    }

    await this.client.close();
  }
}

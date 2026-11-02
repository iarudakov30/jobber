import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import { Consumer, Message, Producer } from 'pulsar-client';

import { deserialize } from './serialize';
import {
  ConsumerOptions,
  DEFAULT_SUBSCRIPTION,
  PulsarClient,
  deadLetterTopic,
} from './pulsar.client';

export interface MessageMeta {
  messageId: string;
  /** The partition key the producer set, if any. */
  key?: string;
  properties: Record<string, string>;
  /** 0 on the first delivery. */
  redeliveryCount: number;
}

/**
 * Thrown from `onMessage` for a message that can never succeed (invalid data, a business rule
 * it breaks). It goes straight to the dead-letter topic instead of being redelivered.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

export abstract class PulsarConsumer<T> implements OnModuleInit {
  protected readonly logger = new Logger(this.topic);
  private consumer!: Consumer;
  private deadLetterProducer?: Promise<Producer>;

  protected constructor(
    private readonly pulsarClient: PulsarClient,
    private readonly topic: string,
    private readonly options: ConsumerOptions = {},
  ) {}

  async onModuleInit() {
    this.consumer = await this.pulsarClient.createConsumer(
      this.topic,
      this.listener.bind(this),
      this.options,
    );
  }

  protected abstract onMessage(data: T, meta: MessageMeta): Promise<void>;

  /**
   * Handles one message inside a CONSUMER span that continues the producer's trace (from the
   * `traceparent` property), so work done in `onMessage` (gRPC calls, queries) joins it.
   */
  private async listener(message: Message) {
    const meta = messageMeta(message);
    const parent = propagation.extract(ROOT_CONTEXT, meta.properties);
    const span = tracer.startSpan(
      `${this.topic} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'pulsar',
          'messaging.destination.name': this.topic,
          'messaging.message.id': meta.messageId,
          'messaging.pulsar.redelivery_count': meta.redeliveryCount,
        },
      },
      parent,
    );
    try {
      const outcome = await context.with(trace.setSpan(parent, span), () =>
        this.processMessage(message, meta),
      );
      span.setAttribute('messaging.outcome', outcome);
      if (outcome !== 'acked') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
      }
    } finally {
      span.end();
    }
  }

  private async processMessage(
    message: Message,
    meta: MessageMeta,
  ): Promise<Outcome> {
    let data: T;
    try {
      data = deserialize<T>(message.getData());
    } catch (e) {
      return this.deadLetter(message, `Unparseable payload: ${errorText(e)}`);
    }

    try {
      this.logger.debug(`PulsarConsumer: ${JSON.stringify(data)}`);
      await this.onMessage(data, meta);
    } catch (e) {
      if (e instanceof NonRetryableError) {
        return this.deadLetter(message, e.message);
      }
      this.logger.error(
        `Message ${meta.messageId} failed (delivery ${meta.redeliveryCount + 1}): ${errorText(e)}`,
      );
      this.consumer.negativeAcknowledge(message);
      return 'nacked';
    }

    // Outside the try above: if only the ack fails, the work is done and must not be nacked
    // into a second run. Pulsar redelivers unacked messages on reconnect, so handlers must
    // tolerate repeats anyway.
    try {
      await this.consumer.acknowledge(message);
    } catch (e) {
      this.logger.error(`Ack of ${meta.messageId} failed: ${errorText(e)}`);
    }
    return 'acked';
  }

  /** Publishes the message unchanged to the dead-letter topic, then acks the original. */
  private async deadLetter(message: Message, reason: string): Promise<Outcome> {
    const meta = messageMeta(message);
    try {
      this.deadLetterProducer ??= this.pulsarClient.createProducer(
        deadLetterTopic(
          this.topic,
          this.options.subscription ?? DEFAULT_SUBSCRIPTION,
        ),
      );
      const producer = await this.deadLetterProducer;
      await producer.send({
        data: message.getData(),
        properties: {
          ...meta.properties,
          'x-dead-letter-reason': reason,
          'x-original-message-id': meta.messageId,
        },
        ...(meta.key && { partitionKey: meta.key }),
      });
    } catch (e) {
      // Never drop a message we failed to park: let Pulsar redeliver it instead.
      this.deadLetterProducer = undefined;
      this.logger.error(
        `Dead-lettering ${meta.messageId} failed: ${errorText(e)}`,
      );
      this.consumer.negativeAcknowledge(message);
      return 'nacked';
    }
    this.logger.warn(`Message ${meta.messageId} dead-lettered: ${reason}`);
    await this.consumer.acknowledge(message);
    return 'dead-lettered';
  }
}

type Outcome = 'acked' | 'nacked' | 'dead-lettered';

const tracer = trace.getTracer('@jobber/pulsar');

function messageMeta(message: Message): MessageMeta {
  const key = message.getPartitionKey();
  return {
    messageId: message.getMessageId().toString(),
    key: key || undefined,
    properties: message.getProperties(),
    redeliveryCount: message.getRedeliveryCount(),
  };
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

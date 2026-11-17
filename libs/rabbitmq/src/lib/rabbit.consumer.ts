import { Logger, OnModuleInit } from '@nestjs/common';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

import {
  RabbitConnection,
  confirmedPublish,
  errorText,
} from './rabbit.connection';
import { deadLetterQueueName, retryQueueName } from './topology';

export interface RabbitMessageMeta {
  messageId: string;
  /** The key the message was published with, kept through retries and delay buckets. */
  routingKey: string;
  /** String-valued headers (`traceparent`, `x-attempt`, …). */
  headers: Record<string, string>;
  /** 1 on the first delivery. */
  attempt: number;
}

export interface RabbitConsumerOptions {
  /** Unacknowledged messages this consumer holds at once. Default 10. */
  prefetch?: number;
}

/**
 * Thrown from `onMessage` for a message that can never succeed: it goes straight to the
 * dead-letter queue instead of being retried. An error named `NonRetryableError` from another
 * library (`@jobber/pulsar`) counts too.
 */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

/** Headers this library manages; a retry or dead-letter copy sets them afresh. */
export const ATTEMPT_HEADER = 'x-attempt';
export const ROUTING_KEY_HEADER = 'x-original-routing-key';
export const REASON_HEADER = 'x-dead-letter-reason';

/**
 * Consumes one queue of the topology. On a thrown error the message is retried explicitly: a
 * copy goes to `<queue>.retry.<n>` with `x-attempt` raised, the original is acked, and the retry
 * queue's TTL sends the copy back to `<queue>` (5 s, 30 s, 5 min by default). After the last
 * attempt, or at once for `NonRetryableError` or unparseable JSON, the copy goes to `<queue>.dlq`
 * instead. Delivery is at-least-once, so `onMessage` must tolerate repeats.
 */
export abstract class RabbitConsumer<T> implements OnModuleInit {
  protected readonly logger: Logger;

  protected constructor(
    private readonly connection: RabbitConnection,
    private readonly queue: string,
    private readonly options: RabbitConsumerOptions = {},
  ) {
    this.logger = new Logger(queue);
  }

  onModuleInit(): void {
    this.connection.consume(
      this.queue,
      this.options.prefetch ?? 10,
      (message, channel) => this.handle(message, channel),
    );
  }

  protected abstract onMessage(data: T, meta: RabbitMessageMeta): Promise<void>;

  /** Handles one delivery inside a CONSUMER span that continues the publisher's trace. */
  private async handle(
    message: ConsumeMessage,
    channel: ConfirmChannel,
  ): Promise<void> {
    const meta = messageMeta(message);
    const parent = propagation.extract(ROOT_CONTEXT, meta.headers);
    const span = tracer.startSpan(
      `${this.queue} process`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'rabbitmq',
          'messaging.destination.name': this.queue,
          'messaging.message.id': meta.messageId,
          'messaging.rabbitmq.destination.routing_key': meta.routingKey,
          'messaging.rabbitmq.attempt': meta.attempt,
        },
      },
      parent,
    );
    try {
      const outcome = await context.with(trace.setSpan(parent, span), () =>
        this.process(message, channel, meta),
      );
      span.setAttribute('messaging.outcome', outcome);
      if (outcome !== 'acked') {
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome });
      }
    } finally {
      span.end();
    }
  }

  private async process(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    meta: RabbitMessageMeta,
  ): Promise<Outcome> {
    let data: T;
    try {
      data = JSON.parse(message.content.toString());
    } catch (e) {
      return this.forward(message, channel, meta, {
        queue: deadLetterQueueName(this.queue),
        reason: `Unparseable payload: ${errorText(e)}`,
      });
    }

    try {
      await this.onMessage(data, meta);
    } catch (e) {
      const { delaysMs, maxAttempts } = this.connection.retryFor(this.queue);
      if (isNonRetryable(e) || meta.attempt >= maxAttempts) {
        this.logger.error(
          `Message ${meta.messageId} failed on attempt ${meta.attempt}; dead-lettering: ${errorText(e)}`,
        );
        return this.forward(message, channel, meta, {
          queue: deadLetterQueueName(this.queue),
          reason: errorText(e),
        });
      }
      const next = meta.attempt + 1;
      const delay = Math.min(next - 1, delaysMs.length);
      this.logger.warn(
        `Message ${meta.messageId} failed on attempt ${meta.attempt}; retrying in ${delaysMs[delay - 1]} ms: ${errorText(e)}`,
      );
      return this.forward(message, channel, meta, {
        queue: retryQueueName(this.queue, delay),
        attempt: next,
      });
    }

    // Outside the try above: if only the ack fails, the work is done and must not be retried
    // as a failure. The unacked message comes back when the channel reopens, so handlers must
    // tolerate repeats anyway.
    try {
      channel.ack(message);
    } catch (e) {
      this.logger.error(`Ack of ${meta.messageId} failed: ${errorText(e)}`);
    }
    return 'acked';
  }

  /**
   * Publishes a copy to `queue` (a retry queue or the DLQ) through the default exchange, then
   * acks the original. If the copy can't be published, the original is requeued instead, so it
   * is never lost.
   */
  private async forward(
    message: ConsumeMessage,
    channel: ConfirmChannel,
    meta: RabbitMessageMeta,
    to: { queue: string; attempt?: number; reason?: string },
  ): Promise<Outcome> {
    const headers: Record<string, unknown> = {
      ...ownHeaders(message),
      [ROUTING_KEY_HEADER]: meta.routingKey,
      [ATTEMPT_HEADER]: to.attempt ?? meta.attempt,
      ...(to.reason !== undefined && { [REASON_HEADER]: to.reason }),
    };
    try {
      await confirmedPublish(channel, (callback) =>
        channel.sendToQueue(
          to.queue,
          message.content,
          {
            messageId: message.properties.messageId,
            contentType: message.properties.contentType,
            timestamp: message.properties.timestamp,
            persistent: true,
            headers,
          },
          callback,
        ),
      );
    } catch (e) {
      this.logger.error(
        `Moving ${meta.messageId} to ${to.queue} failed; requeueing it: ${errorText(e)}`,
      );
      try {
        channel.nack(message, false, true);
      } catch {
        // The channel is gone; the broker redelivers the unacked message anyway.
      }
      return 'requeued';
    }
    try {
      channel.ack(message);
    } catch (e) {
      this.logger.error(`Ack of ${meta.messageId} failed: ${errorText(e)}`);
    }
    return to.reason !== undefined ? 'dead-lettered' : 'retried';
  }
}

type Outcome = 'acked' | 'retried' | 'dead-lettered' | 'requeued';

const tracer = trace.getTracer('@jobber/rabbitmq');

function messageMeta(message: ConsumeMessage): RabbitMessageMeta {
  const headers = stringHeaders(message.properties.headers ?? {});
  return {
    messageId: String(message.properties.messageId ?? ''),
    routingKey: headers[ROUTING_KEY_HEADER] ?? message.fields.routingKey,
    headers,
    attempt: Math.max(1, Number(headers[ATTEMPT_HEADER]) || 1),
  };
}

/** The message's headers without RabbitMQ's dead-lettering history, which only grows. */
function ownHeaders(message: ConsumeMessage): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(message.properties.headers ?? {}).filter(
      ([name]) =>
        name !== 'x-death' &&
        !name.startsWith('x-first-death-') &&
        !name.startsWith('x-last-death-'),
    ),
  );
}

function stringHeaders(headers: Record<string, unknown>) {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      result[name] = String(value);
    }
  }
  return result;
}

function isNonRetryable(e: unknown): boolean {
  return e instanceof Error && e.name === 'NonRetryableError';
}

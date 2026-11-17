import { Injectable } from '@nestjs/common';
import { context, propagation } from '@opentelemetry/api';

import { RabbitConnection } from './rabbit.connection';

export interface PublishOptions {
  /** Consumers deduplicate by it, so a resend must keep it. */
  messageId: string;
  headers?: Record<string, string>;
  /** Default true: the message survives a broker restart. */
  persistent?: boolean;
  /** Per-message TTL. */
  expirationMs?: number;
}

/**
 * Publishes JSON messages and resolves once the broker has confirmed them. The active trace
 * context goes into the headers (`traceparent`), so the consumer's span joins the trace;
 * explicit `headers` win over it.
 */
@Injectable()
export class RabbitPublisher {
  constructor(private readonly connection: RabbitConnection) {}

  publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
    options: PublishOptions,
  ): Promise<void> {
    const trace: Record<string, string> = {};
    propagation.inject(context.active(), trace);
    return this.connection.publish(
      exchange,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        messageId: options.messageId,
        contentType: 'application/json',
        persistent: options.persistent ?? true,
        timestamp: Math.floor(Date.now() / 1000),
        headers: { ...trace, ...options.headers },
        ...(options.expirationMs !== undefined && {
          expiration: String(options.expirationMs),
        }),
      },
    );
  }
}

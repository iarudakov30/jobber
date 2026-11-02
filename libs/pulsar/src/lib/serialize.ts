import { context, propagation } from '@opentelemetry/api';
import { MessageId, Producer } from 'pulsar-client';

export const serialize = <T>(data: T): Buffer => {
  return Buffer.from(JSON.stringify(data));
};

export const deserialize = <T>(data: Buffer): T => {
  return JSON.parse(data.toString());
};

export interface SendOptions {
  /** Partition key: messages with the same key keep their order on Key_Shared subscriptions. */
  key?: string;
  properties?: Record<string, string>;
  /** With a fixed producer name and broker deduplication on, a repeated id is dropped. */
  sequenceId?: number;
}

/**
 * Sends `data` as JSON. The active trace context (W3C `traceparent`) goes into the properties so
 * the consumer's span joins the producer's trace; explicit `properties` win over it.
 */
export function send<T>(
  producer: Producer,
  data: T,
  options: SendOptions = {},
): Promise<MessageId> {
  const properties = { ...traceHeaders(), ...options.properties };
  return producer.send({
    data: serialize(data),
    ...(options.key && { partitionKey: options.key }),
    ...(Object.keys(properties).length && { properties }),
    ...(options.sequenceId !== undefined && { sequenceId: options.sequenceId }),
  });
}

/** The active trace context as message headers; empty when tracing isn't running. */
export function traceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

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

/** Sends `data` as JSON. */
export function send<T>(
  producer: Producer,
  data: T,
  options: SendOptions = {},
): Promise<MessageId> {
  return producer.send({
    data: serialize(data),
    ...(options.key && { partitionKey: options.key }),
    ...(options.properties && { properties: options.properties }),
    ...(options.sequenceId !== undefined && { sequenceId: options.sequenceId }),
  });
}

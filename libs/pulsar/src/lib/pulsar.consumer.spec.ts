import { Message } from 'pulsar-client';

import { PulsarClient } from './pulsar.client';
import {
  MessageMeta,
  NonRetryableError,
  PulsarConsumer,
} from './pulsar.consumer';
import { serialize } from './serialize';

interface Payload {
  value: number;
}

class TestConsumer extends PulsarConsumer<Payload> {
  readonly handle = jest.fn<Promise<void>, [Payload, MessageMeta]>();

  constructor(client: PulsarClient) {
    super(client, 'Things', { subscription: 'tests' });
  }

  protected onMessage(data: Payload, meta: MessageMeta): Promise<void> {
    return this.handle(data, meta);
  }
}

function fakeMessage(data: Buffer, key = 'user-1'): Message {
  return {
    getData: () => data,
    getMessageId: () => ({ toString: () => '1:2:3' }),
    getPartitionKey: () => key,
    getProperties: () => ({ traceparent: 't' }),
    getRedeliveryCount: () => 0,
  } as unknown as Message;
}

describe('PulsarConsumer', () => {
  let consumer: { acknowledge: jest.Mock; negativeAcknowledge: jest.Mock };
  let deadLetterProducer: { send: jest.Mock };
  let client: { createConsumer: jest.Mock; createProducer: jest.Mock };
  let listener: (message: Message) => Promise<void>;
  let testConsumer: TestConsumer;

  beforeEach(async () => {
    consumer = {
      acknowledge: jest.fn().mockResolvedValue(null),
      negativeAcknowledge: jest.fn(),
    };
    deadLetterProducer = { send: jest.fn().mockResolvedValue({}) };
    client = {
      createConsumer: jest.fn((_topic, l) => {
        listener = l;
        return Promise.resolve(consumer);
      }),
      createProducer: jest.fn().mockResolvedValue(deadLetterProducer),
    };
    testConsumer = new TestConsumer(client as unknown as PulsarClient);
    await testConsumer.onModuleInit();
  });

  it('subscribes with its options', () => {
    expect(client.createConsumer).toHaveBeenCalledWith(
      'Things',
      expect.any(Function),
      { subscription: 'tests' },
    );
  });

  it('passes data and metadata, then acks', async () => {
    testConsumer.handle.mockResolvedValue();
    const message = fakeMessage(serialize({ value: 7 }));

    await listener(message);

    expect(testConsumer.handle).toHaveBeenCalledWith(
      { value: 7 },
      {
        messageId: '1:2:3',
        key: 'user-1',
        properties: { traceparent: 't' },
        redeliveryCount: 0,
      },
    );
    expect(consumer.acknowledge).toHaveBeenCalledWith(message);
    expect(consumer.negativeAcknowledge).not.toHaveBeenCalled();
  });

  it('reports a missing partition key as undefined', async () => {
    testConsumer.handle.mockResolvedValue();

    await listener(fakeMessage(serialize({ value: 1 }), ''));

    expect(testConsumer.handle.mock.calls[0][1].key).toBeUndefined();
  });

  it('nacks a failed message so Pulsar redelivers it', async () => {
    testConsumer.handle.mockRejectedValue(new Error('database down'));
    const message = fakeMessage(serialize({ value: 7 }));

    await listener(message);

    expect(consumer.negativeAcknowledge).toHaveBeenCalledWith(message);
    expect(consumer.acknowledge).not.toHaveBeenCalled();
    expect(deadLetterProducer.send).not.toHaveBeenCalled();
  });

  it('dead-letters a NonRetryableError and acks the original', async () => {
    testConsumer.handle.mockRejectedValue(new NonRetryableError('bad amount'));
    const data = serialize({ value: -1 });
    const message = fakeMessage(data);

    await listener(message);

    expect(client.createProducer).toHaveBeenCalledWith('Things-tests-DLQ');
    expect(deadLetterProducer.send).toHaveBeenCalledWith({
      data,
      properties: {
        traceparent: 't',
        'x-dead-letter-reason': 'bad amount',
        'x-original-message-id': '1:2:3',
      },
      partitionKey: 'user-1',
    });
    expect(consumer.acknowledge).toHaveBeenCalledWith(message);
    expect(consumer.negativeAcknowledge).not.toHaveBeenCalled();
  });

  it('dead-letters an unparseable payload without calling the handler', async () => {
    await listener(fakeMessage(Buffer.from('{not json')));

    expect(testConsumer.handle).not.toHaveBeenCalled();
    expect(deadLetterProducer.send.mock.calls[0][0].properties).toMatchObject({
      'x-dead-letter-reason': expect.stringMatching(/^Unparseable payload/),
    });
    expect(consumer.acknowledge).toHaveBeenCalled();
  });

  it('nacks instead of dropping when the dead-letter publish fails', async () => {
    testConsumer.handle.mockRejectedValue(new NonRetryableError('bad'));
    deadLetterProducer.send.mockRejectedValueOnce(new Error('broker down'));
    const message = fakeMessage(serialize({ value: 1 }));

    await listener(message);

    expect(consumer.negativeAcknowledge).toHaveBeenCalledWith(message);
    expect(consumer.acknowledge).not.toHaveBeenCalled();
  });

  it('reuses one dead-letter producer', async () => {
    testConsumer.handle.mockRejectedValue(new NonRetryableError('bad'));

    await listener(fakeMessage(serialize({ value: 1 })));
    await listener(fakeMessage(serialize({ value: 2 })));

    expect(client.createProducer).toHaveBeenCalledTimes(1);
  });

  it('does not nack when only the ack fails', async () => {
    testConsumer.handle.mockResolvedValue();
    consumer.acknowledge.mockRejectedValueOnce(new Error('connection reset'));

    await listener(fakeMessage(serialize({ value: 1 })));

    expect(consumer.negativeAcknowledge).not.toHaveBeenCalled();
  });
});

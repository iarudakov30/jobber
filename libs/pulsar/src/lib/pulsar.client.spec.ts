import { ConfigService } from '@nestjs/config';
import { Client } from 'pulsar-client';

import { PulsarClient } from './pulsar.client';
import { send } from './serialize';

jest.mock('pulsar-client', () => ({ Client: jest.fn() }));

describe('PulsarClient', () => {
  let native: {
    subscribe: jest.Mock;
    createProducer: jest.Mock;
    close: jest.Mock;
  };
  let pulsarClient: PulsarClient;
  const listener = jest.fn();

  beforeEach(() => {
    native = {
      subscribe: jest.fn().mockResolvedValue({ close: jest.fn() }),
      createProducer: jest.fn().mockResolvedValue({ close: jest.fn() }),
      close: jest.fn(),
    };
    jest.mocked(Client).mockImplementation(() => native as unknown as Client);
    pulsarClient = new PulsarClient({
      getOrThrow: () => 'pulsar://localhost:6650',
    } as unknown as ConfigService);
  });

  it('defaults to the shared jobber subscription with a dead-letter topic', async () => {
    await pulsarClient.createConsumer('Fibonacci', listener);

    expect(native.subscribe).toHaveBeenCalledWith({
      topic: 'Fibonacci',
      subscription: 'jobber',
      subscriptionType: 'Shared',
      nAckRedeliverTimeoutMs: 5000,
      deadLetterPolicy: {
        deadLetterTopic: 'Fibonacci-jobber-DLQ',
        maxRedeliverCount: 5,
      },
      listener,
    });
  });

  it('applies consumer options', async () => {
    await pulsarClient.createConsumer('payment-succeeded', listener, {
      subscription: 'wallet',
      subscriptionType: 'KeyShared',
      maxRedeliverCount: 3,
      nackRedeliverDelayMs: 1000,
    });

    expect(native.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription: 'wallet',
        subscriptionType: 'KeyShared',
        nAckRedeliverTimeoutMs: 1000,
        deadLetterPolicy: {
          deadLetterTopic: 'payment-succeeded-wallet-DLQ',
          maxRedeliverCount: 3,
        },
      }),
    );
  });

  it('skips the dead-letter policy for an Exclusive subscription', async () => {
    await pulsarClient.createConsumer('Things', listener, {
      subscriptionType: 'Exclusive',
    });

    expect(native.subscribe.mock.calls[0][0]).not.toHaveProperty(
      'deadLetterPolicy',
    );
  });

  it('names a producer only when asked', async () => {
    await pulsarClient.createProducer('Things');
    await pulsarClient.createProducer('Things', {
      producerName: 'outbox-jobs',
    });

    expect(native.createProducer.mock.calls[0][0]).not.toHaveProperty(
      'producerName',
    );
    expect(native.createProducer.mock.calls[1][0]).toMatchObject({
      producerName: 'outbox-jobs',
    });
  });

  it('closes consumers, producers and the client on shutdown', async () => {
    const consumer = await pulsarClient.createConsumer('Things', listener);
    const producer = await pulsarClient.createProducer('Things');

    await pulsarClient.onModuleDestroy();

    expect(consumer.close).toHaveBeenCalled();
    expect(producer.close).toHaveBeenCalled();
    expect(native.close).toHaveBeenCalled();
  });
});

describe('send', () => {
  it('serializes and passes only the options given', async () => {
    const producer = { send: jest.fn().mockResolvedValue({}) };

    await send(producer as never, { a: 1 }, { key: 'k', sequenceId: 0 });

    expect(producer.send).toHaveBeenCalledWith({
      data: Buffer.from('{"a":1}'),
      partitionKey: 'k',
      sequenceId: 0,
    });
  });
});

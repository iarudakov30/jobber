import { PulsarClient } from '@jobber/pulsar';

import { PulsarOutboxPublisher } from './pulsar-outbox.publisher';

const record = (id: number, destination = 'Fibonacci') => ({
  id: BigInt(id),
  transport: 'pulsar' as const,
  destination,
  key: '7',
  payload: { iterations: 10, jobId: 7 },
  headers: { traceparent: 't' },
});

describe('PulsarOutboxPublisher', () => {
  let producer: { send: jest.Mock };
  let client: { createProducer: jest.Mock };
  let publisher: PulsarOutboxPublisher;

  beforeEach(() => {
    producer = { send: jest.fn().mockResolvedValue({}) };
    client = { createProducer: jest.fn().mockResolvedValue(producer) };
    publisher = new PulsarOutboxPublisher(
      client as unknown as PulsarClient,
      'jobs',
    );
  });

  it('sends the payload with key, headers and the outbox id as sequenceId', async () => {
    await publisher.publish(record(42));

    expect(client.createProducer).toHaveBeenCalledWith('Fibonacci', {
      producerName: 'outbox-jobs-Fibonacci',
    });
    expect(producer.send).toHaveBeenCalledWith({
      data: Buffer.from('{"iterations":10,"jobId":7}'),
      partitionKey: '7',
      properties: { traceparent: 't' },
      sequenceId: 42,
    });
  });

  it('reuses one producer per topic', async () => {
    await publisher.publish(record(1));
    await publisher.publish(record(2));
    await publisher.publish(record(3, 'LoadProducts'));

    expect(client.createProducer).toHaveBeenCalledTimes(2);
  });

  it('retries producer creation after a failure', async () => {
    client.createProducer.mockRejectedValueOnce(new Error('broker down'));

    await expect(publisher.publish(record(1))).rejects.toThrow('broker down');
    await publisher.publish(record(2));

    expect(client.createProducer).toHaveBeenCalledTimes(2);
    expect(producer.send).toHaveBeenCalledTimes(1);
  });
});

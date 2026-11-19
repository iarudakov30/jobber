import {
  RabbitConnection,
  RabbitConsumer,
  RabbitMessageMeta,
  RabbitPublisher,
  RabbitTopology,
} from '@jobber/rabbitmq';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';

import { OutboxRelay } from './outbox.relay';
import {
  BatchResult,
  NewOutboxRecord,
  OutboxPublisher,
  OutboxRecord,
  OutboxStore,
} from './outbox.types';
import { RabbitOutboxPublisher } from './rabbit-outbox.publisher';

const record = (
  id: number,
  overrides: Partial<OutboxRecord> = {},
): OutboxRecord => ({
  id: BigInt(id),
  transport: 'rabbitmq',
  destination: 'notifications',
  key: 'email.topup',
  payload: { userId: 7, amount: '5000', currency: 'USD' },
  headers: { traceparent: 't' },
  ...overrides,
});

describe('RabbitOutboxPublisher', () => {
  let rabbit: { publish: jest.Mock };
  let publisher: RabbitOutboxPublisher;

  beforeEach(() => {
    rabbit = { publish: jest.fn().mockResolvedValue(undefined) };
    publisher = new RabbitOutboxPublisher(
      rabbit as unknown as RabbitPublisher,
      'wallet',
    );
  });

  it('publishes to the exchange with the key, headers and a stable messageId', async () => {
    await publisher.publish(record(42));

    expect(rabbit.publish).toHaveBeenCalledWith(
      'notifications',
      'email.topup',
      { userId: 7, amount: '5000', currency: 'USD' },
      {
        messageId: 'outbox-wallet-42',
        headers: { traceparent: 't' },
        persistent: true,
      },
    );
  });

  it('uses an empty routing key when the record has none', async () => {
    await publisher.publish(record(1, { key: null }));

    expect(rabbit.publish.mock.calls[0][1]).toBe('');
  });

  it('passes a refused publish on to the relay', async () => {
    rabbit.publish.mockRejectedValue(new Error('NOT_FOUND'));

    await expect(publisher.publish(record(1))).rejects.toThrow('NOT_FOUND');
  });
});

/** Holds records in memory with the store's contract: id order, stop at the first failure. */
class MemoryOutboxStore implements OutboxStore {
  readonly records: (OutboxRecord & { published: boolean })[] = [];

  add(records: NewOutboxRecord[]): void {
    for (const r of records) {
      this.records.push({
        id: BigInt(this.records.length + 1),
        transport: r.transport,
        destination: r.destination,
        key: r.key ?? null,
        payload: r.payload,
        headers: r.headers ?? {},
        published: false,
      });
    }
  }

  async processBatch(
    limit: number,
    publish: (record: OutboxRecord) => Promise<void>,
  ): Promise<BatchResult> {
    let published = 0;
    for (const r of this.records.filter((x) => !x.published).slice(0, limit)) {
      try {
        await publish(r);
      } catch (error) {
        return { published, error };
      }
      r.published = true;
      published++;
    }
    return { published };
  }

  unpublished(): bigint[] {
    return this.records.filter((r) => !r.published).map((r) => r.id);
  }
}

interface Delivery {
  data: unknown;
  meta: RabbitMessageMeta;
}

class CollectingConsumer extends RabbitConsumer<unknown> {
  readonly deliveries: Delivery[] = [];

  constructor(connection: RabbitConnection, queue: string) {
    super(connection, queue);
  }

  protected async onMessage(data: unknown, meta: RabbitMessageMeta) {
    this.deliveries.push({ data, meta });
  }
}

const topology: RabbitTopology = {
  exchanges: [
    { name: 'notifications', type: 'topic' },
    { name: 'commands', type: 'topic' },
  ],
  queues: [
    {
      name: 'notifications.email',
      bindings: [{ exchange: 'notifications', routingKey: 'email.*' }],
    },
    {
      name: 'payments.commands',
      bindings: [{ exchange: 'commands', routingKey: 'payment.*' }],
    },
  ],
  delayBuckets: [{ name: 'delay.test', ttlMs: 500, target: 'commands' }],
};

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

async function until(check: () => boolean, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('OutboxRelay → RabbitMQ (Testcontainers)', () => {
  let container: StartedRabbitMQContainer;
  let connection: RabbitConnection;
  let store: MemoryOutboxStore;
  let relay: OutboxRelay;
  let pulsar: { transport: 'pulsar'; publish: jest.Mock };
  let email: CollectingConsumer;
  let commands: CollectingConsumer;

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4-management').start();
    connection = new RabbitConnection({
      url: container.getAmqpUrl(),
      topology,
      minReconnectDelayMs: 100,
    });
    email = new CollectingConsumer(connection, 'notifications.email');
    commands = new CollectingConsumer(connection, 'payments.commands');
    email.onModuleInit();
    commands.onModuleInit();
    connection.start();
    await connection.whenConnected();
  }, 180_000);

  afterAll(async () => {
    await connection?.stop();
    await container?.stop();
  });

  beforeEach(() => {
    store = new MemoryOutboxStore();
    pulsar = {
      transport: 'pulsar',
      publish: jest.fn().mockResolvedValue(undefined),
    };
    relay = new OutboxRelay(store, [
      pulsar as OutboxPublisher,
      new RabbitOutboxPublisher(new RabbitPublisher(connection), 'wallet'),
    ]);
    email.deliveries.length = 0;
    commands.deliveries.length = 0;
  });

  it('delivers a record with its messageId, routing key and trace header', async () => {
    store.add([
      {
        transport: 'rabbitmq',
        destination: 'notifications',
        key: 'email.topup',
        payload: { userId: 7, amount: '5000', currency: 'USD' },
        headers: { traceparent: TRACEPARENT },
      },
    ]);

    await expect(relay.tick()).resolves.toBe(1);
    await until(() => email.deliveries.length === 1);

    const [{ data, meta }] = email.deliveries;
    expect(data).toEqual({ userId: 7, amount: '5000', currency: 'USD' });
    expect(meta.messageId).toBe('outbox-wallet-1');
    expect(meta.routingKey).toBe('email.topup');
    expect(meta.headers['traceparent']).toBe(TRACEPARENT);
  });

  it('routes each record by transport', async () => {
    store.add([
      {
        transport: 'pulsar',
        destination: 'payment-succeeded',
        key: '7',
        payload: {},
      },
      {
        transport: 'rabbitmq',
        destination: 'notifications',
        key: 'email.topup',
        payload: {},
      },
    ]);

    await expect(relay.tick()).resolves.toBe(2);
    await until(() => email.deliveries.length === 1);

    expect(pulsar.publish).toHaveBeenCalledTimes(1);
    expect(pulsar.publish.mock.calls[0][0].destination).toBe(
      'payment-succeeded',
    );
  });

  it('delays a command through a bucket and keeps its key and messageId', async () => {
    store.add([
      {
        transport: 'rabbitmq',
        destination: 'delay.test',
        key: 'payment.expire',
        payload: { paymentId: 'p1' },
      },
    ]);
    const sent = Date.now();

    await relay.tick();
    await until(() => commands.deliveries.length === 1);

    expect(Date.now() - sent).toBeGreaterThanOrEqual(450);
    const [{ data, meta }] = commands.deliveries;
    expect(data).toEqual({ paymentId: 'p1' });
    expect(meta.routingKey).toBe('payment.expire');
    expect(meta.messageId).toBe('outbox-wallet-1');
  });

  it('keeps a refused record and everything after it until the broker accepts it', async () => {
    store.add([
      {
        transport: 'rabbitmq',
        destination: 'notifications',
        key: 'email.a',
        payload: { n: 1 },
      },
      {
        transport: 'rabbitmq',
        destination: 'late',
        key: 'x',
        payload: { n: 2 },
      },
      {
        transport: 'rabbitmq',
        destination: 'notifications',
        key: 'email.c',
        payload: { n: 3 },
      },
    ]);

    // The `late` exchange doesn't exist yet: the broker refuses it and the relay stops there.
    await expect(relay.tick()).resolves.toBe(-1);
    expect(store.unpublished()).toEqual([2n, 3n]);

    const admin = new RabbitConnection({
      url: container.getAmqpUrl(),
      topology: { exchanges: [{ name: 'late', type: 'fanout' }] },
    });
    admin.start();
    await admin.whenConnected();
    await admin.stop();

    await expect(relay.tick()).resolves.toBe(2);
    expect(store.unpublished()).toEqual([]);
    await until(() => email.deliveries.length === 2);
    expect(email.deliveries.map((d) => d.data)).toEqual([{ n: 1 }, { n: 3 }]);
  });
});

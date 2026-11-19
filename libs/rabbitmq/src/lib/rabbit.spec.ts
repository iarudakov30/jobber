import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { Channel, GetMessage, connect } from 'amqplib';
import { execFile } from 'child_process';
import { join } from 'path';
import { promisify } from 'util';

import { RabbitConnection, RabbitUnavailableError } from './rabbit.connection';
import {
  NonRetryableError,
  RabbitConsumer,
  RabbitMessageMeta,
} from './rabbit.consumer';
import { RabbitModule } from './rabbit.module';
import { RabbitPublisher } from './rabbit.publisher';
import { RabbitTopology } from './topology';

interface Payload {
  id: string;
}

interface Delivery {
  data: Payload;
  meta: RabbitMessageMeta;
  at: number;
}

type Behaviour = (meta: RabbitMessageMeta) => Promise<void>;

/** Records every delivery and runs the behaviour registered for the payload's id. */
class TestConsumer extends RabbitConsumer<Payload> {
  readonly deliveries: Delivery[] = [];
  readonly behaviours = new Map<string, Behaviour>();

  constructor(connection: RabbitConnection, queue: string) {
    super(connection, queue);
  }

  protected async onMessage(data: Payload, meta: RabbitMessageMeta) {
    this.deliveries.push({ data, meta, at: Date.now() });
    await this.behaviours.get(data.id)?.(meta);
  }

  of(id: string) {
    return this.deliveries.filter((d) => d.data.id === id);
  }
}

@Injectable()
class NestConsumer extends RabbitConsumer<Payload> {
  readonly received: string[] = [];

  constructor(connection: RabbitConnection) {
    super(connection, 'nest.queue');
  }

  protected async onMessage(data: Payload) {
    this.received.push(data.id);
  }
}

const topology: RabbitTopology = {
  exchanges: [
    { name: 'notifications', type: 'topic' },
    { name: 'commands', type: 'topic' },
  ],
  queues: [
    {
      name: 'work',
      bindings: [{ exchange: 'notifications', routingKey: 'email.*' }],
      retry: { delaysMs: [300, 600], maxAttempts: 3 },
    },
    {
      name: 'commands.test',
      bindings: [{ exchange: 'commands', routingKey: 'payment.*' }],
    },
    {
      name: 'nest.queue',
      bindings: [{ exchange: 'notifications', routingKey: 'nest.*' }],
    },
  ],
  delayBuckets: [{ name: 'delay.test', ttlMs: 800, target: 'commands' }],
};

const REPLAY_SCRIPT = join(__dirname, '../../scripts/replay.mjs');

describe('RabbitMQ (Testcontainers)', () => {
  let container: StartedRabbitMQContainer;
  let url: string;
  let connection: RabbitConnection;
  let publisher: RabbitPublisher;
  let work: TestConsumer;
  let commands: TestConsumer;

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:4-management')
      // RabbitMQ boots slowly when several projects start one at once (nx affected).
      .withStartupTimeout(120_000)
      .start();
    url = container.getAmqpUrl();
    connection = new RabbitConnection({
      url,
      topology,
      connectionName: 'test',
      minReconnectDelayMs: 100,
    });
    publisher = new RabbitPublisher(connection);
    work = new TestConsumer(connection, 'work');
    commands = new TestConsumer(connection, 'commands.test');
    work.onModuleInit();
    commands.onModuleInit();
    connection.start();
    await connection.whenConnected();
  }, 180_000);

  afterAll(async () => {
    await connection?.stop();
    await container?.stop();
  });

  beforeEach(async () => {
    await withChannel(url, async (channel) => {
      await channel.purgeQueue('work.dlq');
      await channel.purgeQueue('commands.test.dlq');
    });
  });

  it('delivers a message with its id, routing key and headers as attempt 1', async () => {
    await publisher.publish(
      'notifications',
      'email.topup',
      { id: 'plain' },
      {
        messageId: 'm-plain',
        headers: { tenant: 'nexus' },
      },
    );

    const [delivery] = await waitFor(() => work.of('plain'), 1);
    expect(delivery.meta).toMatchObject({
      messageId: 'm-plain',
      routingKey: 'email.topup',
      attempt: 1,
    });
    expect(delivery.meta.headers['tenant']).toBe('nexus');
  });

  it('retries after each configured delay, then dead-letters after the last attempt', async () => {
    work.behaviours.set('always-fails', async () => {
      throw new Error('SMTP refused');
    });

    await publisher.publish(
      'notifications',
      'email.retry',
      { id: 'always-fails' },
      { messageId: 'm-fails' },
    );

    const attempts = await waitFor(() => work.of('always-fails'), 3, 10_000);
    expect(attempts.map((a) => a.meta.attempt)).toEqual([1, 2, 3]);
    expect(attempts.map((a) => a.meta.routingKey)).toEqual([
      'email.retry',
      'email.retry',
      'email.retry',
    ]);
    // The retry queues' TTLs: 300 ms before attempt 2, 600 ms before attempt 3.
    expect(attempts[1].at - attempts[0].at).toBeGreaterThanOrEqual(300);
    expect(attempts[2].at - attempts[1].at).toBeGreaterThanOrEqual(600);
    expect(attempts[2].at - attempts[0].at).toBeLessThan(5_000);

    const parked = await waitForDeadLetter('work.dlq');
    expect(parked.properties.messageId).toBe('m-fails');
    expect(parked.properties.headers).toMatchObject({
      'x-attempt': 3,
      'x-dead-letter-reason': 'SMTP refused',
      'x-original-routing-key': 'email.retry',
    });
    expect(JSON.parse(parked.content.toString())).toEqual({
      id: 'always-fails',
    });

    await sleep(1_000);
    expect(work.of('always-fails')).toHaveLength(3);
  });

  it('a message that fails once succeeds on its retry and is not dead-lettered', async () => {
    work.behaviours.set('flaky', async (meta) => {
      if (meta.attempt === 1) {
        throw new Error('timeout');
      }
    });

    await publisher.publish(
      'notifications',
      'email.flaky',
      { id: 'flaky' },
      { messageId: 'm-flaky' },
    );

    const attempts = await waitFor(() => work.of('flaky'), 2, 5_000);
    expect(attempts[1].meta).toMatchObject({
      attempt: 2,
      routingKey: 'email.flaky',
      messageId: 'm-flaky',
    });
    await sleep(500);
    expect(await countMessages(url, 'work.dlq')).toBe(0);
  });

  it('a NonRetryableError goes straight to the DLQ', async () => {
    work.behaviours.set('poison', async () => {
      throw new NonRetryableError('unknown user 42');
    });

    await publisher.publish(
      'notifications',
      'email.poison',
      { id: 'poison' },
      { messageId: 'm-poison' },
    );

    const parked = await waitForDeadLetter('work.dlq');
    expect(parked.properties.headers).toMatchObject({
      'x-attempt': 1,
      'x-dead-letter-reason': 'unknown user 42',
    });
    expect(work.of('poison')).toHaveLength(1);
  });

  it('dead-letters a message that is not JSON without calling the handler', async () => {
    await connection.publish(
      'notifications',
      'email.garbage',
      Buffer.from('not json'),
      {
        messageId: 'm-garbage',
      },
    );

    const parked = await waitForDeadLetter('work.dlq');
    expect(parked.properties.messageId).toBe('m-garbage');
    expect(String(parked.properties.headers?.['x-dead-letter-reason'])).toMatch(
      /^Unparseable payload/,
    );
  });

  it('a command sent through a delay bucket reaches `commands` after the TTL with its routing key', async () => {
    const sentAt = Date.now();
    await publisher.publish(
      'delay.test',
      'payment.expire',
      { id: 'expire-1' },
      { messageId: 'm-expire-1' },
    );

    const [delivery] = await waitFor(() => commands.of('expire-1'), 1, 5_000);
    expect(delivery.meta.routingKey).toBe('payment.expire');
    expect(delivery.at - sentAt).toBeGreaterThanOrEqual(800);
  });

  it('a publish the broker refuses rejects, and the next publish still goes through', async () => {
    await expect(
      publisher.publish(
        'no-such-exchange',
        'x',
        { id: 'lost' },
        {
          messageId: 'm-lost',
        },
      ),
    ).rejects.toThrow(/NOT_FOUND/);

    await publisher.publish(
      'notifications',
      'email.after',
      { id: 'after-404' },
      { messageId: 'm-after' },
    );
    await waitFor(() => work.of('after-404'), 1);
  });

  it('rejects a publish at once while RabbitMQ is unreachable', async () => {
    const offline = new RabbitConnection({
      url: 'amqp://127.0.0.1:1',
      minReconnectDelayMs: 100,
    });
    offline.start();
    const startedAt = Date.now();
    await expect(
      new RabbitPublisher(offline).publish(
        'notifications',
        'email.x',
        {},
        {
          messageId: 'm-offline',
        },
      ),
    ).rejects.toBeInstanceOf(RabbitUnavailableError);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await offline.stop();
  });

  it('replay moves dead-lettered messages back to the queue as first attempts', async () => {
    let refuse = true;
    work.behaviours.set('replayed', async () => {
      if (refuse) {
        throw new NonRetryableError('mail server misconfigured');
      }
    });
    await publisher.publish(
      'notifications',
      'email.replay',
      { id: 'replayed' },
      { messageId: 'm-replayed' },
    );
    await waitFor(() => work.of('replayed'), 1);
    await waitUntil(async () => (await countMessages(url, 'work.dlq')) === 1);

    refuse = false;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [REPLAY_SCRIPT, '--queue=work'],
      { env: { ...process.env, RABBITMQ_URL: url } },
    );

    expect(stdout).toContain('Moved 1 message(s) from work.dlq to work');
    const attempts = await waitFor(() => work.of('replayed'), 2);
    expect(attempts[1].meta).toMatchObject({
      attempt: 1,
      routingKey: 'email.replay',
      messageId: 'm-replayed',
    });
    expect(await countMessages(url, 'work.dlq')).toBe(0);
  });

  it('RabbitModule connects on init, runs consumers, and disconnects on close', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        RabbitModule.forRootAsync({
          useFactory: () => ({ url, topology, connectionName: 'nest' }),
        }),
      ],
      providers: [NestConsumer],
    }).compile();
    const app = await moduleRef.init();
    const nestConnection = app.get(RabbitConnection);
    await nestConnection.whenConnected();

    await app
      .get(RabbitPublisher)
      .publish(
        'notifications',
        'nest.hello',
        { id: 'via-nest' },
        { messageId: 'm-nest' },
      );
    const consumer = app.get(NestConsumer);
    await waitUntil(async () => consumer.received.includes('via-nest'));

    await app.close();
    expect(nestConnection.isConnected).toBe(false);
  });

  // Last: it drops every connection to the broker.
  it('reconnects after the broker drops the connection, re-declares the topology and consumes again', async () => {
    // Without the re-declaration this exchange (and the queue's binding to it) would stay gone.
    await withChannel(url, (channel) =>
      channel.deleteExchange('notifications'),
    );
    await container.exec([
      'rabbitmqctl',
      'close_all_connections',
      'test: dropped on purpose',
    ]);

    await waitUntil(async () => {
      try {
        await publisher.publish(
          'notifications',
          'email.back',
          { id: 'after-reconnect' },
          { messageId: 'm-back' },
        );
        return true;
      } catch {
        return false;
      }
    }, 15_000);
    await waitFor(() => work.of('after-reconnect'), 1, 5_000);
  });

  async function waitForDeadLetter(queue: string): Promise<GetMessage> {
    let message: GetMessage | false = false;
    await waitUntil(async () => {
      message = await withChannel(url, (channel) =>
        channel.get(queue, { noAck: true }),
      );
      return message !== false;
    }, 5_000);
    return message as unknown as GetMessage;
  }
});

async function withChannel<T>(
  url: string,
  work: (channel: Channel) => Promise<T>,
): Promise<T> {
  const model = await connect(url);
  try {
    const channel = await model.createChannel();
    return await work(channel);
  } finally {
    await model.close();
  }
}

async function countMessages(url: string, queue: string): Promise<number> {
  return withChannel(
    url,
    async (channel) => (await channel.checkQueue(queue)).messageCount,
  );
}

async function waitFor<T>(
  read: () => T[],
  count: number,
  timeoutMs = 3_000,
): Promise<T[]> {
  await waitUntil(async () => read().length >= count, timeoutMs);
  return read();
}

async function waitUntil(
  condition: () => Promise<boolean>,
  timeoutMs = 3_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs} ms`);
    }
    await sleep(50);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

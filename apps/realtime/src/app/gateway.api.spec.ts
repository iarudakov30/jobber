import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { ChannelModel, connect } from 'amqplib';
import { Observable, of, throwError } from 'rxjs';
import { RawData, WebSocket } from 'ws';
import { GrpcStatus, Packages, User } from '@jobber/grpc';
import {
  REALTIME_EXCHANGE,
  RabbitModule,
  realtimeTopology,
} from '@jobber/rabbitmq';
import { GatewayModule } from './gateway/gateway.module';
import {
  DEFAULT_GATEWAY_OPTIONS,
  GATEWAY_OPTIONS,
  GatewayOptions,
  GatewayStats,
} from './gateway/realtime.gateway';
import { RealtimeFeed } from './gateway/realtime-feed';

// The gateway end to end: replicas of the real app against a Testcontainers RabbitMQ, with real
// WebSocket clients (`ws`). Only `auth` is faked: the cookie token-<n> is user n. The test
// publishes to the `realtime` exchange as the market (prices) and the wallet's outbox (user
// messages, messageId outbox-wallet-<id>) do.

const ORIGIN = 'http://localhost:4300';

let rabbit: StartedRabbitMQContainer;
let amqp: ChannelModel;

// ---- auth ----------------------------------------------------------------------------------

let authDown = false;
const fakeAuth = {
  authenticate: ({ token }: { token: string }): Observable<User> => {
    if (authDown) {
      return throwError(() =>
        Object.assign(new Error('14 UNAVAILABLE'), {
          code: GrpcStatus.UNAVAILABLE,
        }),
      );
    }
    const match = /^token-(\d+)$/.exec(token);
    return match
      ? of({ id: Number(match[1]), email: `user${match[1]}@example.com` })
      : throwError(() =>
          Object.assign(new Error('16 UNAUTHENTICATED'), {
            code: GrpcStatus.UNAUTHENTICATED,
          }),
        );
  },
};

// ---- replicas ------------------------------------------------------------------------------

interface Replica {
  name: string;
  app: INestApplication;
  url: string;
  http: string;
}
const replicas: Replica[] = [];

async function startReplica(
  name: string,
  options: Partial<GatewayOptions> = {},
): Promise<Replica> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      RabbitModule.forRoot({
        url: rabbit.getAmqpUrl(),
        topology: realtimeTopology(),
        connectionName: `realtime-${name}`,
        minReconnectDelayMs: 100,
      }),
      GatewayModule,
    ],
  })
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    .overrideProvider(GATEWAY_OPTIONS)
    .useValue({
      ...DEFAULT_GATEWAY_OPTIONS,
      allowedOrigins: [ORIGIN],
      ...options,
    })
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('realtime');
  app.enableShutdownHooks();
  await app.listen(0);
  const http = (await app.getUrl()).replace('[::1]', 'localhost');
  const feed = app.get(RealtimeFeed);
  await waitFor(async () => feed.isReady, 10_000, `${name}'s feed`);
  const replica = {
    name,
    app,
    http,
    url: `${http.replace(/^http/, 'ws')}/realtime`,
  };
  replicas.push(replica);
  return replica;
}

async function stopReplica(replica: Replica): Promise<void> {
  replicas.splice(replicas.indexOf(replica), 1);
  await replica.app.close();
}

beforeAll(async () => {
  rabbit = await new RabbitMQContainer('rabbitmq:4-management')
    // RabbitMQ boots slowly when several projects start one at once (nx affected).
    .withStartupTimeout(120_000)
    .start();
  process.env['AUTH_GRPC_SERVICE_URL'] = 'localhost:1';
  amqp = await connect(rabbit.getAmqpUrl());
  await startReplica('a');
  await startReplica('b');
}, 180_000);

afterAll(async () => {
  for (const client of clients) {
    client.ws.terminate();
  }
  for (const replica of [...replicas]) {
    await replica.app.close().catch(() => undefined);
  }
  await amqp?.close();
  await rabbit?.stop();
});

// ---- clients -------------------------------------------------------------------------------

interface Frame {
  type: string;
  channel?: string;
  seq?: number;
  data?: Record<string, unknown>;
  code?: string;
  userId?: number;
  channels?: string[];
}

const clients: Client[] = [];

class Client {
  readonly frames: Frame[] = [];
  closed?: { code: number; reason: string };

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: RawData) =>
      this.frames.push(JSON.parse(data.toString())),
    );
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
    ws.on('error', () => undefined);
  }

  /** Connects as user `userId` and resolves after the welcome. */
  static async open(
    replica: Replica,
    userId: number,
    options: { autoPong?: boolean } = {},
  ): Promise<Client> {
    const ws = new WebSocket(replica.url, {
      headers: { cookie: `Authentication=token-${userId}`, origin: ORIGIN },
      autoPong: options.autoPong ?? true,
    });
    const client = new Client(ws);
    clients.push(client);
    await client.next((f) => f.type === 'welcome');
    return client;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  async subscribe(channel: string): Promise<void> {
    this.send({ op: 'subscribe', channel });
    await this.next((f) => f.type === 'subscribed' && f.channel === channel);
  }

  /** The first frame (already received or still to come) that matches. */
  next(match: (frame: Frame) => boolean, timeoutMs = 5_000): Promise<Frame> {
    return waitFor(async () => this.frames.find(match), timeoutMs, 'a frame');
  }

  on(channel: string): Frame[] {
    return this.frames.filter(
      (f) => f.type === 'message' && f.channel === channel,
    );
  }

  waitClosed(timeoutMs = 5_000) {
    return waitFor(async () => this.closed, timeoutMs, 'the close');
  }
}

/** The HTTP status the upgrade was refused with. */
function refusedWith(
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('open', () => reject(new Error('the upgrade was accepted')));
    ws.on('error', reject);
  });
}

// ---- publishing, as the market and the wallet's outbox do ----------------------------------

let channelPromise: ReturnType<ChannelModel['createChannel']> | undefined;
async function publish(
  key: string,
  body: unknown,
  messageId?: string,
): Promise<void> {
  channelPromise ??= amqp.createChannel();
  const channel = await channelPromise;
  channel.publish(REALTIME_EXCHANGE, key, Buffer.from(JSON.stringify(body)), {
    messageId,
    contentType: 'application/json',
  });
}

let priceSeq = 0;
const tick = (coin = 'NXC') =>
  publish(`prices.${coin}`, {
    type: 'price',
    coin,
    price: String(4_000 + priceSeq),
    seq: ++priceSeq,
    at: Date.now(),
  });

let outboxId = 1_000;
const userMessage = (userId: number, extra: Record<string, unknown> = {}) =>
  publish(
    `user.${userId}`,
    { type: 'fill', orderId: `o-${outboxId}`, ...extra },
    `outbox-wallet-${++outboxId}`,
  );

/** Which queues `user.<id>` (or any key) is bound to, from the management API. */
async function boundQueues(key: string): Promise<string[]> {
  const port = rabbit.getMappedPort(15672);
  const response = await fetch(
    `http://${rabbit.getHost()}:${port}/api/exchanges/%2F/${REALTIME_EXCHANGE}/bindings/source`,
    {
      headers: {
        authorization: `Basic ${Buffer.from('guest:guest').toString('base64')}`,
      },
    },
  );
  const bindings = (await response.json()) as {
    destination: string;
    routing_key: string;
  }[];
  return bindings
    .filter((b) => b.routing_key === key)
    .map((b) => b.destination)
    .sort();
}

async function stats(replica: Replica): Promise<GatewayStats> {
  return (await (
    await fetch(`${replica.http}/realtime/stats`)
  ).json()) as GatewayStats;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  probe: () => Promise<T | undefined | false>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    }
    await sleep(20);
  }
}

let lastUser = 100;
const newUserId = () => ++lastUser;

// ---- acceptance test 8: auth ---------------------------------------------------------------

describe('auth on the upgrade (acceptance test 8)', () => {
  it('answers 401 without a cookie or with a bad one, before any socket exists', async () => {
    const [a] = replicas;
    expect(await refusedWith(a.url, {})).toBe(401);
    expect(await refusedWith(a.url, { cookie: 'Authentication=forged' })).toBe(
      401,
    );
    expect(await refusedWith(a.url, { cookie: 'other=token-1' })).toBe(401);
    expect((await stats(a)).sockets).toBe(0);
  });

  it('answers 403 to a page on another origin, 404 off the path, 503 while auth is down', async () => {
    const [a] = replicas;
    const cookie = 'Authentication=token-1';
    expect(
      await refusedWith(a.url, { cookie, origin: 'https://evil.example' }),
    ).toBe(403);
    expect(
      await refusedWith(a.url.replace('/realtime', '/elsewhere'), { cookie }),
    ).toBe(404);
    authDown = true;
    try {
      expect(await refusedWith(a.url, { cookie })).toBe(503);
    } finally {
      authDown = false;
    }
  });

  it("joins the user to their own channel, and refuses anyone else's", async () => {
    const userId = newUserId();
    const client = await Client.open(replicas[0], userId);

    expect(client.frames[0]).toEqual({
      type: 'welcome',
      userId,
      channels: [`user.${userId}`],
    });

    client.send({ op: 'subscribe', channel: 'user.1' });
    expect(
      await client.next((f) => f.type === 'error' && f.channel === 'user.1'),
    ).toMatchObject({ code: 'FORBIDDEN' });
    client.send({ op: 'subscribe', channel: `user.${userId}` });
    expect(
      await client.next(
        (f) => f.type === 'error' && f.channel === `user.${userId}`,
      ),
    ).toMatchObject({ code: 'FORBIDDEN' });

    // Another user's messages never reach it; its own do.
    await userMessage(1);
    await userMessage(userId, { mine: true });
    const own = await client.next((f) => f.type === 'message');
    expect(own).toMatchObject({
      channel: `user.${userId}`,
      seq: outboxId,
      data: { mine: true },
    });
    await sleep(200);
    expect(client.on('user.1')).toEqual([]);
  });

  it('refuses malformed and unknown requests without closing the socket', async () => {
    const client = await Client.open(replicas[0], newUserId());
    client.ws.send('not json');
    expect(await client.next((f) => f.type === 'error')).toMatchObject({
      code: 'BAD_REQUEST',
    });
    client.send({ op: 'subscribe', channel: 'prices.DOGE' });
    expect(
      await client.next((f) => f.code === 'UNKNOWN_CHANNEL'),
    ).toMatchObject({ channel: 'prices.DOGE' });
    client.ws.send(Buffer.from([1, 2, 3]), { binary: true });
    await waitFor(
      async () =>
        client.frames.filter((f) => f.code === 'BAD_REQUEST').length === 2,
      5_000,
      'the binary frame refused',
    );
    expect(client.closed).toBeUndefined();

    // A frame bigger than any request closes it (1009, message too big).
    client.ws.send('x'.repeat(2_000));
    expect((await client.waitClosed()).code).toBe(1009);
  });
});

// ---- prices --------------------------------------------------------------------------------

describe('price channels', () => {
  it("forwards ticks to subscribers only, with the tick's seq, until they unsubscribe", async () => {
    const subscriber = await Client.open(replicas[0], newUserId());
    const bystander = await Client.open(replicas[0], newUserId());
    await subscriber.subscribe('prices.NXC');

    await tick('NXC');
    await tick('ORB');
    const frame = await subscriber.next(
      (f) => f.type === 'message' && f.channel === 'prices.NXC',
    );

    expect(frame).toEqual({
      type: 'message',
      channel: 'prices.NXC',
      seq: priceSeq - 1,
      data: expect.objectContaining({ type: 'price', coin: 'NXC' }),
    });
    subscriber.send({ op: 'unsubscribe', channel: 'prices.NXC' });
    await subscriber.next((f) => f.type === 'unsubscribed');
    await tick('NXC');
    await sleep(200);
    expect(subscriber.on('prices.NXC')).toHaveLength(1);
    expect(subscriber.on('prices.ORB')).toEqual([]);
    expect(bystander.frames.filter((f) => f.type === 'message')).toEqual([]);
  });

  it('drops a message without a seq: a client could not order it', async () => {
    const userId = newUserId();
    const client = await Client.open(replicas[0], userId);
    await publish(`user.${userId}`, { type: 'fill' }, 'no-outbox-id');
    await userMessage(userId);
    const [only] = await waitFor(
      async () =>
        client.on(`user.${userId}`).length && client.on(`user.${userId}`),
      5_000,
      'the message',
    );
    expect(only.seq).toBe(outboxId);
    await sleep(200);
    expect(client.on(`user.${userId}`)).toHaveLength(1);
  });
});

// ---- acceptance test 9: fan-out across replicas --------------------------------------------

describe('fan-out across replicas (acceptance test 9)', () => {
  it("delivers a user's message to their tabs on every replica, and binds user.<id> while they have one", async () => {
    const [a, b] = replicas;
    const userId = newUserId();
    const channel = `user.${userId}`;
    const tabA1 = await Client.open(a, userId);
    const tabA2 = await Client.open(a, userId);
    const tabB = await Client.open(b, userId);
    const stranger = await Client.open(b, newUserId());

    // One binding per replica, however many tabs.
    const [queueA, queueB] = [
      a.app.get(RealtimeFeed).bindings,
      b.app.get(RealtimeFeed).bindings,
    ];
    expect(queueA).toContain(channel);
    expect(queueB).toContain(channel);
    expect(await boundQueues(channel)).toHaveLength(2);

    await userMessage(userId, { orderId: 'the-fill' });
    for (const tab of [tabA1, tabA2, tabB]) {
      expect(await tab.next((f) => f.channel === channel)).toEqual({
        type: 'message',
        channel,
        seq: outboxId,
        data: { type: 'fill', orderId: 'the-fill' },
      });
    }
    await sleep(200);
    expect(stranger.frames.filter((f) => f.type === 'message')).toEqual([]);

    // Closing a tab keeps the binding while another tab on that replica remains.
    tabA1.ws.close();
    await tabA1.waitClosed();
    await sleep(200);
    expect(await boundQueues(channel)).toHaveLength(2);
    tabA2.ws.close();
    await tabA2.waitClosed();
    await waitFor(
      async () => (await boundQueues(channel)).length === 1,
      5_000,
      'the unbind on replica a',
    );
    await userMessage(userId, { orderId: 'second' });
    expect(
      await tabB.next((f) => f.data?.['orderId'] === 'second'),
    ).toBeTruthy();
    tabB.ws.close();
    await waitFor(
      async () => (await boundQueues(channel)).length === 0,
      5_000,
      'the unbind on replica b',
    );
  });
});

// ---- liveness ------------------------------------------------------------------------------

describe('heartbeat', () => {
  it('terminates a client that stops answering pings, and keeps one that answers', async () => {
    const replica = await startReplica('heartbeat', { pingIntervalMs: 150 });
    const silent = await Client.open(replica, newUserId(), { autoPong: false });
    const alive = await Client.open(replica, newUserId());

    const closed = await silent.waitClosed(3_000);

    // Terminated, not closed: no close frame (1006 on the client).
    expect(closed.code).toBe(1006);
    expect((await stats(replica)).terminatedIdle).toBe(1);
    await sleep(400);
    expect(alive.closed).toBeUndefined();
    await stopReplica(replica);
  });
});

// ---- acceptance test 12: a client that never reads -----------------------------------------

describe('backpressure (acceptance test 12)', () => {
  it("drops a slow client's ticks, then closes it with 1013; other clients get everything", async () => {
    const replica = await startReplica('backpressure', {
      dropPricesAboveBytes: 64 * 1024,
      closeAboveBytes: 256 * 1024,
      closeAfterMs: 1_000,
      backpressureCheckMs: 100,
      // No heartbeat in the way: the slow client can't answer pings either.
      pingIntervalMs: 60_000,
    });
    const slowUser = newUserId();
    const slow = await Client.open(replica, slowUser);
    const healthy = await Client.open(replica, newUserId());
    await slow.subscribe('prices.WISP');
    await healthy.subscribe('prices.WISP');
    // Stop reading: the kernel buffers fill, then the gateway's own buffer grows.
    slow.ws.pause();

    const firstSeq = priceSeq + 1;
    const padding = 'x'.repeat(32 * 1024);
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < 50; i++) {
        await userMessage(slowUser, { padding });
      }
      await tick('WISP');
      await sleep(30);
      if ((await stats(replica)).closedSlow > 0) {
        break;
      }
    }
    // A few more ticks after the close: they must reach the healthy client too.
    for (let i = 0; i < 5; i++) {
      await tick('WISP');
    }
    const lastSeq = priceSeq;

    const after = await stats(replica);
    expect(after.closedSlow).toBe(1);
    expect(after.droppedPrices).toBeGreaterThan(0);
    await waitFor(
      async () => healthy.on('prices.WISP').length === lastSeq - firstSeq + 1,
      5_000,
      'every tick on the healthy client',
    );
    expect(healthy.on('prices.WISP').map((f) => f.seq)).toEqual(
      Array.from({ length: lastSeq - firstSeq + 1 }, (_, i) => firstSeq + i),
    );
    expect(healthy.closed).toBeUndefined();
    // The slow client's user is gone from this replica: its binding too.
    expect(after.users).toBe(1);

    // Once it reads again it finds its backlog, then the close: 1013, try again later.
    slow.ws.resume();
    expect((await slow.waitClosed(10_000)).code).toBe(1013);
    const ticks = slow.on('prices.WISP').length;
    expect(ticks).toBeLessThan(lastSeq - firstSeq + 1);
    await stopReplica(replica);
  }, 60_000);
});

// ---- RabbitMQ and shutdown -----------------------------------------------------------------

describe('when RabbitMQ drops the connection', () => {
  it('tells every client to resync, and binds everything again', async () => {
    const [a] = replicas;
    const userId = newUserId();
    const client = await Client.open(a, userId);
    await client.subscribe('prices.BLIP');

    await rabbit.exec([
      'rabbitmqctl',
      'close_all_connections',
      'test: dropped on purpose',
    ]);
    await client.next((f) => f.type === 'resync', 15_000);
    await amqp.close().catch(() => undefined);
    amqp = await connect(rabbit.getAmqpUrl());
    channelPromise = undefined;

    await userMessage(userId, { after: 'reconnect' });
    await tick('BLIP');
    expect(
      await client.next((f) => f.data?.['after'] === 'reconnect'),
    ).toBeTruthy();
    expect(
      await client.next(
        (f) => f.type === 'message' && f.channel === 'prices.BLIP',
      ),
    ).toBeTruthy();
    expect(client.closed).toBeUndefined();
  }, 30_000);
});

describe('shutdown', () => {
  it('closes every socket with 1012 so clients reconnect at once', async () => {
    const replica = await startReplica('leaving');
    const one = await Client.open(replica, newUserId());
    const two = await Client.open(replica, newUserId());

    await stopReplica(replica);

    expect((await one.waitClosed()).code).toBe(1012);
    expect((await two.waitClosed()).code).toBe(1012);
    expect(await refusedWith(replica.url, {}).catch(() => 'gone')).toBe('gone');
  });
});

it('GET /realtime/stats reports sockets, users and bindings', async () => {
  const [, b] = replicas;
  const userId = newUserId();
  await Client.open(b, userId);
  const current = await stats(b);
  expect(current).toMatchObject({
    feedReady: true,
    bindings: expect.arrayContaining(['prices.*', `user.${userId}`]),
  });
  expect(current.sockets).toBeGreaterThanOrEqual(1);
  expect(current.memory.heapUsedMb).toBeGreaterThan(0);
});

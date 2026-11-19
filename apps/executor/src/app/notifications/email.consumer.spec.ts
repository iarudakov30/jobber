import { INestApplicationContext } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  RabbitMQContainer,
  StartedRabbitMQContainer,
} from '@testcontainers/rabbitmq';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { createTransport, Transporter } from 'nodemailer';
import { join } from 'path';
import { Observable, of, throwError } from 'rxjs';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { promisify } from 'util';
import { GrpcStatus, Packages, User } from '@jobber/grpc';
import {
  EMAIL_TOPUP,
  NOTIFICATIONS_EXCHANGE,
  RABBIT_OPTIONS,
  RabbitConnection,
  RabbitPublisher,
  notificationsTopology,
} from '@jobber/rabbitmq';
import { MAILER } from './email.consumer';
import { NotificationsModule } from './notifications.module';
import { RedisSentEmails, SENT_EMAILS } from './sent-emails';

// The email worker against real RabbitMQ, Redis and Mailpit (Testcontainers); only `auth` is
// faked. Retries are shortened to 300 ms / 600 ms with 3 attempts.

const REPLAY_SCRIPT = join(
  __dirname,
  '../../../../../libs/rabbitmq/scripts/replay.mjs',
);

let rabbit: StartedRabbitMQContainer;
let redisContainer: StartedTestContainer;
let mailpit: StartedTestContainer;
let redis: Redis;
let app: INestApplicationContext;
let publisher: RabbitPublisher;
let mailpitApi: string;
let smtpUp: Transporter;
let smtpDown: Transporter;
let mailer: Transporter;

const users = new Map<number, User>([
  [7, { id: 7, email: 'alice@example.com' }],
]);
const fakeAuth = {
  getUser: ({ id }: { id: number }): Observable<User> => {
    const user = users.get(id);
    return user
      ? of(user)
      : throwError(() =>
          Object.assign(new Error('No user has that id'), {
            code: GrpcStatus.NOT_FOUND,
          }),
        );
  },
};

beforeAll(async () => {
  [rabbit, redisContainer, mailpit] = await Promise.all([
    new RabbitMQContainer('rabbitmq:4-management')
      // RabbitMQ boots slowly when several projects start one at once (nx affected).
      .withStartupTimeout(120_000)
      .start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
    new GenericContainer('axllent/mailpit')
      .withExposedPorts(1025, 8025)
      .start(),
  ]);
  const redisUrl = `redis://${redisContainer.getHost()}:${redisContainer.getMappedPort(6379)}`;
  redis = new Redis(redisUrl);
  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}/api/v1`;
  smtpUp = createTransport(
    `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`,
  );
  smtpDown = createTransport('smtp://127.0.0.1:1'); // nothing listens: refused at once
  mailer = smtpUp;

  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      NotificationsModule,
    ],
  })
    .overrideProvider(RABBIT_OPTIONS)
    .useValue({
      url: rabbit.getAmqpUrl(),
      topology: notificationsTopology({ delaysMs: [300, 600], maxAttempts: 3 }),
      minReconnectDelayMs: 100,
    })
    .overrideProvider(Packages.AUTH)
    .useValue({ getService: () => fakeAuth })
    .overrideProvider(MAILER)
    .useValue({
      sendMail: (...args: Parameters<Transporter['sendMail']>) =>
        mailer.sendMail(...args),
    })
    .overrideProvider(SENT_EMAILS)
    .useValue(RedisSentEmails.connect(redisUrl))
    .compile();
  moduleRef.useLogger(false);
  app = await moduleRef.init();
  await app.get(RabbitConnection).whenConnected();
  publisher = app.get(RabbitPublisher);
}, 180_000);

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  smtpUp?.close();
  smtpDown?.close();
  await Promise.all([rabbit?.stop(), redisContainer?.stop(), mailpit?.stop()]);
});

beforeEach(async () => {
  mailer = smtpUp;
  await fetch(`${mailpitApi}/messages`, { method: 'DELETE' });
});

interface MailpitMessage {
  Subject: string;
  To: { Address: string }[];
}

async function inbox(): Promise<MailpitMessage[]> {
  const response = await fetch(`${mailpitApi}/messages`);
  return ((await response.json()) as { messages: MailpitMessage[] }).messages;
}

function topUp(messageId: string, userId = 7, amount = '5000') {
  return publisher.publish(
    NOTIFICATIONS_EXCHANGE,
    EMAIL_TOPUP,
    { userId, paymentId: randomUUID(), amount, currency: 'USD' },
    { messageId },
  );
}

async function until(check: () => Promise<boolean>, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error('Timed out waiting');
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dlq() {
  const channel = await (
    await import('amqplib')
  )
    .connect(rabbit.getAmqpUrl())
    .then((c) => c.createChannel().then((ch) => ({ c, ch })));
  try {
    const { messageCount } = await channel.ch.checkQueue(
      'notifications.email.dlq',
    );
    return messageCount;
  } finally {
    await channel.c.close();
  }
}

it('emails the address auth knows, with the amount', async () => {
  await topUp(`outbox-wallet-${randomUUID()}`);

  await until(async () => (await inbox()).length === 1);
  const [message] = await inbox();
  expect(message.To.map((t) => t.Address)).toEqual(['alice@example.com']);
  expect(message.Subject).toBe(
    'Your top-up of $50.00 is in your NexusPay wallet',
  );
});

it('sends once when the same message arrives again', async () => {
  const messageId = `outbox-wallet-${randomUUID()}`;
  await topUp(messageId);
  await until(async () => (await inbox()).length === 1);

  // The wallet's relay resent it after a crash: same messageId.
  await topUp(messageId);
  await pause(1_000);

  expect(await inbox()).toHaveLength(1);
  expect(await redis.ttl(`email:sent:${messageId}`)).toBeGreaterThan(
    6 * 24 * 3600,
  );
});

it('dead-letters an unknown user and bad data at once, sending nothing', async () => {
  const before = await dlq();

  await topUp(`outbox-wallet-${randomUUID()}`, 404);
  await publisher.publish(
    NOTIFICATIONS_EXCHANGE,
    EMAIL_TOPUP,
    { userId: 7, amount: 5000 },
    { messageId: `outbox-wallet-${randomUUID()}` },
  );

  await until(async () => (await dlq()) === before + 2);
  expect(await inbox()).toHaveLength(0);
});

it('retries while SMTP is down, dead-letters, and sends once after a replay (acceptance 9)', async () => {
  mailer = smtpDown;
  const before = await dlq();

  await topUp(`outbox-wallet-${randomUUID()}`, 7, '1234');

  // Attempts at 0, +300 ms and +600 ms, then the DLQ.
  await until(async () => (await dlq()) === before + 1, 15_000);
  expect(await inbox()).toHaveLength(0);

  mailer = smtpUp;
  await promisify(execFile)(
    process.execPath,
    [REPLAY_SCRIPT, '--queue=notifications.email'],
    { env: { ...process.env, RABBITMQ_URL: rabbit.getAmqpUrl() } },
  );

  await until(async () => (await inbox()).length === 1);
  await pause(1_000);
  expect(await inbox()).toHaveLength(1);
  expect((await inbox())[0].Subject).toContain('$12.34');
  // The replay moved the whole DLQ: the two poison messages of the previous test went back to
  // it, and only they.
  await until(async () => (await dlq()) === before);
});

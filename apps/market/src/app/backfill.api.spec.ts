import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import {
  ClientGrpcProxy,
  ClientProxyFactory,
  GrpcOptions,
  Transport,
} from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { createServer } from 'net';
import { firstValueFrom } from 'rxjs';
import {
  GRPC_LOADER_OPTIONS,
  GrpcStatus,
  MARKET_SERVICE_NAME,
  MarketServiceClient,
  Packages,
} from '@jobber/grpc';
import { MARKET_PROTO } from '../testing/fake-wallet';
import { TestDatabase, startTestDatabase } from '../testing/test-database';
import { BackfillModule } from './backfill/backfill.module';
import { DatabaseModule } from './database/database.module';
import { generateDay } from './prices/backfill';
import { CandleStore } from './prices/candle.store';

// gRPC GenerateCandles end to end: the real controller served over gRPC by a Nest microservice,
// called through a real client on market.proto, against a Testcontainers PostgreSQL.

let testDb: TestDatabase;
let app: INestApplication;
let client: ClientGrpcProxy;
let market: MarketServiceClient;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  process.env['DATABASE_URL'] = testDb.container.getConnectionUri();
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      BackfillModule,
    ],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  const url = `127.0.0.1:${await freePort()}`;
  app.connectMicroservice<GrpcOptions>({
    transport: Transport.GRPC,
    options: {
      url,
      package: Packages.MARKET,
      protoPath: MARKET_PROTO,
      loader: GRPC_LOADER_OPTIONS,
    },
  });
  await app.startAllMicroservices();
  await app.init();
  client = ClientProxyFactory.create({
    transport: Transport.GRPC,
    options: {
      url,
      package: Packages.MARKET,
      protoPath: MARKET_PROTO,
      loader: GRPC_LOADER_OPTIONS,
    },
  }) as ClientGrpcProxy;
  market = client.getService<MarketServiceClient>(MARKET_SERVICE_NAME);
}, 120_000);

afterAll(async () => {
  client?.close();
  await app?.close();
  await testDb?.pool.end();
  await testDb?.container.stop();
});

const generate = (coin: string, day: string) =>
  firstValueFrom(market.generateCandles({ coin, day }));

async function rows(coin: string, day: string) {
  const { rows } = await testDb.pool.query(
    `SELECT start, open::text, high::text, low::text, close::text FROM candles
      WHERE coin = $1 AND start >= $2::date AND start < $2::date + 1 ORDER BY start`,
    [coin, day],
  );
  return rows as {
    start: Date;
    open: string;
    high: string;
    low: string;
    close: string;
  }[];
}

it('writes the day’s 1,440 generated candles, and nothing on a repeat', async () => {
  expect(await generate('NXC', '2026-11-01')).toEqual({ written: 1_440 });

  const stored = await rows('NXC', '2026-11-01');
  const expected = generateDay('NXC', '2026-11-01');
  expect(stored).toHaveLength(1_440);
  expect(stored[0]).toEqual({
    start: expected[0].start,
    open: String(expected[0].open),
    high: String(expected[0].high),
    low: String(expected[0].low),
    close: String(expected[0].close),
  });
  expect(stored.map((r) => r.close)).toEqual(
    expected.map((c) => String(c.close)),
  );

  expect(await generate('NXC', '2026-11-01')).toEqual({ written: 0 });
  expect(await rows('NXC', '2026-11-01')).toEqual(stored);
});

it('leaves a live candle alone and fills the minutes around it', async () => {
  const live = {
    coin: 'ORB',
    start: new Date('2026-11-02T12:34:00Z'),
    open: 1n,
    high: 3n,
    low: 1n,
    close: 2n,
  };
  await app.get(CandleStore).upsert([live]);

  expect(await generate('ORB', '2026-11-02')).toEqual({ written: 1_439 });

  const stored = await rows('ORB', '2026-11-02');
  expect(stored).toHaveLength(1_440);
  expect(stored[12 * 60 + 34]).toEqual({
    start: live.start,
    open: '1',
    high: '3',
    low: '1',
    close: '2',
  });
});

it('answers INVALID_ARGUMENT for a bad coin or day, writing nothing', async () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [coin, day, message] of [
    ['DOGE', '2026-11-01', 'coin must be one of: NXC, BLIP, ORB, WISP, BTC, ETH, HYPE, ZEC'],
    [
      'BTC',
      '2026-11-01',
      "coin BTC is priced by the exchanges: its history isn't generated",
    ],
    ['NXC', '2026-13-01', 'day must be a date: YYYY-MM-DD'],
    ['NXC', '2019-06-01', 'day must be 2020-01-01 or later'],
    [
      'NXC',
      today,
      'day must be before today (UTC): today belongs to the live simulator',
    ],
  ]) {
    await expect(generate(coin, day)).rejects.toMatchObject({
      code: GrpcStatus.INVALID_ARGUMENT,
      details: message,
    });
  }
  const { rows: count } = await testDb.pool.query(
    `SELECT count(*)::int AS n FROM candles WHERE coin IN ('DOGE') OR start >= $1::date - 1 OR start < '2020-01-01'`,
    [today],
  );
  expect(count[0].n).toBe(0);
});

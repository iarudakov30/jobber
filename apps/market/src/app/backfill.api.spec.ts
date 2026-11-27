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
import {
  FakeBinance,
  FakeCandle,
  FakeCoinbase,
  fakeDay,
} from '../testing/fake-exchanges';
import { MARKET_PROTO } from '../testing/fake-wallet';
import { TestDatabase, startTestDatabase } from '../testing/test-database';
import { BackfillModule } from './backfill/backfill.module';
import { MarketController } from './backfill/market.controller';
import { DatabaseModule } from './database/database.module';
import { generateDay } from './prices/backfill';
import { CandleStore } from './prices/candle.store';
import { LiveHistory } from './prices/live/live-history';
import {
  LIVE_PRICES_OPTIONS,
  LivePrices,
  LivePricesOptions,
} from './prices/live/live-prices';

// gRPC GenerateCandles end to end: the real controller served over gRPC by a Nest microservice,
// called through a real client on market.proto, against a Testcontainers PostgreSQL. Live coins'
// candles come from the fake exchanges (Binance first, as in production); nothing reaches the
// internet.

let testDb: TestDatabase;
let coinbase: FakeCoinbase;
let binance: FakeBinance;
let liveOptions: LivePricesOptions;
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
  [testDb, coinbase, binance] = await Promise.all([
    startTestDatabase(),
    FakeCoinbase.start(),
    FakeBinance.start(),
  ]);
  process.env['DATABASE_URL'] = testDb.container.getConnectionUri();
  liveOptions = {
    enabled: true,
    providers: ['binance', 'coinbase'],
    endpoints: {
      coinbase: { wsUrl: coinbase.wsUrl, restUrl: coinbase.restUrl },
      binance: { wsUrl: binance.wsUrl, restUrl: binance.restUrl },
    },
    connection: { requestTimeoutMs: 2_000 },
  };
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      DatabaseModule,
      BackfillModule,
    ],
  })
    .overrideProvider(LIVE_PRICES_OPTIONS)
    .useValue(liveOptions)
    .compile();
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
  await coinbase?.stop();
  await binance?.stop();
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
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  for (const [coin, day, message] of [
    [
      'DOGE',
      '2026-11-01',
      'coin must be one of: NXC, BLIP, ORB, WISP, BTC, ETH, HYPE, ZEC',
    ],
    ['BTC', tomorrow, 'day must not be after today (UTC)'],
    ['BTC', '2019-06-01', 'day must be 2020-01-01 or later'],
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
    `SELECT count(*)::int AS n FROM candles
      WHERE coin = 'DOGE' OR start >= $1::date + 1 OR start < '2020-01-01'
         OR (coin = 'NXC' AND start >= $1::date - 1)`,
    [today],
  );
  expect(count[0].n).toBe(0);
});

// ---- live coins: the exchanges' candles (acceptance test 8) ------------------------------------

const yesterday = () =>
  new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

/** A fake exchange candle's decimal string in cents, as the table stores it. */
const cents = (usd: string) => String(Math.round(Number(usd) * 100));

const requestsFor = (fake: FakeCoinbase | FakeBinance, symbol: string) =>
  fake.restRequests.filter((path) => path.includes(symbol)).length;

describe('live coins (test 8)', () => {
  afterEach(() => {
    coinbase.failRest(null);
    binance.failRest(null);
  });

  it('loads the day from Binance: 1,440 candles in cents, and nothing on a repeat', async () => {
    const day = yesterday();
    const candles = fakeDay(day, 60_000);
    binance.setCandles('BTCUSDT', candles);
    coinbase.setCandles('BTC-USD', fakeDay(day, 61_000));

    expect(await generate('BTC', day)).toEqual({ written: 1_440 });

    const stored = await rows('BTC', day);
    expect(stored).toHaveLength(1_440);
    expect(stored[0]).toEqual({
      start: new Date(candles[0].start),
      open: cents(candles[0].open),
      high: cents(candles[0].high),
      low: cents(candles[0].low),
      close: cents(candles[0].close),
    });
    expect(stored.map((r) => r.close)).toEqual(
      candles.map((c: FakeCandle) => cents(c.close)),
    );
    expect(requestsFor(binance, 'BTCUSDT')).toBe(2); // 1,000 per request
    expect(requestsFor(coinbase, 'BTC-USD')).toBe(0);

    expect(await generate('BTC', day)).toEqual({ written: 0 });
    expect(await rows('BTC', day)).toEqual(stored);
  });

  it('falls back to Coinbase when Binance refuses', async () => {
    const day = yesterday();
    const candles = fakeDay(day, 3_000);
    coinbase.setCandles('ETH-USD', candles);
    binance.failRest(451);

    expect(await generate('ETH', day)).toEqual({ written: 1_440 });

    expect((await rows('ETH', day)).map((r) => r.close)).toEqual(
      candles.map((c: FakeCandle) => cents(c.close)),
    );
    expect(requestsFor(coinbase, 'ETH-USD')).toBe(5); // 300 per request
  });

  it('answers UNAVAILABLE when every exchange refuses, writing nothing', async () => {
    const day = yesterday();
    binance.setCandles('HYPEUSDT', fakeDay(day, 35));
    binance.failRest(503);
    coinbase.failRest(429);

    await expect(generate('HYPE', day)).rejects.toMatchObject({
      code: GrpcStatus.UNAVAILABLE,
    });
    expect(await rows('HYPE', day)).toEqual([]);
  });

  it('takes today, up to the last completed minute', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    binance.setCandles('ZECUSDT', fakeDay(day, 500));
    const completed = (at: number) => Math.floor((at - dayStart) / 60_000);

    const before = Date.now();
    const { written } = await generate('ZEC', day);
    const after = Date.now();

    expect(written).toBeGreaterThanOrEqual(completed(before));
    expect(written).toBeLessThanOrEqual(completed(after));
    const stored = await rows('ZEC', day);
    expect(stored).toHaveLength(written);
    expect(stored.every((r) => r.start.getTime() + 60_000 <= after)).toBe(true);
  });

  it('refuses a live coin with FAILED_PRECONDITION while live prices are off', async () => {
    const store = app.get(CandleStore);
    const off = new LivePrices({ ...liveOptions, enabled: false });
    const controller = new MarketController(store, new LiveHistory(off, store));
    const before = binance.restRequests.length + coinbase.restRequests.length;

    const error = await controller
      .generateCandles({ coin: 'ZEC', day: yesterday() })
      .catch((e: { getError(): unknown }) => e.getError());

    expect(error).toEqual({
      code: GrpcStatus.FAILED_PRECONDITION,
      message:
        "live prices are off (MARKET_LIVE_PRICES): ZEC's candles come from the exchanges",
    });
    expect(binance.restRequests.length + coinbase.restRequests.length).toBe(
      before,
    );
  });
});

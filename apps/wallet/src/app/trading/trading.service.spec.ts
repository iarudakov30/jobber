import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { OutboxRelay } from '@jobber/outbox';
import {
  TestDatabase,
  expectBooksBalanced,
  startTestDatabase,
} from '../../testing/test-database';
import { InsufficientFundsError } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';
import { WalletInputError } from '../wallet/wallet.errors';
import { HoldNotFoundError, HoldStateError } from './trading.errors';
import {
  FEES,
  GENESIS,
  MARKET_MAKER,
  SettleTradeInput,
  TradingService,
} from './trading.service';

// Holds and trade settlement against a real PostgreSQL (Testcontainers): what's under test
// (one posting per id, row locks deciding races, balances that can't go negative) lives in
// the database.

const COIN = 100_000_000n; // one whole coin in minor units

let testDb: TestDatabase;
let pool: Pool;
let ledger: LedgerService;
let trading: TradingService;
const relay = { poke: jest.fn() };

beforeAll(async () => {
  testDb = await startTestDatabase();
  pool = testDb.pool;
  ledger = new LedgerService(testDb.db);
  trading = new TradingService(
    testDb.db,
    ledger,
    relay as unknown as OutboxRelay,
  );
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.container.stop();
});

afterEach(() => expectBooksBalanced(pool));

let lastUserId = 5000;

/** A new user with `cents` of USD (and `coins` of NXC, from the dev faucet). */
async function newUser(cents = 0n, coins = 0n): Promise<number> {
  const userId = ++lastUserId;
  for (const [asset, amount] of [
    ['USD', cents],
    ['NXC', coins],
  ] as const) {
    const user = await ledger.ensureAccounts(userId, asset);
    if (amount > 0n) {
      const seed = await ledger.ensureSystemAccount('seed', asset);
      await ledger.post({
        type: 'seed',
        externalRef: `seed:${userId}:${asset}`,
        legs: [
          { accountId: seed, asset, amount: -amount },
          { accountId: user.available, asset, amount },
        ],
      });
    }
  }
  return userId;
}

async function balances(userId: number, asset: string) {
  const { rows } = await pool.query(
    `SELECT kind, balance::text FROM accounts
     WHERE owner_type = 'user' AND owner_id = $1 AND asset = $2`,
    [String(userId), asset],
  );
  const of = (kind: string) =>
    BigInt(rows.find((r) => r.kind === kind)?.balance ?? 0);
  return { available: of('available'), held: of('held') };
}

async function systemBalance(name: string, asset: string): Promise<bigint> {
  const { rows } = await pool.query(
    `SELECT balance::text FROM accounts
     WHERE owner_type = 'system' AND owner_id = $1 AND asset = $2`,
    [name, asset],
  );
  return BigInt(rows[0]?.balance ?? 0);
}

async function postings(type: string, externalRef: string): Promise<number> {
  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM transactions WHERE type = $1 AND external_ref = $2',
    [type, externalRef],
  );
  return rows[0].n;
}

async function holdStatus(holdId: string): Promise<string | undefined> {
  const { rows } = await pool.query('SELECT status FROM holds WHERE id = $1', [
    holdId,
  ]);
  return rows[0]?.status;
}

function buy(
  userId: number,
  qty: bigint,
  usdAmount: bigint,
  fee: bigint,
  extra: Partial<SettleTradeInput> = {},
) {
  return trading.settleTrade({
    tradeId: randomUUID(),
    userId,
    coin: 'NXC',
    side: 'BUY',
    qty,
    usdAmount,
    fee,
    ...extra,
  });
}

function sell(
  userId: number,
  qty: bigint,
  usdAmount: bigint,
  fee: bigint,
  extra: Partial<SettleTradeInput> = {},
) {
  return buy(userId, qty, usdAmount, fee, { side: 'SELL', ...extra });
}

describe('PlaceHold and ReleaseHold', () => {
  it('moves the amount from available to held, once per holdId', async () => {
    const userId = await newUser(10_000n);
    const holdId = randomUUID();
    const hold = { holdId, userId, asset: 'USD', amount: 2_500n };

    const first = await trading.placeHold(hold);
    const again = await trading.placeHold(hold);

    expect(first.duplicate).toBe(false);
    expect(again).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await balances(userId, 'USD')).toEqual({
      available: 7_500n,
      held: 2_500n,
    });
    expect(await holdStatus(holdId)).toBe('ACTIVE');
    expect(await postings('hold', holdId)).toBe(1);
  });

  it('refuses the same holdId with other terms', async () => {
    const userId = await newUser(10_000n);
    const holdId = randomUUID();
    await trading.placeHold({ holdId, userId, asset: 'USD', amount: 100n });

    await expect(
      trading.placeHold({ holdId, userId, asset: 'USD', amount: 200n }),
    ).rejects.toThrow('holdId was already used for a different hold');
  });

  it('writes nothing when the user lacks the funds, so the hold can be retried later', async () => {
    const userId = await newUser(100n);
    const holdId = randomUUID();

    await expect(
      trading.placeHold({ holdId, userId, asset: 'USD', amount: 101n }),
    ).rejects.toThrow(InsufficientFundsError);

    expect(await holdStatus(holdId)).toBeUndefined();
    expect(await postings('hold', holdId)).toBe(0);
    expect(await balances(userId, 'USD')).toEqual({
      available: 100n,
      held: 0n,
    });
  });

  it('places one hold from 20 parallel calls', async () => {
    const userId = await newUser(10_000n);
    const hold = { holdId: randomUUID(), userId, asset: 'USD', amount: 1_000n };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => trading.placeHold(hold)),
    );

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await balances(userId, 'USD')).toEqual({
      available: 9_000n,
      held: 1_000n,
    });
  });

  it('releases a hold back to available, once', async () => {
    const userId = await newUser(10_000n);
    const holdId = randomUUID();
    await trading.placeHold({ holdId, userId, asset: 'USD', amount: 2_500n });

    const first = await trading.releaseHold(holdId);
    const again = await trading.releaseHold(holdId.toUpperCase());

    expect(first.duplicate).toBe(false);
    expect(again).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await balances(userId, 'USD')).toEqual({
      available: 10_000n,
      held: 0n,
    });
    expect(await holdStatus(holdId)).toBe('RELEASED');
  });

  it('refuses to release a hold that does not exist', async () => {
    await expect(trading.releaseHold(randomUUID())).rejects.toThrow(
      HoldNotFoundError,
    );
  });

  it.each([
    ['holdId', { holdId: 'order-1' }, 'holdId must be a UUID'],
    ['userId', { userId: 0 }, 'userId must be a positive integer'],
    ['asset', { asset: 'EUR' }, 'asset EUR is not supported'],
    ['amount', { amount: 0n }, 'amount must be positive'],
  ])('validates %s', async (_, override, message) => {
    await expect(
      trading.placeHold({
        holdId: randomUUID(),
        userId: 1,
        asset: 'USD',
        amount: 1n,
        ...override,
      }),
    ).rejects.toThrow(new WalletInputError(message));
  });
});

describe('SettleTrade without a hold (market orders)', () => {
  it('moves exactly the four legs of a buy', async () => {
    const userId = await newUser(10_000n);
    const makerUsd = await systemBalance(MARKET_MAKER, 'USD');
    const fees = await systemBalance(FEES, 'USD');

    // 1.5 NXC for $42.37 plus a $0.22 fee.
    const result = await buy(userId, 150_000_000n, 4_237n, 22n);

    expect(result.duplicate).toBe(false);
    expect(await balances(userId, 'USD')).toEqual({
      available: 10_000n - 4_237n - 22n,
      held: 0n,
    });
    expect(await balances(userId, 'NXC')).toEqual({
      available: 150_000_000n,
      held: 0n,
    });
    expect(await systemBalance(MARKET_MAKER, 'USD')).toBe(makerUsd + 4_237n);
    expect(await systemBalance(FEES, 'USD')).toBe(fees + 22n);
  });

  it('pays a sell its proceeds minus the fee', async () => {
    const userId = await newUser(0n, 2n * COIN);
    const makerUsd = await systemBalance(MARKET_MAKER, 'USD');
    const fees = await systemBalance(FEES, 'USD');

    await sell(userId, COIN, 2_800n, 14n);

    expect(await balances(userId, 'USD')).toEqual({
      available: 2_786n,
      held: 0n,
    });
    expect(await balances(userId, 'NXC')).toEqual({
      available: COIN,
      held: 0n,
    });
    expect(await systemBalance(MARKET_MAKER, 'USD')).toBe(makerUsd - 2_800n);
    expect(await systemBalance(FEES, 'USD')).toBe(fees + 14n);
  });

  it('accepts a zero fee', async () => {
    const userId = await newUser(1_000n);

    await buy(userId, COIN, 1_000n, 0n);

    expect(await balances(userId, 'USD')).toEqual({ available: 0n, held: 0n });
  });

  it('posts once when the same trade is settled twice (spec test 4)', async () => {
    const userId = await newUser(10_000n);
    const trade = {
      tradeId: randomUUID(),
      userId,
      coin: 'NXC',
      side: 'BUY',
      qty: COIN,
      usdAmount: 2_000n,
      fee: 10n,
    };

    const first = await trading.settleTrade(trade);
    const again = await trading.settleTrade(trade);

    expect(again).toEqual({
      transactionId: first.transactionId,
      duplicate: true,
    });
    expect(await postings('trade', trade.tradeId)).toBe(1);
    expect(await balances(userId, 'USD')).toEqual({
      available: 7_990n,
      held: 0n,
    });
  });

  it('settles once from 20 parallel retries', async () => {
    const userId = await newUser(10_000n);
    const trade = {
      tradeId: randomUUID(),
      userId,
      coin: 'NXC',
      side: 'BUY',
      qty: COIN,
      usdAmount: 2_000n,
      fee: 10n,
    };

    const results = await Promise.all(
      Array.from({ length: 20 }, () => trading.settleTrade(trade)),
    );

    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(await postings('trade', trade.tradeId)).toBe(1);
    expect(await balances(userId, 'NXC')).toEqual({
      available: COIN,
      held: 0n,
    });
  });

  it('refuses a tradeId reused with other terms', async () => {
    const userId = await newUser(10_000n);
    const tradeId = randomUUID();
    await buy(userId, COIN, 2_000n, 10n, { tradeId });

    await expect(buy(userId, COIN, 2_001n, 10n, { tradeId })).rejects.toThrow(
      'tradeId was already settled with different terms',
    );
  });

  it('writes nothing when the buyer lacks the USD or the seller the coins', async () => {
    const poor = await newUser(1_000n);
    const tradeId = randomUUID();

    await expect(buy(poor, COIN, 1_000n, 5n, { tradeId })).rejects.toThrow(
      InsufficientFundsError,
    );
    await expect(sell(poor, COIN, 1_000n, 5n, { tradeId })).rejects.toThrow(
      InsufficientFundsError,
    );

    expect(await postings('trade', tradeId)).toBe(0);
    expect(await balances(poor, 'USD')).toEqual({
      available: 1_000n,
      held: 0n,
    });
  });

  it.each([
    ['tradeId', { tradeId: '42' }, 'tradeId must be a UUID'],
    ['coin', { coin: 'USD' }, 'coin USD is not a coin'],
    ['side', { side: 'HOLD' }, 'side must be one of: BUY, SELL'],
    ['qty', { qty: 0n }, 'qty must be positive'],
    ['usdAmount', { usdAmount: 0n }, 'usdAmount must be positive'],
    ['fee', { fee: -1n }, 'fee must be between 0 and usdAmount'],
    [
      'a fee above the amount',
      { fee: 101n },
      'fee must be between 0 and usdAmount',
    ],
  ])('validates %s', async (_, override, message) => {
    await expect(buy(1, COIN, 100n, 1n, override)).rejects.toThrow(
      new WalletInputError(message),
    );
  });
});

describe('SettleTrade with a hold (limit orders)', () => {
  it('captures a buy hold and returns what the trade did not need', async () => {
    const userId = await newUser(10_000n);
    const holdId = randomUUID();
    // 2 NXC at a $20.00 limit: hold 2 · 2000 · 1.005 = 4020.
    await trading.placeHold({ holdId, userId, asset: 'USD', amount: 4_020n });

    await buy(userId, 2n * COIN, 3_990n, 20n, { tradeId: holdId, holdId });

    expect(await balances(userId, 'USD')).toEqual({
      available: 10_000n - 3_990n - 20n,
      held: 0n,
    });
    expect(await balances(userId, 'NXC')).toEqual({
      available: 2n * COIN,
      held: 0n,
    });
    expect(await holdStatus(holdId)).toBe('CAPTURED');
  });

  it('captures a sell hold of coins', async () => {
    const userId = await newUser(0n, 3n * COIN);
    const holdId = randomUUID();
    await trading.placeHold({
      holdId,
      userId,
      asset: 'NXC',
      amount: 2n * COIN,
    });

    await sell(userId, 2n * COIN, 5_000n, 25n, { tradeId: holdId, holdId });

    expect(await balances(userId, 'NXC')).toEqual({
      available: COIN,
      held: 0n,
    });
    expect(await balances(userId, 'USD')).toEqual({
      available: 4_975n,
      held: 0n,
    });
    expect(await holdStatus(holdId)).toBe('CAPTURED');
  });

  it('refuses to release a captured hold, and to capture a released one', async () => {
    const userId = await newUser(10_000n);
    const captured = randomUUID();
    const released = randomUUID();
    for (const holdId of [captured, released]) {
      await trading.placeHold({ holdId, userId, asset: 'USD', amount: 1_005n });
    }
    await buy(userId, COIN, 1_000n, 5n, {
      tradeId: captured,
      holdId: captured,
    });
    await trading.releaseHold(released);

    await expect(trading.releaseHold(captured)).rejects.toThrow(
      new HoldStateError(`hold ${captured} was captured by a trade`),
    );
    await expect(
      buy(userId, COIN, 1_000n, 5n, { tradeId: released, holdId: released }),
    ).rejects.toThrow(new HoldStateError(`hold ${released} is released`));
    expect(await balances(userId, 'USD')).toEqual({
      available: 10_000n - 1_005n,
      held: 0n,
    });
  });

  it('refuses a hold that is too small, of the wrong asset, of another user, or unknown', async () => {
    const userId = await newUser(10_000n, COIN);
    const other = await newUser(10_000n);
    const usdHold = randomUUID();
    const coinHold = randomUUID();
    await trading.placeHold({
      holdId: usdHold,
      userId,
      asset: 'USD',
      amount: 1_000n,
    });
    await trading.placeHold({
      holdId: coinHold,
      userId,
      asset: 'NXC',
      amount: COIN,
    });

    await expect(
      buy(userId, COIN, 1_000n, 5n, { holdId: usdHold }),
    ).rejects.toThrow('holdId covers 1000, the trade needs 1005');
    await expect(
      buy(userId, COIN, 900n, 5n, { holdId: coinHold }),
    ).rejects.toThrow('holdId holds NXC, a BUY needs USD');
    await expect(
      buy(other, COIN, 900n, 5n, { holdId: usdHold }),
    ).rejects.toThrow('holdId belongs to another user');
    await expect(
      buy(userId, COIN, 900n, 5n, { holdId: randomUUID() }),
    ).rejects.toThrow(HoldNotFoundError);
    expect(await holdStatus(usdHold)).toBe('ACTIVE');
  });

  it('lets exactly one of a cancel and a fill win, 20 times over', async () => {
    const userId = await newUser(100_000n);

    for (let i = 0; i < 20; i++) {
      const holdId = randomUUID();
      await trading.placeHold({ holdId, userId, asset: 'USD', amount: 1_005n });

      const [fill, cancel] = await Promise.allSettled([
        buy(userId, COIN, 1_000n, 5n, { tradeId: holdId, holdId }),
        trading.releaseHold(holdId),
      ]);

      const won = [fill, cancel].filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      const lost = [fill, cancel].find((r) => r.status === 'rejected');
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(
        HoldStateError,
      );
      expect(await holdStatus(holdId)).toBe(
        fill.status === 'fulfilled' ? 'CAPTURED' : 'RELEASED',
      );
    }
    expect((await balances(userId, 'USD')).held).toBe(0n);
  });
});

describe('market maker inventory', () => {
  // WISP is only traded here, so the market maker's balance is known.
  const wisp = (side: 'BUY' | 'SELL', userId: number, coins: bigint) =>
    trading.settleTrade({
      tradeId: randomUUID(),
      userId,
      coin: 'WISP',
      side,
      qty: coins * COIN,
      usdAmount: coins * 10n,
      fee: 0n,
    });

  it('refills to 1,000 coins from genesis whenever a trade leaves it under 100', async () => {
    const userId = await newUser(1_000_000n);

    await wisp('BUY', userId, 1n); // starts empty: 0 - 1 < 100
    expect(await systemBalance(MARKET_MAKER, 'WISP')).toBe(1_000n * COIN);

    await wisp('BUY', userId, 950n); // 1,000 - 950 = 50 < 100
    expect(await systemBalance(MARKET_MAKER, 'WISP')).toBe(1_000n * COIN);

    await wisp('BUY', userId, 800n); // 1,000 - 800 = 200: no refill
    expect(await systemBalance(MARKET_MAKER, 'WISP')).toBe(200n * COIN);

    await wisp('SELL', userId, 10n); // 210: no refill
    expect(await systemBalance(MARKET_MAKER, 'WISP')).toBe(210n * COIN);

    // The refills (1,001 + 950 coins) came from genesis: it is minus every coin in circulation.
    expect(await systemBalance(GENESIS, 'WISP')).toBe(-1_951n * COIN);
    expect(await balances(userId, 'WISP')).toEqual({
      available: 1_741n * COIN,
      held: 0n,
    });
  });
});

describe('announcements', () => {
  async function outbox(key: string) {
    const { rows } = await pool.query(
      `SELECT transport, destination, payload FROM outbox WHERE key = $1 ORDER BY id`,
      [key],
    );
    return rows;
  }

  it('writes trade-executed, the fill and both balances with the trade', async () => {
    const userId = await newUser(10_000n);
    const before = (await outbox(`user.${userId}`)).length;
    const tradeId = randomUUID();

    const { transactionId } = await buy(userId, COIN, 2_000n, 10n, {
      tradeId,
    });

    const trade = {
      coin: 'NXC',
      side: 'BUY',
      qty: '100000000',
      usdAmount: '2000',
      fee: '10',
    };
    expect(await outbox(String(userId))).toEqual([
      {
        transport: 'pulsar',
        destination: 'trade-executed',
        payload: { tradeId, transactionId, userId, ...trade },
      },
    ]);
    expect((await outbox(`user.${userId}`)).slice(before)).toEqual([
      {
        transport: 'rabbitmq',
        destination: 'realtime',
        payload: {
          type: 'balance',
          asset: 'USD',
          available: '7990',
          held: '0',
        },
      },
      {
        transport: 'rabbitmq',
        destination: 'realtime',
        payload: {
          type: 'balance',
          asset: 'NXC',
          available: '100000000',
          held: '0',
        },
      },
      {
        transport: 'rabbitmq',
        destination: 'realtime',
        payload: { type: 'fill', orderId: tradeId, transactionId, ...trade },
      },
    ]);
    expect(relay.poke).toHaveBeenCalled();
  });

  it('sends a hold its available and held balances, and nothing on a retry', async () => {
    const userId = await newUser(10_000n);
    const hold = { holdId: randomUUID(), userId, asset: 'USD', amount: 300n };
    const before = (await outbox(`user.${userId}`)).length;

    await trading.placeHold(hold);
    await trading.placeHold(hold);

    expect((await outbox(`user.${userId}`)).slice(before)).toEqual([
      {
        transport: 'rabbitmq',
        destination: 'realtime',
        payload: {
          type: 'balance',
          asset: 'USD',
          available: '9700',
          held: '300',
        },
      },
    ]);
  });

  it('writes nothing for the market maker, fees or genesis', async () => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM outbox
       WHERE key IN ('user.${MARKET_MAKER}', 'user.${FEES}', 'user.${GENESIS}')`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('positions', () => {
  it('replays the trades into quantity and average cost, fees included', async () => {
    const userId = await newUser(1_000_000n);
    await buy(userId, 2n * COIN, 4_000n, 20n); // 2 NXC for $40.20
    await buy(userId, COIN, 2_600n, 13n); // 1 more for $26.13: 3 for $66.33
    await sell(userId, 150_000_000n, 3_000n, 15n); // half: cost 66.33 / 2 = 33.165 → 33.17 left

    expect(await trading.positions(userId)).toEqual([
      {
        coin: 'NXC',
        qty: 150_000_000n,
        costBasis: 3_317n,
        averagePrice: 2_211n, // 3317 / 1.5, rounded down
      },
    ]);
  });

  it('drops a position once it is sold out, and ignores other users and other postings', async () => {
    const userId = await newUser(100_000n, 5n * COIN); // faucet coins have no cost
    const other = await newUser(100_000n);
    await buy(userId, COIN, 1_000n, 5n);
    await buy(other, COIN, 1_000n, 5n);
    await sell(userId, 2n * COIN, 2_000n, 10n); // more than the 1 bought: closes it

    expect(await trading.positions(userId)).toEqual([]);
    expect(await trading.positions(other)).toEqual([
      { coin: 'NXC', qty: COIN, costBasis: 1_005n, averagePrice: 1_005n },
    ]);
  });

  it('is empty for someone who never traded', async () => {
    expect(await trading.positions(await newUser(100n))).toEqual([]);
  });
});

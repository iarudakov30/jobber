import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { canonicalJson as canonical } from '@jobber/idempotency';
import {
  ASSETS,
  COINS,
  CoinCode,
  isAssetCode,
  isCoin,
  toWire,
} from '@jobber/money';
import { OutboxRelay } from '@jobber/outbox';
import {
  TRADE_EXECUTED_TOPIC,
  TRADE_SIDES,
  TradeExecutedMessage,
  TradeSide,
} from '@jobber/pulsar';
import {
  REALTIME_EXCHANGE,
  RealtimeFillMessage,
  userChannel,
} from '@jobber/rabbitmq';
import { DATABASE_CONNECTION } from '../database/database-connection';
import {
  LedgerDatabase,
  LedgerService,
  LedgerTransaction,
  PostingLeg,
  PostingResult,
} from '../ledger/ledger.service';
import { holds, transactions } from '../ledger/schema';
import { WalletInputError } from '../wallet/wallet.errors';
import { HoldNotFoundError, HoldStateError } from './trading.errors';

/** The other side of every trade: sells coins for USD and buys them back. */
export const MARKET_MAKER = 'market_maker';
/** Where trading fees go. */
export const FEES = 'fees';
/** Where coins come from: goes negative by every coin ever put into circulation. */
export const GENESIS = 'genesis';
/** Coins are priced and settled in this currency. */
export const QUOTE_CURRENCY = 'USD';

/**
 * Market maker inventory, in whole coins: when a trade leaves it below the floor, the same
 * database transaction refills it to the target from `genesis`, so buys never fail for lack of
 * coins.
 */
export const INVENTORY_FLOOR = 100n;
export const INVENTORY_TARGET = 1_000n;

export interface HoldInput {
  /** The limit order's id. */
  holdId: string;
  userId: number;
  asset: string;
  amount: bigint;
}

export interface SettleTradeInput {
  /** The market order's id: the ledger externalRef. */
  tradeId: string;
  userId: number;
  coin: string;
  side: string;
  /** Coin minor units. */
  qty: bigint;
  /** USD cents for `qty`, before the fee, already rounded by the market. */
  usdAmount: bigint;
  /** USD cents. */
  fee: bigint;
  /** The limit order's hold, captured by this trade; empty for a market order. */
  holdId?: string;
}

export interface Position {
  coin: string;
  /** Coin minor units bought and not sold since. */
  qty: bigint;
  /** USD cents paid for `qty`, fees included (average cost). */
  costBasis: bigint;
  /** USD cents per whole coin, rounded down. */
  averagePrice: bigint;
}

type Hold = typeof holds.$inferSelect;

/** A trade as stored in its transaction's metadata: what `positions` reads back. */
type TradeTerms = {
  tradeId: string;
  userId: number;
  coin: string;
  side: TradeSide;
  qty: string;
  usdAmount: string;
  fee: string;
  holdId: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The market's side of the ledger (phase 4): limit order holds and trade settlement. Every
 * method is idempotent by the id it gets, so the market can retry any call whose outcome it
 * doesn't know.
 */
@Injectable()
export class TradingService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: LedgerDatabase,
    private readonly ledger: LedgerService,
    private readonly relay: OutboxRelay,
  ) {}

  /**
   * Reserves `amount` for a limit order: inserts the ACTIVE hold and posts available → held
   * (type `hold`, externalRef = holdId) in one transaction. A retry returns the first posting;
   * the same id with other terms is refused.
   */
  async placeHold(input: HoldInput): Promise<PostingResult> {
    const holdId = uuid('holdId', input.holdId);
    const { userId, asset, amount } = input;
    positiveUserId(userId);
    if (!isAssetCode(asset)) {
      throw new WalletInputError(`asset ${asset} is not supported`);
    }
    if (amount <= 0n) {
      throw new WalletInputError('amount must be positive');
    }

    const user = await this.ledger.ensureAccounts(userId, asset);
    const result = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(holds)
        .values({ id: holdId, userId, asset, amount, status: 'ACTIVE' })
        .onConflictDoNothing()
        .returning({ id: holds.id });
      if (!inserted) {
        // Placed before (the row only exists together with its posting).
        const [existing] = await tx
          .select()
          .from(holds)
          .where(eq(holds.id, holdId));
        if (
          existing.userId !== userId ||
          existing.asset !== asset ||
          existing.amount !== amount
        ) {
          throw new WalletInputError(
            'holdId was already used for a different hold',
          );
        }
        return this.duplicate(tx, 'hold', holdId);
      }
      return this.ledger.postIn(tx, {
        type: 'hold',
        externalRef: holdId,
        legs: [
          { accountId: user.available, asset, amount: -amount },
          { accountId: user.held, asset, amount },
        ],
        metadata: { holdId, userId, asset, amount: toWire(amount) },
      });
    });
    return this.announced(result);
  }

  /**
   * Gives an ACTIVE hold back: held → available (type `release`, externalRef = holdId). Releasing
   * a released hold returns the first posting; a captured one is refused.
   */
  async releaseHold(holdIdInput: string): Promise<PostingResult> {
    const holdId = uuid('holdId', holdIdInput);
    const result = await this.db.transaction(async (tx) => {
      const hold = await this.lockHold(tx, holdId);
      if (hold.status === 'RELEASED') {
        return this.duplicate(tx, 'release', holdId);
      }
      if (hold.status === 'CAPTURED') {
        throw new HoldStateError(`hold ${holdId} was captured by a trade`);
      }
      const user = await this.ledger.ensureAccounts(hold.userId, hold.asset);
      const posted = await this.ledger.postIn(tx, {
        type: 'release',
        externalRef: holdId,
        legs: [
          { accountId: user.held, asset: hold.asset, amount: -hold.amount },
          { accountId: user.available, asset: hold.asset, amount: hold.amount },
        ],
        metadata: {
          holdId,
          userId: hold.userId,
          asset: hold.asset,
          amount: toWire(hold.amount),
        },
      });
      await this.setHoldStatus(tx, holdId, 'RELEASED');
      return posted;
    });
    return this.announced(result);
  }

  /**
   * Settles one trade against the market maker (type `trade`, externalRef = tradeId):
   *
   * - buy: user USD −(usd + fee), market maker USD +usd, fees +fee; market maker coin −qty,
   *   user coin +qty.
   * - sell: the mirror, with the fee taken out of the proceeds.
   *
   * With `holdId` the user's side comes out of that hold, whatever it doesn't need goes back to
   * available, and the hold is CAPTURED, all in the same transaction. The posting writes
   * `trade-executed` (Pulsar) and a `fill` for the user (RabbitMQ), and tops up the market
   * maker's coins when it ran low.
   */
  async settleTrade(input: SettleTradeInput): Promise<PostingResult> {
    const tradeId = uuid('tradeId', input.tradeId);
    const holdId = input.holdId ? uuid('holdId', input.holdId) : null;
    const { userId, coin, side, qty, usdAmount, fee } = input;
    positiveUserId(userId);
    if (!isCoin(coin)) {
      throw new WalletInputError(`coin ${coin} is not a coin`);
    }
    if (!isSide(side)) {
      throw new WalletInputError(
        `side must be one of: ${TRADE_SIDES.join(', ')}`,
      );
    }
    if (qty <= 0n) {
      throw new WalletInputError('qty must be positive');
    }
    if (usdAmount <= 0n) {
      throw new WalletInputError('usdAmount must be positive');
    }
    if (fee < 0n || fee > usdAmount) {
      throw new WalletInputError('fee must be between 0 and usdAmount');
    }

    const terms: TradeTerms = {
      tradeId,
      userId,
      coin,
      side,
      qty: toWire(qty),
      usdAmount: toWire(usdAmount),
      fee: toWire(fee),
      holdId,
    };
    // Accounts first, outside the transaction: creating them takes no locks the posting needs.
    const [userUsd, userCoin, makerUsd, makerCoin, fees, genesis] =
      await Promise.all([
        this.ledger.ensureAccounts(userId, QUOTE_CURRENCY),
        this.ledger.ensureAccounts(userId, coin),
        this.ledger.ensureSystemAccount(MARKET_MAKER, QUOTE_CURRENCY),
        this.ledger.ensureSystemAccount(MARKET_MAKER, coin),
        this.ledger.ensureSystemAccount(FEES, QUOTE_CURRENCY),
        this.ledger.ensureSystemAccount(GENESIS, coin),
      ]);

    const result = await this.db.transaction(async (tx) => {
      // The hold is locked before the duplicate check: a concurrent retry waits here, then
      // finds the first call's posting instead of a CAPTURED hold.
      const hold = holdId ? await this.lockHold(tx, holdId) : null;
      const existing = await this.ledger.findPosting(tx, 'trade', tradeId);
      if (existing) {
        if (canonical(existing.metadata) !== canonical(terms)) {
          throw new WalletInputError(
            'tradeId was already settled with different terms',
          );
        }
        return { transactionId: existing.id, duplicate: true };
      }
      if (hold) {
        checkHoldCovers(hold, terms, side === 'BUY' ? usdAmount + fee : qty);
      }

      const legs: PostingLeg[] = [];
      const leg = (accountId: bigint, asset: string, amount: bigint) => {
        if (amount !== 0n) legs.push({ accountId, asset, amount });
      };
      if (side === 'BUY') {
        const cost = usdAmount + fee;
        if (hold) {
          leg(userUsd.held, QUOTE_CURRENCY, -hold.amount);
          leg(userUsd.available, QUOTE_CURRENCY, hold.amount - cost);
        } else {
          leg(userUsd.available, QUOTE_CURRENCY, -cost);
        }
        leg(makerUsd, QUOTE_CURRENCY, usdAmount);
        leg(fees, QUOTE_CURRENCY, fee);
        leg(makerCoin, coin, -qty);
        leg(userCoin.available, coin, qty);
      } else {
        if (hold) {
          leg(userCoin.held, coin, -hold.amount);
          leg(userCoin.available, coin, hold.amount - qty);
        } else {
          leg(userCoin.available, coin, -qty);
        }
        leg(makerCoin, coin, qty);
        leg(makerUsd, QUOTE_CURRENCY, -usdAmount);
        leg(userUsd.available, QUOTE_CURRENCY, usdAmount - fee);
        leg(fees, QUOTE_CURRENCY, fee);
      }

      const posted = await this.ledger.postIn(tx, {
        type: 'trade',
        externalRef: tradeId,
        legs,
        metadata: terms,
        outbox: (transactionId) => [
          {
            transport: 'pulsar',
            destination: TRADE_EXECUTED_TOPIC,
            key: String(userId),
            payload: {
              tradeId,
              transactionId,
              userId,
              coin,
              side,
              qty: terms.qty,
              usdAmount: terms.usdAmount,
              fee: terms.fee,
            } satisfies TradeExecutedMessage,
          },
          {
            transport: 'rabbitmq',
            destination: REALTIME_EXCHANGE,
            key: userChannel(userId),
            payload: {
              type: 'fill',
              orderId: tradeId,
              transactionId,
              coin,
              side,
              qty: terms.qty,
              usdAmount: terms.usdAmount,
              fee: terms.fee,
            } satisfies RealtimeFillMessage,
          },
        ],
      });
      if (hold) {
        await this.setHoldStatus(tx, hold.id, 'CAPTURED');
      }
      await this.refillInventory(tx, tradeId, coin, makerCoin, genesis);
      return posted;
    });
    return this.announced(result);
  }

  /**
   * The user's open positions: per coin, the quantity bought and not sold since and its
   * average cost, replayed from their trades' metadata in order. A sell takes cost out at the
   * average price. Coins that arrived another way (the dev faucet) have no cost and aren't
   * counted; a sell of more than the position closes it.
   */
  async positions(userId: number): Promise<Position[]> {
    const rows = await this.db
      .select({ metadata: transactions.metadata })
      .from(transactions)
      .where(
        and(
          eq(transactions.type, 'trade'),
          sql`(${transactions.metadata} ->> 'userId') = ${String(userId)}`,
        ),
      )
      .orderBy(asc(transactions.createdAt), asc(transactions.id));

    const book = new Map<string, { qty: bigint; cost: bigint }>();
    for (const { metadata } of rows) {
      const trade = metadata as TradeTerms;
      const position = book.get(trade.coin) ?? { qty: 0n, cost: 0n };
      const qty = BigInt(trade.qty);
      if (trade.side === 'BUY') {
        position.qty += qty;
        position.cost += BigInt(trade.usdAmount) + BigInt(trade.fee);
      } else if (qty >= position.qty) {
        position.qty = 0n;
        position.cost = 0n;
      } else {
        position.cost -= (position.cost * qty) / position.qty;
        position.qty -= qty;
      }
      book.set(trade.coin, position);
    }

    return COINS.flatMap((coin) => {
      const position = book.get(coin);
      if (!position || position.qty === 0n) return [];
      const unit = 10n ** BigInt(ASSETS[coin as CoinCode].scale);
      return [
        {
          coin,
          qty: position.qty,
          costBasis: position.cost,
          averagePrice: (position.cost * unit) / position.qty,
        },
      ];
    });
  }

  /** Refills the market maker's `coin` to the target when this trade left it under the floor. */
  private async refillInventory(
    tx: LedgerTransaction,
    tradeId: string,
    coin: string,
    makerCoin: bigint,
    genesis: bigint,
  ): Promise<void> {
    const unit = 10n ** BigInt(ASSETS[coin as CoinCode].scale);
    // The posting above holds this account locked, so the balance can't move under us.
    const { rows } = await tx.execute<{ balance: string }>(
      sql`SELECT balance::text FROM accounts WHERE id = ${makerCoin}`,
    );
    const balance = BigInt(rows[0].balance);
    if (balance >= INVENTORY_FLOOR * unit) return;
    const amount = INVENTORY_TARGET * unit - balance;
    await this.ledger.postIn(tx, {
      type: 'inventory',
      externalRef: tradeId,
      legs: [
        { accountId: genesis, asset: coin, amount: -amount },
        { accountId: makerCoin, asset: coin, amount },
      ],
      metadata: { coin, tradeId },
    });
  }

  private async lockHold(tx: LedgerTransaction, holdId: string): Promise<Hold> {
    const [hold] = await tx
      .select()
      .from(holds)
      .where(eq(holds.id, holdId))
      .for('update');
    if (!hold) {
      throw new HoldNotFoundError(holdId);
    }
    return hold;
  }

  private async setHoldStatus(
    tx: LedgerTransaction,
    holdId: string,
    status: 'CAPTURED' | 'RELEASED',
  ): Promise<void> {
    await tx
      .update(holds)
      .set({ status, updatedAt: sql`now()` })
      .where(eq(holds.id, holdId));
  }

  private async duplicate(
    tx: LedgerTransaction,
    type: string,
    externalRef: string,
  ): Promise<PostingResult> {
    const posting = await this.ledger.findPosting(tx, type, externalRef);
    if (!posting) {
      // A hold row is only ever written together with its posting.
      throw new Error(`${type} ${externalRef} has no posting`);
    }
    return { transactionId: posting.id, duplicate: true };
  }

  /** New postings wrote outbox records: publish them now rather than at the next poll. */
  private announced(result: PostingResult): PostingResult {
    if (!result.duplicate) {
      this.relay.poke();
    }
    return result;
  }
}

function checkHoldCovers(hold: Hold, terms: TradeTerms, needed: bigint): void {
  const asset = terms.side === 'BUY' ? QUOTE_CURRENCY : terms.coin;
  if (hold.status !== 'ACTIVE') {
    throw new HoldStateError(`hold ${hold.id} is ${hold.status.toLowerCase()}`);
  }
  if (hold.userId !== terms.userId) {
    throw new WalletInputError('holdId belongs to another user');
  }
  if (hold.asset !== asset) {
    throw new WalletInputError(
      `holdId holds ${hold.asset}, a ${terms.side} needs ${asset}`,
    );
  }
  if (hold.amount < needed) {
    throw new WalletInputError(
      `holdId covers ${hold.amount}, the trade needs ${needed}`,
    );
  }
}

function uuid(field: string, value: string): string {
  if (!UUID.test(value ?? '')) {
    throw new WalletInputError(`${field} must be a UUID`);
  }
  return value.toLowerCase();
}

function positiveUserId(userId: number): void {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new WalletInputError('userId must be a positive integer');
  }
}

function isSide(side: string): side is TradeSide {
  return (TRADE_SIDES as readonly string[]).includes(side);
}

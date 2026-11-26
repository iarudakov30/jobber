import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { COINS, isCoin } from '@jobber/money';
import { DrizzleOutboxStore, OutboxRelay } from '@jobber/outbox';
import { DelayBucketSpec } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import {
  MarketInputError,
  OrderNotOpenError,
  QuoteExpiredError,
} from '../market/market.errors';
import { MAX_QTY, takeQuote } from '../market/market.service';
import { TRADE_SIDES, TradeSide, limitAmounts } from '../market/pricing';
import { REDIS } from '../redis/redis.module';
import { ORDER_EXPIRE } from '../topology';
import { OrderSettlement } from './order-settlement';
import { OrderRow, OrderStatus, OrderType, orders } from './schema';

/** The delay bucket `order.expire` goes through: how long a limit order stays open. */
export const ORDER_EXPIRY = Symbol('ORDER_EXPIRY');
export const ORDER_FAULTS = Symbol('ORDER_FAULTS');

/** The highest limit price: a million dollars a coin, as far as the pricing is tested. */
export const MAX_LIMIT_PRICE = 100_000_000n;
export const MAX_ORDERS_PAGE = 100;

/** Test hooks (acceptance test 7). */
export interface OrderFaults {
  /** Called after a market order is stored as SETTLING and before `SettleTrade`. */
  beforeSettle(order: OrderRow): void;
}

/**
 * `FAULT_CRASH_BEFORE_SETTLE=1` (ignored in production): the process exits after storing a
 * market order and before asking the wallet to settle it, leaving it SETTLING for recovery.
 */
export function faultsFromEnv(env = process.env): OrderFaults {
  const crash =
    env['NODE_ENV'] !== 'production' &&
    env['FAULT_CRASH_BEFORE_SETTLE'] === '1';
  return {
    beforeSettle(order) {
      if (crash) {
        new Logger('OrderFaults').warn(
          `FAULT_CRASH_BEFORE_SETTLE: exiting before settling order ${order.id}`,
        );
        process.exit(1);
      }
    },
  };
}

export interface PlaceOrderRequest {
  type: OrderType;
  quoteId?: string | null;
  coin?: string | null;
  side?: TradeSide | null;
  qty?: bigint | null;
  limitPrice?: bigint | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Order ids are uuids; PostgreSQL rejects anything else in a uuid comparison. */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: MarketDatabase,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly settlement: OrderSettlement,
    private readonly outbox: DrizzleOutboxStore,
    private readonly relay: OutboxRelay,
    @Inject(ORDER_EXPIRY) private readonly expiry: DelayBucketSpec,
    @Inject(ORDER_FAULTS) private readonly faults: OrderFaults,
  ) {}

  /**
   * Places an order and returns it as it stands when the wallet has answered: a market order
   * FILLED, a limit order OPEN, either REJECTED for lack of funds, or still SETTLING / PLACING
   * if the wallet didn't answer (recovery finishes it).
   *
   * `requestKey` is the request's `Idempotency-Key`. If an order was already placed with it
   * (the interceptor lost the first response), that order is returned, not a second one.
   */
  async place(
    userId: number,
    request: PlaceOrderRequest,
    requestKey?: string,
  ): Promise<OrderRow> {
    if (requestKey) {
      const [existing] = await this.db
        .select()
        .from(orders)
        .where(
          and(eq(orders.userId, userId), eq(orders.requestKey, requestKey)),
        );
      if (existing) {
        return existing;
      }
    }
    return request.type === 'MARKET'
      ? this.placeMarket(userId, request, requestKey)
      : this.placeLimit(userId, request, requestKey);
  }

  /** Cancels an open limit order and releases its hold. Cancelling it again returns it. */
  async cancel(userId: number, id: string): Promise<OrderRow> {
    if (!isUuid(id)) {
      throw new MarketInputError('id is not one of your orders');
    }
    const [cancelled] = await this.db
      .update(orders)
      .set({ status: 'CANCELLED', updatedAt: sql`now()` })
      .where(
        and(
          eq(orders.id, id),
          eq(orders.userId, userId),
          eq(orders.status, 'OPEN'),
        ),
      )
      .returning();
    if (cancelled) {
      return this.settlement.releaseHold(cancelled);
    }
    const current = await this.find(id, userId);
    if (!current) {
      throw new MarketInputError('id is not one of your orders');
    }
    if (current.status === 'CANCELLED') {
      return current;
    }
    throw new OrderNotOpenError(
      current.status === 'PLACING'
        ? 'The order is still being placed; try again in a moment'
        : `The order is ${current.status}; only an open order can be cancelled`,
    );
  }

  /**
   * `order.expire`: an open limit order becomes EXPIRED and its hold is released. Throws while
   * the order is still PLACING, so the command is retried once recovery has settled it.
   */
  async expire(orderId: string): Promise<string> {
    const [expired] = await this.db
      .update(orders)
      .set({ status: 'EXPIRED', updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'OPEN')))
      .returning();
    if (expired) {
      await this.settlement.releaseHold(expired);
      return 'expired';
    }
    const current = await this.find(orderId);
    if (current?.status === 'PLACING') {
      throw new Error(`order ${orderId} is still PLACING`);
    }
    return current ? `already ${current.status}` : 'no such order';
  }

  /** The user's orders, newest first, optionally only those in `statuses`. */
  list(
    userId: number,
    statuses: OrderStatus[] | null | undefined,
    first: number,
  ): Promise<OrderRow[]> {
    if (!Number.isInteger(first) || first < 1 || first > MAX_ORDERS_PAGE) {
      throw new MarketInputError(
        `first must be between 1 and ${MAX_ORDERS_PAGE}`,
      );
    }
    return this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.userId, userId),
          statuses?.length ? inArray(orders.status, statuses) : undefined,
        ),
      )
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(first);
  }

  async find(id: string, userId?: number): Promise<OrderRow | undefined> {
    const [row] = await this.db
      .select()
      .from(orders)
      .where(
        and(
          eq(orders.id, id),
          userId === undefined ? undefined : eq(orders.userId, userId),
        ),
      );
    return row;
  }

  /**
   * Uses up the quote, stores the order as SETTLING with the quote's terms, then settles it.
   * The order is stored before the wallet is called, so a crash in between leaves a SETTLING
   * order for recovery, never a trade the market doesn't know about.
   */
  private async placeMarket(
    userId: number,
    request: PlaceOrderRequest,
    requestKey?: string,
  ): Promise<OrderRow> {
    for (const field of ['coin', 'side', 'qty', 'limitPrice'] as const) {
      if (request[field] != null) {
        throw new MarketInputError(
          `${field} is only for limit orders: a market order takes everything from its quote`,
        );
      }
    }
    if (!request.quoteId) {
      throw new MarketInputError('quoteId is required for a market order');
    }
    const quote = await takeQuote(this.redis, userId, request.quoteId);
    if (!quote) {
      throw new QuoteExpiredError(
        'The quote has expired or was already used; get a new one',
      );
    }
    const [order] = await this.db
      .insert(orders)
      .values({
        userId,
        requestKey,
        coin: quote.coin,
        side: quote.side,
        type: 'MARKET',
        qty: BigInt(quote.qty),
        fillPrice: BigInt(quote.price),
        usdAmount: BigInt(quote.usdAmount),
        fee: BigInt(quote.fee),
        status: 'SETTLING',
      })
      .returning();
    this.faults.beforeSettle(order);
    return this.settlement.settle(order);
  }

  /**
   * Stores the order as PLACING together with its `order.expire` command (one transaction:
   * every limit order expires), then asks the wallet to hold its funds.
   */
  private async placeLimit(
    userId: number,
    request: PlaceOrderRequest,
    requestKey?: string,
  ): Promise<OrderRow> {
    if (request.quoteId != null) {
      throw new MarketInputError(
        'quoteId is only for market orders: a limit order fills at its limitPrice',
      );
    }
    const { coin, side, qty, limitPrice } = request;
    if (!coin || !isCoin(coin)) {
      throw new MarketInputError(`coin must be one of: ${COINS.join(', ')}`);
    }
    if (!side || !TRADE_SIDES.includes(side)) {
      throw new MarketInputError('side is required: BUY or SELL');
    }
    if (qty == null || qty <= 0n) {
      throw new MarketInputError('qty must be positive');
    }
    if (qty > MAX_QTY) {
      throw new MarketInputError('qty must be at most 1,000,000 coins');
    }
    if (limitPrice == null || limitPrice <= 0n) {
      throw new MarketInputError('limitPrice must be positive');
    }
    if (limitPrice > MAX_LIMIT_PRICE) {
      throw new MarketInputError('limitPrice must be at most $1,000,000.00');
    }
    const amounts = limitAmounts(limitPrice, side, qty);
    if (amounts.total <= 0n) {
      throw new MarketInputError(
        'qty is too small: the trade is worth less than a cent',
      );
    }

    const order = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(orders)
        .values({
          userId,
          requestKey,
          coin,
          side,
          type: 'LIMIT',
          qty,
          limitPrice,
          usdAmount: amounts.usdAmount,
          fee: amounts.fee,
          status: 'PLACING',
          expiresAt: new Date(Date.now() + this.expiry.ttlMs),
        })
        .returning();
      await this.outbox.enqueue(tx, [
        {
          transport: 'rabbitmq',
          destination: this.expiry.name,
          key: ORDER_EXPIRE,
          payload: { orderId: row.id },
        },
      ]);
      return row;
    });
    this.relay.poke();
    return this.settlement.placeHold(order);
  }
}

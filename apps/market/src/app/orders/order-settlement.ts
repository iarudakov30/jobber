import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { errorText } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import { holdFor } from '../market/pricing';
import { OrderRow, OrderStatus, orders } from './schema';
import {
  WalletClient,
  WalletRefusedError,
  WalletUnavailableError,
} from './wallet.client';

/** Waits between attempts of one wallet call whose outcome was unknown. */
const RETRY_DELAYS_MS = [200, 1_000];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * The wallet side of an order: settle it, place its hold, release its hold. Each call uses the
 * order's id (`tradeId`, `holdId`), so the wallet does it at most once however often it is
 * retried. Each one ends in a conditional update of the order:
 *
 * - the wallet did it → the next status;
 * - the wallet refused (too few funds, or a hold in the wrong state) → `REJECTED` with the
 *   reason, or, for a release, logged;
 * - no answer after three attempts → the order stays as it is, and `OrderRecovery` retries it
 *   later with the same id.
 */
@Injectable()
export class OrderSettlement {
  private readonly logger = new Logger(OrderSettlement.name);

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: MarketDatabase,
    private readonly wallet: WalletClient,
  ) {}

  /** A `SETTLING` order: `SettleTrade`, then `FILLED` (or `REJECTED`). */
  async settle(order: OrderRow): Promise<OrderRow> {
    try {
      const { transactionId } = await this.attempt(() =>
        this.wallet.settleTrade({
          tradeId: order.id,
          userId: order.userId,
          coin: order.coin,
          side: order.side,
          qty: order.qty.toString(),
          usdAmount: order.usdAmount.toString(),
          fee: order.fee.toString(),
          holdId: order.type === 'LIMIT' ? order.id : '',
        }),
      );
      return this.move(order, 'SETTLING', 'FILLED', { transactionId });
    } catch (error) {
      return this.failed(order, 'SETTLING', 'settle', error);
    }
  }

  /** A `PLACING` limit order: `PlaceHold`, then `OPEN` (or `REJECTED`). */
  async placeHold(order: OrderRow): Promise<OrderRow> {
    const hold = holdFor(order.coin, order.side, order.qty, order);
    try {
      await this.attempt(() =>
        this.wallet.placeHold({
          holdId: order.id,
          userId: order.userId,
          asset: hold.asset,
          amount: hold.amount.toString(),
        }),
      );
      return this.move(order, 'PLACING', 'OPEN');
    } catch (error) {
      return this.failed(order, 'PLACING', 'hold funds for', error);
    }
  }

  /** A `CANCELLED` or `EXPIRED` limit order: `ReleaseHold`, then `releasedAt`. */
  async releaseHold(order: OrderRow): Promise<OrderRow> {
    try {
      await this.attempt(() => this.wallet.releaseHold(order.id));
    } catch (error) {
      if (!(error instanceof WalletRefusedError)) {
        this.logger.warn(
          `Releasing the hold of order ${order.id} failed, will retry: ${errorText(error)}`,
        );
        return order;
      }
      // Only an OPEN order is cancelled or expired, and an OPEN order's hold was placed and is
      // captured only by a fill, which needs the order OPEN too. So this is a bug: stop
      // retrying, say so loudly.
      this.logger.error(
        `The wallet refused to release the hold of ${order.status} order ${order.id}: ${error.message}`,
      );
    }
    const [row] = await this.db
      .update(orders)
      .set({ releasedAt: sql`now()` })
      .where(eq(orders.id, order.id))
      .returning();
    return row ?? order;
  }

  /** Runs a wallet call, again (same id) when its outcome is unknown; at most three times. */
  private async attempt<T>(call: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await call();
      } catch (error) {
        if (
          !(error instanceof WalletUnavailableError) ||
          i >= RETRY_DELAYS_MS.length
        ) {
          throw error;
        }
        await sleep(RETRY_DELAYS_MS[i]);
      }
    }
  }

  private async failed(
    order: OrderRow,
    from: OrderStatus,
    what: string,
    error: unknown,
  ): Promise<OrderRow> {
    if (error instanceof WalletRefusedError) {
      if (!error.insufficientFunds) {
        this.logger.error(
          `The wallet refused to ${what} order ${order.id}: ${error.message}`,
        );
      }
      return this.move(order, from, 'REJECTED', { reason: error.message });
    }
    this.logger.warn(
      `Could not ${what} order ${order.id}, recovery will retry: ${errorText(error)}`,
    );
    return order;
  }

  /**
   * `from → to`, only if the order is still `from`. Otherwise someone else moved it first (a
   * retry by recovery, say) and the current row is returned unchanged.
   */
  private async move(
    order: OrderRow,
    from: OrderStatus,
    to: OrderStatus,
    fields: Partial<Pick<OrderRow, 'transactionId' | 'reason'>> = {},
  ): Promise<OrderRow> {
    const [row] = await this.db
      .update(orders)
      .set({ status: to, ...fields, updatedAt: sql`now()` })
      .where(and(eq(orders.id, order.id), eq(orders.status, from)))
      .returning();
    if (row) {
      return row;
    }
    const [current] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, order.id));
    return current ?? order;
  }
}

import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import { RealtimePriceMessage, errorText } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import { SimulatorService } from '../prices/simulator.service';
import { OrderSettlement } from './order-settlement';
import { OrderRow, orders } from './schema';

/** The lowest and highest price a coin had since the last match. */
export interface PriceRange {
  low: bigint;
  high: bigint;
}

/** Trades settled with the wallet at once by one match. */
const SETTLE_CONCURRENCY = 8;

/**
 * Fills limit orders on the simulator leader. After every tick it claims each open limit order
 * the price crossed (a buy when the price fell to its limit or below, a sell when it rose to its
 * limit or above) and settles it at its limit price.
 *
 * The claim is one conditional `UPDATE … SET status = 'SETTLING' WHERE status = 'OPEN' …`. A
 * cancel is the same kind of update, so of a cancel and a fill exactly one wins; two leaders
 * for a moment can't both claim an order either.
 *
 * A match that takes longer than a second doesn't queue ticks: the ticks in the meantime widen
 * one pending range per coin, and the next match uses that, so no crossing price is missed.
 */
@Injectable()
export class OrderMatcher implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(OrderMatcher.name);
  private pending = new Map<string, PriceRange>();
  private running?: Promise<void>;
  private failing = false;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: MarketDatabase,
    private readonly simulator: SimulatorService,
    private readonly settlement: OrderSettlement,
  ) {}

  onModuleInit(): void {
    this.simulator.onTick((ticks) => this.observe(ticks));
  }

  /** Lets a match in progress finish its settlements before the database closes. */
  async beforeApplicationShutdown(): Promise<void> {
    this.pending.clear();
    await this.running;
  }

  /** Adds ticks to the pending ranges and starts a match unless one is running. */
  observe(ticks: Pick<RealtimePriceMessage, 'coin' | 'price'>[]): void {
    for (const { coin, price } of ticks) {
      const value = BigInt(price);
      const range = this.pending.get(coin);
      this.pending.set(coin, {
        low: range && range.low < value ? range.low : value,
        high: range && range.high > value ? range.high : value,
      });
    }
    this.running ??= this.drain().finally(() => (this.running = undefined));
  }

  /**
   * Claims and settles every open limit order that `ranges` cross. Returns the claimed orders
   * as they ended up (FILLED, or SETTLING if the wallet didn't answer). Public for tests, which
   * use it to force a price.
   */
  async match(ranges: Map<string, PriceRange>): Promise<OrderRow[]> {
    if (ranges.size === 0) {
      return [];
    }
    const crossed = [...ranges].map(([coin, { low, high }]) =>
      and(
        eq(orders.coin, coin),
        or(
          and(eq(orders.side, 'BUY'), gte(orders.limitPrice, low)),
          and(eq(orders.side, 'SELL'), lte(orders.limitPrice, high)),
        ),
      ),
    );
    const claimed = await this.db
      .update(orders)
      .set({
        status: 'SETTLING',
        fillPrice: sql`${orders.limitPrice}`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(orders.status, 'OPEN'),
          eq(orders.type, 'LIMIT'),
          or(...crossed),
        ),
      )
      .returning();
    if (claimed.length === 0) {
      return [];
    }
    const settled: OrderRow[] = [];
    for (let i = 0; i < claimed.length; i += SETTLE_CONCURRENCY) {
      settled.push(
        ...(await Promise.all(
          claimed
            .slice(i, i + SETTLE_CONCURRENCY)
            .map((order) => this.settlement.settle(order)),
        )),
      );
    }
    const filled = settled.filter((o) => o.status === 'FILLED').length;
    this.logger.log(
      `Matched ${claimed.length} limit order(s): ${filled} filled` +
        (filled < claimed.length ? `, ${claimed.length - filled} not yet` : ''),
    );
    return settled;
  }

  private async drain(): Promise<void> {
    while (this.pending.size > 0) {
      const ranges = this.pending;
      this.pending = new Map();
      try {
        await this.match(ranges);
        if (this.failing) {
          this.failing = false;
          this.logger.log('Matching limit orders works again');
        }
      } catch (error) {
        // PostgreSQL is down: the orders stay OPEN and the next tick tries again.
        if (!this.failing) {
          this.failing = true;
          this.logger.warn(`Matching limit orders failed: ${errorText(error)}`);
        }
      }
    }
  }
}

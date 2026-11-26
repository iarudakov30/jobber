import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { errorText } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import { OrderSettlement } from './order-settlement';
import { OrderRow, orders } from './schema';

export const RECOVERY_OPTIONS = Symbol('RECOVERY_OPTIONS');

export interface RecoveryOptions {
  /** How often each replica looks for stuck orders. */
  intervalMs: number;
  /** How long an order may sit in a transient state before it counts as stuck. */
  staleMs: number;
}

export const DEFAULT_RECOVERY_OPTIONS: RecoveryOptions = {
  intervalMs: 10_000,
  staleMs: 30_000,
};

/** Orders retried per kind per run. */
const BATCH = 100;

export interface RecoveryRun {
  settled: OrderRow[];
  held: OrderRow[];
  released: OrderRow[];
}

/**
 * Finishes what a crash, a timeout or an unreachable wallet left half done, on every replica,
 * every 10 s. An order counts as stuck once it hasn't changed for 30 s:
 *
 * - `SETTLING` → `SettleTrade` again with the same `tradeId` and terms; the wallet settles it
 *   at most once and answers a repeat with `duplicate: true`. Then `FILLED`.
 * - `PLACING` → `PlaceHold` again with the same `holdId`. Then `OPEN` (or `REJECTED`).
 * - `CANCELLED` or `EXPIRED` with the hold not yet released → `ReleaseHold` again.
 *
 * Two replicas retrying the same order at once is harmless for the same reasons.
 */
@Injectable()
export class OrderRecovery
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OrderRecovery.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: MarketDatabase,
    private readonly settlement: OrderSettlement,
    @Inject(RECOVERY_OPTIONS) private readonly options: RecoveryOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.schedule();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** One pass over the stuck orders. Public for tests. */
  async runOnce(): Promise<RecoveryRun> {
    const stale = sql`now() - make_interval(secs => ${this.options.staleMs / 1_000})`;
    const stuck = (where: ReturnType<typeof and>) =>
      this.db
        .select()
        .from(orders)
        .where(and(where, lt(orders.updatedAt, stale)))
        .orderBy(asc(orders.updatedAt))
        .limit(BATCH);

    const settling = await stuck(eq(orders.status, 'SETTLING'));
    const settled = await this.each(settling, (o) => this.settlement.settle(o));
    const placing = await stuck(eq(orders.status, 'PLACING'));
    const held = await this.each(placing, (o) => this.settlement.placeHold(o));
    const unreleased = await stuck(
      and(
        eq(orders.type, 'LIMIT'),
        inArray(orders.status, ['CANCELLED', 'EXPIRED']),
        isNull(orders.releasedAt),
      ),
    );
    const released = await this.each(unreleased, (o) =>
      this.settlement.releaseHold(o),
    );

    if (settling.length + placing.length + unreleased.length > 0) {
      this.logger.log(
        `Recovered stuck orders: ${describe(settled, 'settled')}, ${describe(held, 'placed')}, ` +
          `${unreleased.length} release(s) retried`,
      );
    }
    return { settled, held, released };
  }

  private schedule(): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(async () => {
      this.running = this.runOnce().catch((error) =>
        this.logger.warn(`Order recovery failed: ${errorText(error)}`),
      );
      await this.running;
      this.running = undefined;
      this.schedule();
    }, this.options.intervalMs);
  }

  /** One at a time: a backlog after an outage shouldn't hit the wallet all at once. */
  private async each(
    rows: OrderRow[],
    fn: (order: OrderRow) => Promise<OrderRow>,
  ): Promise<OrderRow[]> {
    const out: OrderRow[] = [];
    for (const row of rows) {
      if (this.stopped) {
        break;
      }
      out.push(await fn(row));
    }
    return out;
  }
}

function describe(rows: OrderRow[], done: string): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return rows.length === 0
    ? `0 ${done}`
    : [...counts].map(([status, n]) => `${n} → ${status}`).join(', ');
}

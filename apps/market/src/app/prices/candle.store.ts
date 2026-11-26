import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import { Candle } from './candle-builder';
import { ONE_MINUTE, candles } from './schema';

@Injectable()
export class CandleStore {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: MarketDatabase,
  ) {}

  /**
   * Inserts 1-minute candles, merging into a row that already exists: the earlier open stays,
   * high and low widen, the later close wins. Two leaders writing the same minute (one handing
   * over to the other in the middle of it) therefore end up with one candle covering both.
   * At most one candle per (coin, start) per call.
   */
  async upsert(rows: Candle[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db
      .insert(candles)
      .values(rows.map((row) => ({ ...row, interval: ONE_MINUTE })))
      .onConflictDoUpdate({
        target: [candles.coin, candles.interval, candles.start],
        set: {
          high: sql`GREATEST(${sql.raw('candles.high')}, excluded.high)`,
          low: sql`LEAST(${sql.raw('candles.low')}, excluded.low)`,
          close: sql`excluded.close`,
        },
      });
  }

  /** A coin's 1-minute candles with `from <= start < to`, oldest first. */
  async range(coin: string, from: Date, to: Date): Promise<Candle[]> {
    return this.db
      .select({
        coin: candles.coin,
        start: candles.start,
        open: candles.open,
        high: candles.high,
        low: candles.low,
        close: candles.close,
      })
      .from(candles)
      .where(
        and(
          eq(candles.coin, coin),
          eq(candles.interval, ONE_MINUTE),
          gte(candles.start, from),
          lt(candles.start, to),
        ),
      )
      .orderBy(asc(candles.start));
  }

  /** Each coin's first open at or after `since`: the reference for a 24 h change. */
  async opensSince(since: Date): Promise<Map<string, bigint>> {
    const rows = await this.db
      .selectDistinctOn([candles.coin], {
        coin: candles.coin,
        open: candles.open,
      })
      .from(candles)
      .where(and(eq(candles.interval, ONE_MINUTE), gte(candles.start, since)))
      .orderBy(candles.coin, asc(candles.start));
    return new Map(rows.map((row) => [row.coin, row.open]));
  }
}

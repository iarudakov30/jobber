import { Injectable, Logger } from '@nestjs/common';
import { errorText } from '@jobber/rabbitmq';
import { backfillDayStart } from '../backfill';
import { Candle, MINUTE_MS } from '../candle-builder';
import { CandleStore } from '../candle.store';
import { LIVE_COINS, LiveCoin } from '../coins';
import { ProviderName } from '../providers/price-provider';
import { LivePrices } from './live-prices';

const DAY_MS = 86_400_000;

/** `MARKET_LIVE_PRICES` is off: nothing may reach the exchanges. */
export class LivePricesOffError extends Error {
  override readonly name = 'LivePricesOffError';
}

/** Every provider refused or couldn't be reached. */
export class HistoryUnavailableError extends Error {
  override readonly name = 'HistoryUnavailableError';
}

export interface LoadedDay {
  /** Minutes written (the others already had a candle). */
  written: number;
  /** Candles the provider returned. */
  candles: number;
  provider: ProviderName;
}

const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/**
 * The live coins' past from the exchanges' 1-minute candles, asked in preference order (the next
 * one when an exchange refuses or can't be reached). Only minutes without a candle are written:
 * one the leader built from its own ticks always wins, since those are the prices people traded
 * at. Works on any replica: the providers' REST side needs no connection.
 */
@Injectable()
export class LiveHistory {
  private readonly logger = new Logger(LiveHistory.name);
  private filling: Promise<void> | null = null;

  constructor(
    private readonly live: LivePrices,
    private readonly store: CandleStore,
  ) {}

  /**
   * `GenerateCandles` for a live coin: the day's candles, today's only up to the last completed
   * minute. Throws `BackfillDayError`, `LivePricesOffError` or `HistoryUnavailableError`.
   */
  async loadDay(
    coin: LiveCoin,
    day: string,
    now = Date.now(),
  ): Promise<LoadedDay> {
    const start = backfillDayStart(day, now, true);
    if (!this.live.enabled) {
      throw new LivePricesOffError(
        `live prices are off (MARKET_LIVE_PRICES): ${coin}'s candles come from the exchanges`,
      );
    }
    const end = Math.min(start + DAY_MS, floorToMinute(now));
    const { candles, provider } = await this.fetch(coin, start, end);
    const written = await this.store.insertMissing(candles);
    return { written, candles: candles.length, provider };
  }

  /**
   * On becoming leader: fills each live coin's missing minutes of the last 24 h (up to the
   * minute that has just started), so a fresh install's charts aren't empty and a gap left by a
   * leader change is closed. Best effort: failures are logged, never thrown. One fill at a time.
   */
  fillRecent(now = Date.now()): Promise<void> {
    if (!this.live.enabled) {
      return Promise.resolve();
    }
    this.filling ??= this.fill(now).finally(() => {
      this.filling = null;
    });
    return this.filling;
  }

  private async fill(now: number): Promise<void> {
    const to = floorToMinute(now);
    const from = to - DAY_MS;
    const complete: LiveCoin[] = [];
    for (const coin of LIVE_COINS) {
      try {
        const have = new Set(
          (await this.store.range(coin, new Date(from), new Date(to))).map(
            (candle) => candle.start.getTime(),
          ),
        );
        let first = -1;
        let last = -1;
        let missing = 0;
        for (let minute = from; minute < to; minute += MINUTE_MS) {
          if (!have.has(minute)) {
            missing += 1;
            if (first < 0) first = minute;
            last = minute;
          }
        }
        if (missing === 0) {
          complete.push(coin);
          continue;
        }
        // One range from the first missing minute to the last: the minutes in between that
        // have a candle are skipped by insertMissing, and it's one or a few requests either way.
        const { candles, provider } = await this.fetch(
          coin,
          first,
          last + MINUTE_MS,
        );
        const written = await this.store.insertMissing(candles);
        this.logger.log(
          `${coin}: filled ${written} of ${missing} missing minute(s) of the last 24 h from ${provider}`,
        );
      } catch (error) {
        this.logger.warn(
          `${coin}: the last 24 h weren't filled: ${errorText(error)}`,
        );
      }
    }
    if (complete.length > 0) {
      this.logger.log(
        `No minute of the last 24 h missing for ${complete.join(', ')}`,
      );
    }
  }

  /** Candles with `from <= start < to` from the first provider that gives them. */
  private async fetch(
    coin: LiveCoin,
    from: number,
    to: number,
  ): Promise<{ candles: Candle[]; provider: ProviderName }> {
    const failures: string[] = [];
    for (const provider of this.live.providers) {
      try {
        return {
          candles: await provider.candles(coin, new Date(from), new Date(to)),
          provider: provider.name,
        };
      } catch (error) {
        failures.push(errorText(error));
        this.logger.warn(`${coin} candles: ${errorText(error)}`);
      }
    }
    throw new HistoryUnavailableError(
      `no exchange gave ${coin}'s candles: ${failures.join('; ')}`,
    );
  }
}

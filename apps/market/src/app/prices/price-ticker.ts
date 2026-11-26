import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  REALTIME_EXCHANGE,
  RabbitPublisher,
  RealtimePriceMessage,
  errorText,
  priceChannel,
} from '@jobber/rabbitmq';
import { Candle, CandleBuilder, mergeCandles } from './candle-builder';
import { CandleStore } from './candle.store';
import { PriceSimulator } from './price-walk';
import { PriceStore } from './price.store';

export const SIMULATOR_SEED = Symbol('SIMULATOR_SEED');

/** A tick is useless a few seconds later; RabbitMQ drops it if no gateway took it by then. */
export const PRICE_EXPIRATION_MS = 5_000;

/** Unsaved candles kept while PostgreSQL is down: a day of every coin. Older ones are dropped. */
const MAX_UNSAVED = 4 * 1_440;

/** Logs the first failure of something that runs every second, and its recovery, not each one. */
class Outage {
  private down = false;

  constructor(
    private readonly logger: Logger,
    private readonly what: string,
  ) {}

  failed(error: unknown): void {
    if (!this.down) {
      this.down = true;
      this.logger.warn(`${this.what} failed: ${errorText(error)}`);
    }
  }

  ok(): void {
    if (this.down) {
      this.down = false;
      this.logger.log(`${this.what} works again`);
    }
  }
}

/**
 * What the leader does each second: step every coin's walk, store the prices in Redis (which
 * numbers them), publish them to RabbitMQ `realtime` / `prices.<coin>`, and add them to the
 * 1-minute candles, writing each candle to PostgreSQL once its minute is over.
 */
@Injectable()
export class PriceTicker {
  private readonly logger = new Logger(PriceTicker.name);
  private readonly simulator: PriceSimulator;
  private readonly candles = new CandleBuilder();
  private unsaved: Candle[] = [];
  private saving = false;
  private readonly publishing = new Outage(this.logger, 'Publishing prices');
  private readonly writing = new Outage(this.logger, 'Writing candles');

  constructor(
    @Inject(SIMULATOR_SEED) seed: number,
    private readonly prices: PriceStore,
    private readonly candleStore: CandleStore,
    private readonly publisher: RabbitPublisher,
  ) {
    this.simulator = new PriceSimulator(seed);
  }

  get seed(): number {
    return this.simulator.seed;
  }

  /** Before leading: continue from the last prices any leader stored, not from the defaults. */
  async resume(): Promise<void> {
    const latest = await this.prices.latest();
    this.simulator.resume(
      Object.fromEntries(latest.map((p) => [p.coin, p.mid])),
    );
  }

  /** One tick at `at` (epoch ms). Throws only if Redis couldn't store it: then nothing is sent. */
  async tick(at: number): Promise<RealtimePriceMessage[]> {
    const ticks = this.simulator.next();
    for (const { coin, shock } of ticks) {
      if (shock !== 0) {
        this.logger.log(
          `News shock: ${coin} ${shock > 0 ? '+' : ''}${(shock * 100).toFixed(1)}%`,
        );
      }
    }
    const seqs = await this.prices.record(
      ticks.map((tick) => ({ ...tick, source: 'simulator' as const })),
      at,
    );
    const messages = ticks.map((tick, i): RealtimePriceMessage => ({
      type: 'price',
      coin: tick.coin,
      price: tick.price.toString(),
      seq: seqs[i],
      at,
      source: 'simulator',
    }));
    for (const tick of ticks) {
      const finished = this.candles.add(tick.coin, tick.price, at);
      if (finished) {
        this.unsaved.push(finished);
      }
    }
    await Promise.all([this.publish(messages), this.saveCandles()]);
    return messages;
  }

  /** When leadership ends: write the minutes in progress, for the next leader to merge into. */
  async flush(): Promise<void> {
    this.unsaved.push(...this.candles.drain());
    await this.saveCandles();
  }

  private async publish(messages: RealtimePriceMessage[]): Promise<void> {
    try {
      await Promise.all(
        messages.map((message) =>
          this.publisher.publish(
            REALTIME_EXCHANGE,
            priceChannel(message.coin),
            message,
            {
              messageId: `price-${message.coin}-${message.seq}`,
              persistent: false,
              expirationMs: PRICE_EXPIRATION_MS,
            },
          ),
        ),
      );
      this.publishing.ok();
    } catch (error) {
      // Prices aren't retried: the next tick replaces this one a second later.
      this.publishing.failed(error);
    }
  }

  private async saveCandles(): Promise<void> {
    if (this.saving || this.unsaved.length === 0) {
      return;
    }
    this.saving = true;
    const batch = mergeCandles(this.unsaved);
    this.unsaved = [];
    try {
      await this.candleStore.upsert(batch);
      this.writing.ok();
    } catch (error) {
      this.writing.failed(error);
      this.unsaved = [...batch, ...this.unsaved].slice(-MAX_UNSAVED);
    } finally {
      this.saving = false;
    }
  }
}

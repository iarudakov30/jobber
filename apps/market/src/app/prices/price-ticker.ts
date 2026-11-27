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
import { LiveCoin, isLive } from './coins';
import { LivePrices } from './live/live-prices';
import { PriceSimulator, toCents } from './price-walk';
import { PriceStore } from './price.store';

export const SIMULATOR_SEED = Symbol('SIMULATOR_SEED');

/** A tick is useless a few seconds later; RabbitMQ drops it if no gateway took it by then. */
export const PRICE_EXPIRATION_MS = 5_000;

/** A previous leader's live price older than this is no reference for the bad print guard. */
const LIVE_REFERENCE_MAX_AGE_MS = 60_000;

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
 * What the leader does each second: step every simulated coin's walk and take each live coin's
 * price from the exchanges (`LivePrices`; a live coin nobody prices gets no tick), store the
 * prices in Redis (which numbers them), publish them to RabbitMQ `realtime` / `prices.<coin>`,
 * and add them to the 1-minute candles, writing each candle to PostgreSQL once its minute is over.
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
  private liveReferences: Partial<Record<LiveCoin, number>> = {};

  constructor(
    @Inject(SIMULATOR_SEED) seed: number,
    private readonly prices: PriceStore,
    private readonly candleStore: CandleStore,
    private readonly publisher: RabbitPublisher,
    private readonly live: LivePrices,
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
    const now = Date.now();
    this.liveReferences = Object.fromEntries(
      latest
        .filter(
          (p) => isLive(p.coin) && now - p.at <= LIVE_REFERENCE_MAX_AGE_MS,
        )
        .map((p) => [p.coin, p.mid]),
    );
  }

  /** While leading: connect the exchanges (when `MARKET_LIVE_PRICES=on`). */
  startLive(): void {
    this.live.start(this.liveReferences);
  }

  /** When leadership ends: disconnect them. */
  stopLive(): Promise<void> {
    return this.live.stop();
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
    const all = [
      ...ticks.map((tick) => ({ ...tick, source: 'simulator' as const })),
      ...this.live.pick(at).map((pick) => ({
        coin: pick.coin,
        price: toCents(pick.price),
        mid: pick.price,
        source: pick.source,
      })),
    ];
    const seqs = await this.prices.record(all, at);
    const messages = all.map((tick, i): RealtimePriceMessage => ({
      type: 'price',
      coin: tick.coin,
      price: tick.price.toString(),
      seq: seqs[i],
      at,
      source: tick.source,
    }));
    for (const tick of all) {
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

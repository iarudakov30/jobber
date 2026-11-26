import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { COINS, CoinCode, isCoin } from '@jobber/money';
import { Candle } from '../prices/candle-builder';
import { CandleStore } from '../prices/candle.store';
import { COIN_SPECS } from '../prices/coins';
import { PriceStore } from '../prices/price.store';
import { REDIS } from '../redis/redis.module';
import { MarketInputError, PricesUnavailableError } from './market.errors';
import { COIN_UNIT, TradeAmounts, TradeSide, quoteAmounts } from './pricing';

/** How long a quote can be turned into an order. */
export const QUOTE_TTL_MS = 10_000;
/** A price older than this means no replica is leading the simulator: no quotes. */
export const STALE_PRICE_MS = 10_000;
/** The largest quantity one quote may cover: a million coins. */
export const MAX_QTY = 1_000_000n * COIN_UNIT;
/** The longest candle range one request may ask for: a day of 1-minute candles. */
export const MAX_CANDLE_RANGE_MS = 24 * 60 * 60_000;

export interface PriceTickView {
  price: bigint;
  seq: number;
  at: Date;
}

export interface CoinView {
  code: CoinCode;
  name: string;
  tick: PriceTickView | null;
  open24h: bigint | null;
}

export interface QuoteView extends TradeAmounts {
  id: string;
  coin: CoinCode;
  side: TradeSide;
  qty: bigint;
  expiresAt: Date;
}

/**
 * What `placeOrder` (step 4) will consume from `quote:<id>` with GETDEL. Amounts are
 * minor-units strings.
 */
export interface StoredQuote {
  userId: number;
  coin: CoinCode;
  side: TradeSide;
  qty: string;
  price: string;
  usdAmount: string;
  fee: string;
}

export function quoteKey(id: string): string {
  return `quote:${id}`;
}

@Injectable()
export class MarketService {
  constructor(
    private readonly prices: PriceStore,
    private readonly candleStore: CandleStore,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Every coin with its latest price (null before the first tick) and its price 24 h ago. */
  async coins(now = Date.now()): Promise<CoinView[]> {
    const [latest, opens] = await Promise.all([
      this.prices.latest(),
      this.candleStore.opensSince(new Date(now - 24 * 60 * 60_000)),
    ]);
    return COINS.map((code) => {
      const snapshot = latest.find((p) => p.coin === code);
      return {
        code,
        name: COIN_SPECS[code].name,
        tick: snapshot
          ? {
              price: snapshot.price,
              seq: snapshot.seq,
              at: new Date(snapshot.at),
            }
          : null,
        open24h: opens.get(code) ?? null,
      };
    });
  }

  /** 1-minute candles with `from <= start < to`; by default the last 24 hours. */
  async candles(
    coin: string,
    from?: Date | null,
    to?: Date | null,
  ): Promise<Candle[]> {
    requireCoin(coin);
    const end = to ?? new Date();
    const start = from ?? new Date(end.getTime() - MAX_CANDLE_RANGE_MS);
    if (start >= end) {
      throw new MarketInputError('from must be before to');
    }
    if (end.getTime() - start.getTime() > MAX_CANDLE_RANGE_MS) {
      throw new MarketInputError('from must be at most 24 hours before to');
    }
    return this.candleStore.range(coin, start, end);
  }

  /**
   * Prices `qty` of `coin` at the current mid plus the spread, and keeps the quote in Redis for
   * 10 s under `quote:<id>`: the price a market order placed in that time will get.
   */
  async quote(
    userId: number,
    coin: string,
    side: TradeSide,
    qty: bigint,
    now = Date.now(),
  ): Promise<QuoteView> {
    requireCoin(coin);
    if (qty <= 0n) {
      throw new MarketInputError('qty must be positive');
    }
    if (qty > MAX_QTY) {
      throw new MarketInputError('qty must be at most 1,000,000 coins');
    }
    const snapshot = await this.prices.get(coin);
    if (!snapshot || now - snapshot.at > STALE_PRICE_MS) {
      throw new PricesUnavailableError(
        `${coin} has no price right now; try again in a few seconds`,
      );
    }
    const amounts = quoteAmounts(snapshot.price, side, qty);
    if (amounts.total <= 0n) {
      throw new MarketInputError(
        'qty is too small: the trade is worth less than a cent',
      );
    }
    const id = randomUUID();
    const stored: StoredQuote = {
      userId,
      coin,
      side,
      qty: qty.toString(),
      price: amounts.price.toString(),
      usdAmount: amounts.usdAmount.toString(),
      fee: amounts.fee.toString(),
    };
    await this.redis.set(
      quoteKey(id),
      JSON.stringify(stored),
      'PX',
      QUOTE_TTL_MS,
    );
    return {
      id,
      coin,
      side,
      qty,
      ...amounts,
      expiresAt: new Date(now + QUOTE_TTL_MS),
    };
  }
}

function requireCoin(coin: string): asserts coin is CoinCode {
  if (!isCoin(coin)) {
    throw new MarketInputError(`coin must be one of: ${COINS.join(', ')}`);
  }
}

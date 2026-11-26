import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { COINS, CoinCode } from '@jobber/money';
import { REDIS } from '../redis/redis.module';

/**
 * Bumps the coin's `seq` and stores its new price in one step. `seq` lives in Redis rather than
 * in the leader's memory, so it keeps increasing when another replica takes over.
 */
const RECORD = `
local seq = redis.call('HINCRBY', KEYS[1], 'seq', 1)
redis.call('HSET', KEYS[1], 'price', ARGV[1], 'mid', ARGV[2], 'at', ARGV[3])
return seq`;

export interface PriceSnapshot {
  coin: CoinCode;
  /** USD cents per whole coin. */
  price: bigint;
  /** The walk's unrounded value. */
  mid: number;
  seq: number;
  /** Epoch milliseconds. */
  at: number;
}

export function priceKey(coin: string): string {
  return `price:${coin}`;
}

/** The latest price of each coin, in the hash `price:<coin>` (`price`, `mid`, `seq`, `at`). */
@Injectable()
export class PriceStore {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Stores one tick per coin; returns each one's `seq`, in the same order. */
  async record(
    ticks: { coin: CoinCode; price: bigint; mid: number }[],
    at: number,
  ): Promise<number[]> {
    const pipeline = this.redis.pipeline();
    for (const tick of ticks) {
      pipeline.eval(
        RECORD,
        1,
        priceKey(tick.coin),
        tick.price.toString(),
        String(tick.mid),
        String(at),
      );
    }
    return results(await pipeline.exec()).map(Number);
  }

  /** The coins that have a price, in `COINS` order. */
  async latest(): Promise<PriceSnapshot[]> {
    const pipeline = this.redis.pipeline();
    for (const coin of COINS) {
      pipeline.hgetall(priceKey(coin));
    }
    const hashes = results(await pipeline.exec()) as Record<string, string>[];
    return COINS.flatMap((coin, i) => {
      const { price, mid, seq, at } = hashes[i];
      return price && mid && seq && at
        ? [
            {
              coin,
              price: BigInt(price),
              mid: Number(mid),
              seq: Number(seq),
              at: Number(at),
            },
          ]
        : [];
    });
  }

  async get(coin: CoinCode): Promise<PriceSnapshot | undefined> {
    return (await this.latest()).find((p) => p.coin === coin);
  }
}

/** A pipeline's results, or its first error. */
function results(replies: [Error | null, unknown][] | null): unknown[] {
  if (!replies) {
    throw new Error('Redis pipeline was discarded');
  }
  return replies.map(([error, value]) => {
    if (error) {
      throw error;
    }
    return value;
  });
}

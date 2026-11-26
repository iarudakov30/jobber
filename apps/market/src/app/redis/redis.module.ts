import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS = Symbol('REDIS');

/**
 * A client that fails fast: with no offline queue, a command sent while Redis is down rejects
 * at once instead of waiting, so a tick or a quote never stalls. ioredis reconnects in the
 * background.
 */
export function connectRedis(url: string): Redis {
  const logger = new Logger('Redis');
  const redis = new Redis(url, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  let down = false;
  const report = (reason: string) => {
    if (!down) {
      down = true;
      logger.warn(`Redis unavailable (${reason})`);
    }
  };
  // Without an 'error' listener ioredis would crash the process.
  redis.on('error', (error: Error) => report(error.message));
  redis.on('close', () => report('connection closed'));
  redis.on('ready', () => {
    if (down) {
      logger.log('Redis is back');
    }
    down = false;
  });
  return redis;
}

/** Prices, quotes and the simulator's leader lock live in Redis. */
@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      useFactory: (config: ConfigService) =>
        connectRedis(config.getOrThrow('REDIS_URL')),
      inject: [ConfigService],
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationShutdown(): void {
    this.redis.disconnect();
  }
}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LiveModule } from './live/live.module';
import { PriceStore } from './price.store';
import { PriceTicker, SIMULATOR_SEED } from './price-ticker';
import { randomSeed } from './random';
import {
  DEFAULT_SIMULATOR_OPTIONS,
  SIMULATOR_OPTIONS,
  SimulatorOptions,
  SimulatorService,
} from './simulator.service';

/**
 * The price simulator and what it writes: prices in Redis, candles in PostgreSQL, ticks to
 * RabbitMQ. Needs the global `RedisModule`, `DatabaseModule` and `RabbitModule`.
 */
@Module({
  imports: [LiveModule],
  providers: [
    PriceStore,
    PriceTicker,
    SimulatorService,
    {
      provide: SIMULATOR_SEED,
      useFactory: (config: ConfigService) => {
        const seed = config.get<string>('MARKET_SEED');
        if (!seed) {
          return randomSeed();
        }
        if (!/^\d+$/.test(seed)) {
          throw new Error(`MARKET_SEED must be a whole number, got "${seed}"`);
        }
        return Number(seed);
      },
      inject: [ConfigService],
    },
    {
      provide: SIMULATOR_OPTIONS,
      useFactory: (config: ConfigService): SimulatorOptions => ({
        ...DEFAULT_SIMULATOR_OPTIONS,
        enabled: config.get('MARKET_SIMULATOR', 'on') !== 'off',
      }),
      inject: [ConfigService],
    },
  ],
  exports: [PriceStore, SimulatorService, LiveModule],
})
export class PricesModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CandleStore } from '../candle.store';
import { LiveHistory } from './live-history';
import {
  LIVE_PRICES_OPTIONS,
  LivePrices,
  livePricesOptionsFromEnv,
} from './live-prices';

/**
 * The exchanges: `LivePrices` (the leader's stream) and `LiveHistory` (their candles, on any
 * replica), one instance each, shared by the simulator (`PricesModule`) and `GenerateCandles`
 * (`BackfillModule`). Needs the global `ConfigModule` and `DatabaseModule`.
 */
@Module({
  providers: [
    CandleStore,
    LivePrices,
    LiveHistory,
    {
      provide: LIVE_PRICES_OPTIONS,
      useFactory: (config: ConfigService) =>
        livePricesOptionsFromEnv((name) => config.get<string>(name)),
      inject: [ConfigService],
    },
  ],
  exports: [CandleStore, LivePrices, LiveHistory],
})
export class LiveModule {}

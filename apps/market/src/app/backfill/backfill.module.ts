import { Module } from '@nestjs/common';
import { CandleStore } from '../prices/candle.store';
import { MarketController } from './market.controller';

/**
 * gRPC `MarketService.GenerateCandles` (served on `MARKET_GRPC_SERVICE_URL`, see `main.ts`).
 * Needs only the global `DatabaseModule`.
 */
@Module({
  controllers: [MarketController],
  providers: [CandleStore],
})
export class BackfillModule {}

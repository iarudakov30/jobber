import { Module } from '@nestjs/common';
import { LiveModule } from '../prices/live/live.module';
import { MarketController } from './market.controller';

/**
 * gRPC `MarketService.GenerateCandles` (served on `MARKET_GRPC_SERVICE_URL`, see `main.ts`).
 * Needs the global `ConfigModule` and `DatabaseModule`.
 */
@Module({
  imports: [LiveModule],
  controllers: [MarketController],
})
export class BackfillModule {}

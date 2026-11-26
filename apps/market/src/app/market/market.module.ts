import { Module } from '@nestjs/common';
import { GrpcClientsModule } from '../grpc/grpc-clients.module';
import { PricesModule } from '../prices/prices.module';
import { MarketResolver } from './market.resolver';
import { MarketService } from './market.service';

/** The market data API: coins, candles, quotes. */
@Module({
  imports: [PricesModule, GrpcClientsModule],
  providers: [MarketService, MarketResolver],
})
export class MarketModule {}

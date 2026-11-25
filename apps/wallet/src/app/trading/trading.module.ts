import { Module } from '@nestjs/common';
import { LedgerModule } from '../ledger/ledger.module';
import { TradingService } from './trading.service';

/** Holds and trade settlement for the market (gRPC) and `positions` (GraphQL). */
@Module({
  imports: [LedgerModule],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}

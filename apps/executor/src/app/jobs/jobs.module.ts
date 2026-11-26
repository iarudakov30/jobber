import { Module } from '@nestjs/common';
import { PulsarModule } from '@jobber/pulsar';
import { FibonacciConsumer } from './fibonacci/fibonacci.consumer';
import { LoadProductsModule } from './products/load-products.module';
import { JobClientsModule } from './job-clients.module';
import { LedgerAuditModule } from './ledger-audit/ledger-audit.module';
import { BackfillCandlesModule } from './backfill-candles/backfill-candles.module';

@Module({
  imports: [
    PulsarModule,
    LoadProductsModule,
    LedgerAuditModule,
    BackfillCandlesModule,
    JobClientsModule,
  ],
  providers: [FibonacciConsumer],
})
export class JobsModule {}

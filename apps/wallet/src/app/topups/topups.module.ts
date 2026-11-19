import { Module } from '@nestjs/common';
import { PulsarModule } from '@jobber/pulsar';
import { LedgerModule } from '../ledger/ledger.module';
import { PaymentSucceededConsumer } from './payment-succeeded.consumer';

/** Top-ups paid through `payments` (Stripe), credited from `payment-succeeded`. */
@Module({
  imports: [PulsarModule, LedgerModule],
  providers: [PaymentSucceededConsumer],
})
export class TopUpsModule {}

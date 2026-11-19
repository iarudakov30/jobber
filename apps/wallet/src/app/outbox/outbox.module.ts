import { Global, Module } from '@nestjs/common';
import {
  DrizzleOutboxStore,
  OutboxRelay,
  PulsarOutboxPublisher,
  RabbitOutboxPublisher,
} from '@jobber/outbox';
import { PulsarClient, PulsarModule } from '@jobber/pulsar';
import { RabbitPublisher } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION } from '../database/database-connection';
import { LedgerDatabase } from '../ledger/ledger.service';

/**
 * The wallet's outbox relay, shared by transfers (`transfer-completed`, Pulsar) and top-ups
 * (`email.topup`, RabbitMQ). Needs `RabbitModule` (global, from the app module).
 */
@Global()
@Module({
  imports: [PulsarModule],
  providers: [
    {
      provide: DrizzleOutboxStore,
      useFactory: (db: LedgerDatabase) => new DrizzleOutboxStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      // Starts polling on application bootstrap and stops before shutdown.
      provide: OutboxRelay,
      useFactory: (
        store: DrizzleOutboxStore,
        pulsarClient: PulsarClient,
        rabbitPublisher: RabbitPublisher,
      ) =>
        new OutboxRelay(store, [
          new PulsarOutboxPublisher(pulsarClient, 'wallet'),
          new RabbitOutboxPublisher(rabbitPublisher, 'wallet'),
        ]),
      inject: [DrizzleOutboxStore, PulsarClient, RabbitPublisher],
    },
  ],
  exports: [DrizzleOutboxStore, OutboxRelay],
})
export class OutboxModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import {
  DrizzleIdempotencyStore,
  IDEMPOTENCY_LOCK,
  IDEMPOTENCY_STORE,
  IdempotencyCleanup,
  RedisIdempotencyLock,
} from '@jobber/idempotency';
import {
  DrizzleOutboxStore,
  OutboxRelay,
  PulsarOutboxPublisher,
  RabbitOutboxPublisher,
} from '@jobber/outbox';
import { PulsarClient, PulsarModule } from '@jobber/pulsar';
import { RabbitPublisher } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, PaymentsDatabase } from '../database/database';
import { PaymentCommandsConsumer } from './payment-commands.consumer';
import { PaymentsResolver } from './payments.resolver';
import { PaymentsService } from './payments.service';
import { stripeClientProvider } from './stripe.client';
import { StripeWebhookController } from './stripe-webhook.controller';

/** Needs `RabbitModule` (global) from the app module, which owns the topology. */
@Module({
  imports: [
    PulsarModule,
    ClientsModule.registerAsync([
      {
        // GqlAuthGuard calls Authenticate.
        name: Packages.AUTH,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.getOrThrow('AUTH_GRPC_SERVICE_URL'),
            package: Packages.AUTH,
            protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
            loader: GRPC_LOADER_OPTIONS,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [StripeWebhookController],
  providers: [
    PaymentsService,
    PaymentsResolver,
    PaymentCommandsConsumer,
    stripeClientProvider,
    {
      provide: DrizzleOutboxStore,
      useFactory: (db: PaymentsDatabase) => new DrizzleOutboxStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      // One relay for both brokers: payment-succeeded to Pulsar, payment.expire to RabbitMQ.
      provide: OutboxRelay,
      useFactory: (
        store: DrizzleOutboxStore,
        pulsarClient: PulsarClient,
        rabbitPublisher: RabbitPublisher,
      ) =>
        new OutboxRelay(store, [
          new PulsarOutboxPublisher(pulsarClient, 'payments'),
          new RabbitOutboxPublisher(rabbitPublisher, 'payments'),
        ]),
      inject: [DrizzleOutboxStore, PulsarClient, RabbitPublisher],
    },
    // @Idempotent() on createTopUp: PostgreSQL is the guarantee, Redis the fast path.
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (db: PaymentsDatabase) => new DrizzleIdempotencyStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      provide: IDEMPOTENCY_LOCK,
      useFactory: (configService: ConfigService) =>
        RedisIdempotencyLock.connect(configService.getOrThrow('REDIS_URL')),
      inject: [ConfigService],
    },
    {
      provide: IdempotencyCleanup,
      useFactory: (store: DrizzleIdempotencyStore) =>
        new IdempotencyCleanup(store),
      inject: [IDEMPOTENCY_STORE],
    },
  ],
})
export class PaymentsModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  RabbitOutboxPublisher,
} from '@jobber/outbox';
import { RabbitPublisher, delayBucket } from '@jobber/rabbitmq';
import { DATABASE_CONNECTION, MarketDatabase } from '../database/database';
import { GrpcClientsModule } from '../grpc/grpc-clients.module';
import { PricesModule } from '../prices/prices.module';
import { OrderCommandsConsumer } from './order-commands.consumer';
import { OrderMatcher } from './order-matcher';
import {
  DEFAULT_RECOVERY_OPTIONS,
  OrderRecovery,
  RECOVERY_OPTIONS,
} from './order-recovery';
import { OrderSettlement } from './order-settlement';
import { OrdersResolver } from './orders.resolver';
import {
  ORDER_EXPIRY,
  ORDER_FAULTS,
  OrdersService,
  faultsFromEnv,
} from './orders.service';
import { WalletClient } from './wallet.client';

/**
 * Orders: placing, matching on the simulator leader, cancelling, expiring through a delay
 * bucket, and recovering what was left half done. Needs the global `RedisModule`,
 * `DatabaseModule` and `RabbitModule` (whose topology declares `market.commands`).
 */
@Module({
  imports: [PricesModule, GrpcClientsModule],
  providers: [
    WalletClient,
    OrderSettlement,
    OrdersService,
    OrdersResolver,
    OrderMatcher,
    OrderRecovery,
    OrderCommandsConsumer,
    {
      provide: ORDER_EXPIRY,
      useFactory: (config: ConfigService) =>
        delayBucket(config.get('ORDER_EXPIRY_BUCKET', 'delay.24h')),
      inject: [ConfigService],
    },
    { provide: ORDER_FAULTS, useFactory: () => faultsFromEnv() },
    { provide: RECOVERY_OPTIONS, useValue: DEFAULT_RECOVERY_OPTIONS },
    {
      provide: DrizzleOutboxStore,
      useFactory: (db: MarketDatabase) => new DrizzleOutboxStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      // order.expire into a delay bucket; the market publishes nothing to Pulsar.
      provide: OutboxRelay,
      useFactory: (store: DrizzleOutboxStore, publisher: RabbitPublisher) =>
        new OutboxRelay(store, [
          new RabbitOutboxPublisher(publisher, 'market'),
        ]),
      inject: [DrizzleOutboxStore, RabbitPublisher],
    },
    // @Idempotent() on placeOrder: PostgreSQL is the guarantee, Redis the fast path.
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (db: MarketDatabase) => new DrizzleIdempotencyStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      provide: IDEMPOTENCY_LOCK,
      useFactory: (config: ConfigService) =>
        RedisIdempotencyLock.connect(config.getOrThrow('REDIS_URL')),
      inject: [ConfigService],
    },
    {
      provide: IdempotencyCleanup,
      useFactory: (store: DrizzleIdempotencyStore) =>
        new IdempotencyCleanup(store),
      inject: [IDEMPOTENCY_STORE],
    },
  ],
  exports: [OrdersService, OrderMatcher, OrderRecovery],
})
export class OrdersModule {}

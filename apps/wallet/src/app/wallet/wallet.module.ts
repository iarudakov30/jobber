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
import { DATABASE_CONNECTION } from '../database/database-connection';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerDatabase } from '../ledger/ledger.service';
import { WalletController } from './wallet.controller';
import { WalletResolver } from './wallet.resolver';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    LedgerModule,
    ClientsModule.registerAsync([
      {
        // GqlAuthGuard (Authenticate) and transfers by email (FindUserByEmail).
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
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletResolver,
    // @Idempotent() on transfer: PostgreSQL is the guarantee, Redis the fast path.
    {
      provide: IDEMPOTENCY_STORE,
      useFactory: (db: LedgerDatabase) => new DrizzleIdempotencyStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      provide: IDEMPOTENCY_LOCK,
      useFactory: (configService: ConfigService) =>
        RedisIdempotencyLock.connect(configService.getOrThrow('REDIS_URL')),
      inject: [ConfigService],
    },
    {
      // Deletes expired keys hourly.
      provide: IdempotencyCleanup,
      useFactory: (store: DrizzleIdempotencyStore) =>
        new IdempotencyCleanup(store),
      inject: [IDEMPOTENCY_STORE],
    },
  ],
})
export class WalletModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import {
  DrizzleOutboxStore,
  OutboxRelay,
  PulsarOutboxPublisher,
} from '@jobber/outbox';
import { PulsarClient, PulsarModule } from '@jobber/pulsar';
import { DATABASE_CONNECTION } from '../database/database-connection';
import { LedgerModule } from '../ledger/ledger.module';
import { LedgerDatabase } from '../ledger/ledger.service';
import { WalletController } from './wallet.controller';
import { WalletResolver } from './wallet.resolver';
import { WalletService } from './wallet.service';

@Module({
  imports: [
    LedgerModule,
    PulsarModule,
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
    {
      provide: DrizzleOutboxStore,
      useFactory: (db: LedgerDatabase) => new DrizzleOutboxStore(db),
      inject: [DATABASE_CONNECTION],
    },
    {
      // Starts polling on application bootstrap and stops before shutdown.
      provide: OutboxRelay,
      useFactory: (store: DrizzleOutboxStore, pulsarClient: PulsarClient) =>
        new OutboxRelay(store, [
          new PulsarOutboxPublisher(pulsarClient, 'wallet'),
        ]),
      inject: [DrizzleOutboxStore, PulsarClient],
    },
  ],
})
export class WalletModule {}

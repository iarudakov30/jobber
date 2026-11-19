import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { LoggerModule } from '@jobber/nestjs';
import { RabbitModule, notificationsTopology } from '@jobber/rabbitmq';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { LedgerModule } from './ledger/ledger.module';
import { OutboxModule } from './outbox/outbox.module';
import { TopUpsModule } from './topups/topups.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    // Declares the notifications exchange and the email queue, so an email published before the
    // executor ever ran still has a queue to wait in.
    RabbitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.getOrThrow('RABBITMQ_URL'),
        topology: notificationsTopology(),
        connectionName: 'wallet',
      }),
    }),
    OutboxModule,
    LedgerModule,
    WalletModule,
    TopUpsModule,
    // Nx runs the app from the workspace root.
    GraphQLModule.forRoot<ApolloDriverConfig>(
      graphQLOptions(join(process.cwd(), 'apps/wallet/schema.gql')),
    ),
  ],
})
export class AppModule {}

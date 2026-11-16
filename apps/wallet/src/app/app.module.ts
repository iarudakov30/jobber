import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { LoggerModule } from '@jobber/nestjs';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { LedgerModule } from './ledger/ledger.module';
import { WalletModule } from './wallet/wallet.module';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    LedgerModule,
    WalletModule,
    // Nx runs the app from the workspace root.
    GraphQLModule.forRoot<ApolloDriverConfig>(
      graphQLOptions(join(process.cwd(), 'apps/wallet/schema.gql')),
    ),
  ],
})
export class AppModule {}

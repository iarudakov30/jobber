import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { LoggerModule } from '@jobber/nestjs';
import { RabbitModule } from '@jobber/rabbitmq';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { PaymentsModule } from './payments/payments.module';
import { paymentsTopology } from './payments/topology';

@Module({
  imports: [
    LoggerModule,
    // .env.local (gitignored: the Stripe secrets) first, so its values win over .env.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['apps/payments/.env.local', 'apps/payments/.env'],
    }),
    DatabaseModule,
    RabbitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.getOrThrow('RABBITMQ_URL'),
        topology: paymentsTopology(),
        connectionName: 'payments',
      }),
    }),
    PaymentsModule,
    // Nx runs the app from the workspace root.
    GraphQLModule.forRoot<ApolloDriverConfig>(
      graphQLOptions(join(process.cwd(), 'apps/payments/schema.gql')),
    ),
  ],
})
export class AppModule {}

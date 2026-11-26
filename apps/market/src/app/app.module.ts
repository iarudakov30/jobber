import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { LoggerModule } from '@jobber/nestjs';
import { RabbitModule } from '@jobber/rabbitmq';
import { DatabaseModule } from './database/database.module';
import { graphQLOptions } from './graphql.options';
import { MarketModule } from './market/market.module';
import { OrdersModule } from './orders/orders.module';
import { RedisModule } from './redis/redis.module';
import { marketTopology } from './topology';

@Module({
  imports: [
    LoggerModule,
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    RedisModule,
    RabbitModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        url: configService.getOrThrow('RABBITMQ_URL'),
        topology: marketTopology(),
        connectionName: 'market',
      }),
    }),
    MarketModule,
    OrdersModule,
    // Nx runs the app from the workspace root.
    GraphQLModule.forRoot<ApolloDriverConfig>(
      graphQLOptions(join(process.cwd(), 'apps/market/schema.gql')),
    ),
  ],
})
export class AppModule {}

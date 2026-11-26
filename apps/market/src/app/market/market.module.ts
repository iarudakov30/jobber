import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import { PricesModule } from '../prices/prices.module';
import { MarketResolver } from './market.resolver';
import { MarketService } from './market.service';

/** The GraphQL API: coins, candles, quotes. */
@Module({
  imports: [
    PricesModule,
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
  providers: [MarketService, MarketResolver],
})
export class MarketModule {}

import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { join } from 'path';
import { GRPC_LOADER_OPTIONS, Packages } from '@jobber/grpc';
import { PulsarModule } from '@jobber/pulsar';
import { JobClientsModule } from '../job-clients.module';
import { BackfillCandlesConsumer } from './backfill-candles.consumer';

@Module({
  imports: [
    PulsarModule,
    JobClientsModule,
    ClientsModule.registerAsync([
      {
        name: Packages.MARKET,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            // Optional, like the wallet's: deployments without the market still start; the client
            // only connects when a BackfillCandles message arrives.
            url:
              configService.get<string>('MARKET_GRPC_SERVICE_URL') ??
              'localhost:5004',
            package: Packages.MARKET,
            protoPath: join(__dirname, '../../libs/grpc/proto/market.proto'),
            loader: GRPC_LOADER_OPTIONS,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [BackfillCandlesConsumer],
})
export class BackfillCandlesModule {}

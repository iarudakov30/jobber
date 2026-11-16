import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { PulsarModule } from '@jobber/pulsar';
import { Packages, GRPC_LOADER_OPTIONS } from '@jobber/grpc';

import { join } from 'path';

import { LoadProductsConsumer } from './load-products.consumer';
import { JobClientsModule } from '../job-clients.module';

@Module({
  imports: [
    PulsarModule,
    JobClientsModule,
    ClientsModule.registerAsync([
      {
        name: Packages.PRODUCTS,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.getOrThrow('PRODUCTS_GRPC_SERVICE_URL'),
            package: Packages.PRODUCTS,
            protoPath: join(__dirname, '../../libs/grpc/proto/products.proto'),
            loader: GRPC_LOADER_OPTIONS,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  providers: [LoadProductsConsumer],
})
export class LoadProductsModule {}

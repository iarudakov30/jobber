import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigService } from '@nestjs/config';

import { DiscoveryModule } from '@golevelup/nestjs-discovery';

import { join } from 'path';

import { Packages } from '@jobber/grpc';
import { PulsarClient, PulsarModule } from '@jobber/pulsar';
import {
  OutboxRelay,
  PrismaOutboxStore,
  PulsarOutboxPublisher,
} from '@jobber/outbox';

import { FibonacciJob } from './jobs/fibonacci/fibonacci.job';
import { JobsService } from './jobs.service';
import { JobsResolver } from './jobs.resolver';
import { LoadProductsJob } from './jobs/products/load-products.job';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { JobsController } from './jobs.controller';

@Module({
  imports: [
    DiscoveryModule,
    PulsarModule,
    PrismaModule,
    ClientsModule.registerAsync([
      {
        name: Packages.AUTH,
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            url: configService.getOrThrow('AUTH_GRPC_SERVICE_URL'),
            package: Packages.AUTH,
            protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [JobsController],
  providers: [
    FibonacciJob,
    JobsService,
    JobsResolver,
    LoadProductsJob,
    {
      provide: PrismaOutboxStore,
      useFactory: (prisma: PrismaService) => new PrismaOutboxStore(prisma),
      inject: [PrismaService],
    },
    {
      // Starts polling on application bootstrap and stops before shutdown.
      provide: OutboxRelay,
      useFactory: (store: PrismaOutboxStore, pulsarClient: PulsarClient) =>
        new OutboxRelay(store, [
          new PulsarOutboxPublisher(pulsarClient, 'jobs'),
        ]),
      inject: [PrismaOutboxStore, PulsarClient],
    },
  ],
})
export class JobsModule {}

import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { DiscoveryModule } from '@golevelup/nestjs-discovery';

import { join } from 'path';

import { Packages } from '@jobber/grpc';
import { PulsarModule } from '@jobber/pulsar';

import { FibonacciJob } from './jobs/fibonacci/fibonacci.job';
import { JobsService } from './jobs.service';
import { JobsResolver } from './jobs.resolver';

@Module({
  imports: [
    DiscoveryModule,
    PulsarModule,
    ClientsModule.register([
      {
        name: Packages.AUTH,
        transport: Transport.GRPC,
        options: {
          package: Packages.AUTH,
          protoPath: join(__dirname, '../../libs/grpc/proto/auth.proto'),
        },
      },
    ]),
  ],
  providers: [FibonacciJob, JobsService, JobsResolver],
})
export class JobsModule {}

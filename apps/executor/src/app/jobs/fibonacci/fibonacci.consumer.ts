import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { FibonacciMessage, PulsarClient } from '@jobber/pulsar';
import { Jobs } from '@jobber/nestjs';
import { iterate } from 'fibonacci';
import { JobsConsumer } from '../jobs.consumer';
import { Packages } from '@jobber/grpc';
import { ClientGrpc } from '@nestjs/microservices';

@Injectable()
export class FibonacciConsumer
  extends JobsConsumer<FibonacciMessage>
  implements OnModuleInit
{
  constructor(
    pulsarClient: PulsarClient,
    @Inject(Packages.JOBS) private clientJobs: ClientGrpc,
  ) {
    super(Jobs.FIBONACCI, pulsarClient, clientJobs);
  }

  protected async execute(data: FibonacciMessage): Promise<void> {
    const result = iterate(data.iterations);
    this.logger.log(`FibonacciConsumer: ${JSON.stringify(result)}`);
  }
}

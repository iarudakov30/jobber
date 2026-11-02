import { FibonacciMessage } from '@jobber/pulsar';
import { Jobs } from '@jobber/nestjs';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { Job } from '../../decorators/job.decorator';
import { AbstractJob } from '../abstract.job';
import { PrismaService } from '../../prisma/prisma.service';

@Job({
  name: Jobs.FIBONACCI,
  description: 'Generate a Fibonacci sequence and store it in the DB.',
})
export class FibonacciJob extends AbstractJob<FibonacciMessage> {
  protected messageClass = FibonacciMessage;
  constructor(
    prismaService: PrismaService,
    outbox: PrismaOutboxStore,
    outboxRelay: OutboxRelay,
  ) {
    super(prismaService, outbox, outboxRelay);
  }
}

import { LoadProductsMessage } from '@jobber/pulsar';
import { Jobs } from '@jobber/nestjs';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { Job } from '../../decorators/job.decorator';
import { AbstractJob } from '../abstract.job';
import { PrismaService } from '../../prisma/prisma.service';

@Job({
  name: Jobs.LOAD_PRODUCTS,
  description: 'Loads uploaded product data into the DB after enrichment.',
})
export class LoadProductsJob extends AbstractJob<LoadProductsMessage> {
  protected messageClass = LoadProductsMessage;
  constructor(
    prismaService: PrismaService,
    outbox: PrismaOutboxStore,
    outboxRelay: OutboxRelay,
  ) {
    super(prismaService, outbox, outboxRelay);
  }
}

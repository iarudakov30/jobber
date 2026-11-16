import { LedgerAuditMessage } from '@jobber/pulsar';
import { Jobs } from '@jobber/nestjs';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { Job } from '../../decorators/job.decorator';
import { AbstractJob } from '../abstract.job';
import { PrismaService } from '../../prisma/prisma.service';

@Job({
  name: Jobs.LEDGER_AUDIT,
  description:
    "Checks the wallet ledger: every cached balance against its entries, every transaction's sums. Runs nightly; data: {}.",
})
export class LedgerAuditJob extends AbstractJob<LedgerAuditMessage> {
  protected messageClass = LedgerAuditMessage;
  constructor(
    prismaService: PrismaService,
    outbox: PrismaOutboxStore,
    outboxRelay: OutboxRelay,
  ) {
    super(prismaService, outbox, outboxRelay);
  }
}

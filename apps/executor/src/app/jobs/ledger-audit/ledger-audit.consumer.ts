import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ClientGrpc } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import {
  Packages,
  WALLET_SERVICE_NAME,
  WalletServiceClient,
} from '@jobber/grpc';
import { Jobs } from '@jobber/nestjs';
import { LedgerAuditMessage, PulsarClient } from '@jobber/pulsar';
import { JobsConsumer } from '../jobs.consumer';

/**
 * Runs the wallet's ledger audit and reports what it found in the log: one line when the books
 * are sound, an error line per issue otherwise. Issues are findings, not failures: the job still
 * completes. If the wallet can't be reached, the message is retried, then dead-lettered.
 */
@Injectable()
export class LedgerAuditConsumer
  extends JobsConsumer<LedgerAuditMessage>
  implements OnModuleInit
{
  private walletService: WalletServiceClient;

  constructor(
    pulsarClient: PulsarClient,
    @Inject(Packages.JOBS) clientJobs: ClientGrpc,
    @Inject(Packages.WALLET) private readonly clientWallet: ClientGrpc,
  ) {
    super(Jobs.LEDGER_AUDIT, pulsarClient, clientJobs);
  }

  async onModuleInit(): Promise<void> {
    this.walletService =
      this.clientWallet.getService<WalletServiceClient>(WALLET_SERVICE_NAME);
    await super.onModuleInit();
  }

  protected async execute(data: LedgerAuditMessage): Promise<void> {
    const run = `Ledger audit (job ${data.jobId}, ${data.trigger ?? 'manual'})`;
    const { issues = [] } = await firstValueFrom(
      this.walletService.runAudit({}),
    );
    if (!issues.length) {
      this.logger.log(`${run}: no issues`);
      return;
    }
    this.logger.error(`${run}: ${issues.length} issue(s)`);
    for (const issue of issues) {
      this.logger.error(`${run}: ${issue.kind}: ${issue.detail}`);
    }
  }
}

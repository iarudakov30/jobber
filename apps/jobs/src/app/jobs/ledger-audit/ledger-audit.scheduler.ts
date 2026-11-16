import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { CronJob } from 'cron';
import { Jobs } from '@jobber/nestjs';
import { JobsService } from '../../jobs.service';

/** Nightly at 03:00 UTC. Override with `LEDGER_AUDIT_CRON` (a cron expression, or `off`). */
export const DEFAULT_LEDGER_AUDIT_CRON = '0 3 * * *';
export const LEDGER_AUDIT_CRON_NAME = 'ledger-audit';

/**
 * Starts a `LedgerAudit` job on a schedule. The job goes through the normal path (Job row +
 * outbox → Pulsar → executor → `WalletService.RunAudit`), so it shows in `jobs` and in Jaeger like
 * any other. Each `jobs` replica schedules its own run; extra runs are harmless (the audit only
 * reads).
 */
@Injectable()
export class LedgerAuditScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(LedgerAuditScheduler.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    const cronTime =
      this.configService.get<string>('LEDGER_AUDIT_CRON') ??
      DEFAULT_LEDGER_AUDIT_CRON;
    if (cronTime === 'off') {
      this.logger.log('Ledger audit schedule is off (LEDGER_AUDIT_CRON=off)');
      return;
    }
    const job = CronJob.from({
      cronTime,
      onTick: () => this.run(),
      timeZone: 'UTC',
      start: true,
    });
    this.schedulerRegistry.addCronJob(LEDGER_AUDIT_CRON_NAME, job);
    this.logger.log(
      `Ledger audit scheduled (${cronTime} UTC); next run ${job.nextDate().toISO()}`,
    );
  }

  /** Creates one LedgerAudit job; failures are logged, the schedule keeps going. */
  run(): Promise<void> {
    return trace
      .getTracer('jobs')
      .startActiveSpan('ledger-audit schedule', async (span) => {
        try {
          const job = await this.jobsService.executeJob(Jobs.LEDGER_AUDIT, {
            trigger: 'schedule',
          });
          this.logger.log(`Started ledger audit job ${job.id}`);
        } catch (error) {
          span.recordException(error as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          this.logger.error(`Starting the ledger audit failed: ${error}`);
        } finally {
          span.end();
        }
      });
  }
}

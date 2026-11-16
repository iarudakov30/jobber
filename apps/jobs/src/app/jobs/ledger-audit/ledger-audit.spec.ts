import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Jobs } from '@jobber/nestjs';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { LedgerAuditMessage } from '@jobber/pulsar';
import { JobsService } from '../../jobs.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LedgerAuditJob } from './ledger-audit.job';
import {
  DEFAULT_LEDGER_AUDIT_CRON,
  LEDGER_AUDIT_CRON_NAME,
  LedgerAuditScheduler,
} from './ledger-audit.scheduler';

describe('LedgerAuditJob', () => {
  function job() {
    const tx = {
      job: {
        create: jest.fn(({ data }) => Promise.resolve({ id: 11, ...data })),
      },
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const instance = new LedgerAuditJob(
      {
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService,
      outbox as unknown as PrismaOutboxStore,
      { poke: jest.fn() } as unknown as OutboxRelay,
    );
    const run = (data: unknown) =>
      instance.execute(data as LedgerAuditMessage, Jobs.LEDGER_AUDIT);
    return { run, outbox };
  }

  it.each([[{}], [{ trigger: 'schedule' }], [{ trigger: 'manual' }]])(
    'creates a one-item job for %p',
    async (data) => {
      const { run, outbox } = job();

      const created = await run(data);

      expect(created).toMatchObject({ id: 11, name: 'LedgerAudit', size: 1 });
      expect(outbox.enqueue).toHaveBeenCalledWith(expect.anything(), [
        {
          transport: 'pulsar',
          destination: 'LedgerAudit',
          key: '11',
          payload: { ...data, jobId: 11, index: 0 },
        },
      ]);
    },
  );

  it('rejects an unknown trigger', async () => {
    await expect(job().run({ trigger: 'cron' })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('LedgerAuditScheduler', () => {
  let registry: SchedulerRegistry;
  const executeJob = jest.fn();

  function scheduler(env: Record<string, string> = {}) {
    return new LedgerAuditScheduler(
      { executeJob } as unknown as JobsService,
      registry,
      { get: (key: string) => env[key] } as unknown as ConfigService,
    );
  }

  beforeEach(() => {
    registry = new SchedulerRegistry();
    executeJob.mockReset();
  });

  afterEach(() => {
    for (const cron of registry.getCronJobs().values()) {
      cron.stop();
    }
  });

  it('runs nightly at 03:00 UTC by default', () => {
    scheduler().onApplicationBootstrap();

    const cron = registry.getCronJob(LEDGER_AUDIT_CRON_NAME);
    expect(cron.cronTime.source).toBe(DEFAULT_LEDGER_AUDIT_CRON);
    const next = cron.nextDate().toUTC();
    expect([next.hour, next.minute]).toEqual([3, 0]);
    expect(cron.isActive).toBe(true);
  });

  it('takes its schedule from LEDGER_AUDIT_CRON', () => {
    scheduler({ LEDGER_AUDIT_CRON: '*/5 * * * *' }).onApplicationBootstrap();

    expect(registry.getCronJob(LEDGER_AUDIT_CRON_NAME).cronTime.source).toBe(
      '*/5 * * * *',
    );
  });

  it('schedules nothing with LEDGER_AUDIT_CRON=off', () => {
    scheduler({ LEDGER_AUDIT_CRON: 'off' }).onApplicationBootstrap();

    expect(registry.doesExist('cron', LEDGER_AUDIT_CRON_NAME)).toBe(false);
  });

  it('starts a LedgerAudit job marked as scheduled', async () => {
    executeJob.mockResolvedValue({ id: 5 });

    await scheduler().run();

    expect(executeJob).toHaveBeenCalledWith('LedgerAudit', {
      trigger: 'schedule',
    });
  });

  it('keeps the schedule alive when starting the job fails', async () => {
    executeJob.mockRejectedValue(new Error('database down'));

    await expect(scheduler().run()).resolves.toBeUndefined();
  });
});

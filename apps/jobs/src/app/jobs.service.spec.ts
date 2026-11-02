import { BadRequestException } from '@nestjs/common';
import { DiscoveryService } from '@golevelup/nestjs-discovery';

import { JobsService } from './jobs.service';
import { PrismaService } from './prisma/prisma.service';

describe('JobsService.acknowledge', () => {
  let queryRaw: jest.Mock;
  let service: JobsService;

  beforeEach(() => {
    queryRaw = jest.fn();
    service = new JobsService(
      {} as DiscoveryService,
      { $queryRaw: queryRaw } as unknown as PrismaService,
    );
  });

  it('acknowledges in one statement keyed by job and index', async () => {
    const job = { id: 7, size: 2, completed: 1, status: 'IN_PROGRESS' };
    queryRaw.mockResolvedValue([job]);

    await expect(service.acknowledge(7, 1)).resolves.toEqual(job);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('INSERT INTO "JobItem"');
    expect(strings.join('?')).toContain('ON CONFLICT DO NOTHING');
    expect(values).toContain(7);
    expect(values).toContain(1);
  });

  it('rejects an unknown job', async () => {
    queryRaw.mockResolvedValue([]);

    await expect(service.acknowledge(99, 0)).rejects.toThrow(
      new BadRequestException('Job 99 not found.'),
    );
  });

  it('rejects an index outside the job', async () => {
    queryRaw.mockResolvedValue([
      { id: 7, size: 2, completed: 0, status: 'IN_PROGRESS' },
    ]);

    await expect(service.acknowledge(7, 2)).rejects.toThrow(
      new BadRequestException('Job 7 has no item 2.'),
    );
  });
});

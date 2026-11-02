import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import {
  DiscoveredClassWithMeta,
  DiscoveryService,
} from '@golevelup/nestjs-discovery';
import { readFileSync } from 'fs';

import { JOB_METADATA_KEY } from './decorators/job.decorator';
import { JobMetadata } from './interfaces/job-metadata.interface';
import { AbstractJob } from './jobs/abstract.job';
import { UPLOAD_FILE_PATH } from './uploads/upload';
import { PrismaService } from './prisma/prisma.service';
import { JobStatus } from './models/job-status.enum';

@Injectable()
export class JobsService implements OnModuleInit {
  private jobs: DiscoveredClassWithMeta<JobMetadata>[] = [];

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly prismaService: PrismaService,
  ) {}

  async onModuleInit() {
    this.jobs =
      await this.discoveryService.providersWithMetaAtKey<JobMetadata>(
        JOB_METADATA_KEY,
      );
  }

  getJobMetadata() {
    return this.jobs.map((job) => job.meta);
  }

  async getJobs() {
    return this.prismaService.job.findMany();
  }

  async getJob(id: number) {
    return this.prismaService.job.findUnique({ where: { id } });
  }

  async executeJob(name: string, data: any) {
    const job = this.jobs.find((job) => job.meta.name === name);
    if (!job) {
      throw new BadRequestException(`Job ${name} not found.`);
    }

    if (!(job.discoveredClass.instance instanceof AbstractJob)) {
      throw new InternalServerErrorException(
        `Job is not an instance of AbstractJob`,
      );
    }

    return job.discoveredClass.instance.execute(
      data.fileName ? this.getFile(data.fileName) : data,
      job.meta.name,
    );
  }

  /**
   * Counts item `index` of job `jobId` as done, at most once: a redelivered message acknowledges
   * the same index again, and the `JobItem` primary key turns that into a no-op. One statement,
   * so the count and the COMPLETED transition can't race; in the `SET` clause `completed` is the
   * value before this acknowledgement.
   */
  async acknowledge(jobId: number, index: number) {
    const [job] = await this.prismaService.$queryRaw<
      { id: number; size: number; completed: number; status: string }[]
    >`
      WITH acked AS (
        INSERT INTO "JobItem" ("jobId", "index")
        SELECT id, ${index}::int FROM "Job"
        WHERE id = ${jobId}::int AND ${index}::int >= 0 AND ${index}::int < size
        ON CONFLICT DO NOTHING
        RETURNING 1
      )
      UPDATE "Job" SET
        completed = completed + (SELECT count(*) FROM acked),
        status = CASE
          WHEN status = ${JobStatus.IN_PROGRESS}
            AND completed + (SELECT count(*) FROM acked) = size
          THEN ${JobStatus.COMPLETED} ELSE status END,
        ended = CASE
          WHEN status = ${JobStatus.IN_PROGRESS}
            AND completed + (SELECT count(*) FROM acked) = size
          THEN now() ELSE ended END
      WHERE id = ${jobId}::int
      RETURNING id, size, completed, status`;

    if (!job) {
      throw new BadRequestException(`Job ${jobId} not found.`);
    }
    if (index < 0 || index >= job.size) {
      throw new BadRequestException(`Job ${jobId} has no item ${index}.`);
    }
    return job;
  }

  private getFile(fileName?: string) {
    if (!fileName) {
      return;
    }
    try {
      return JSON.parse(
        readFileSync(`${UPLOAD_FILE_PATH}/${fileName}`, 'utf8'),
      );
    } catch (error) {
      throw new InternalServerErrorException(`File ${fileName} not found.`);
    }
  }
}

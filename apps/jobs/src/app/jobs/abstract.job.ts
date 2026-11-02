import { plainToInstance } from 'class-transformer';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { ValidationError, validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobStatus } from '../models/job-status.enum';

/** Keeps a job (its rows and messages) small enough to create in one transaction. */
export const MAX_JOB_ITEMS = 10_000;

export abstract class AbstractJob<T extends object> {
  protected abstract messageClass: new () => T;

  protected constructor(
    private readonly prismaService: PrismaService,
    private readonly outbox: PrismaOutboxStore,
    private readonly outboxRelay: OutboxRelay,
  ) {}

  async execute(data: T | T[], name: string) {
    const items = Array.isArray(data) ? data : [data];
    // Validate everything before the job row exists: a rejected payload must not leave behind
    // an IN_PROGRESS job that no consumer will ever complete.
    await this.validateData(items, Array.isArray(data));

    // The job and its messages commit together, so a crash can't leave a job whose messages
    // were never sent. The outbox relay publishes them to the topic named after the job.
    const job = await this.prismaService.$transaction(
      async (tx) => {
        const job = await tx.job.create({
          data: {
            name,
            size: items.length,
            completed: 0,
            status: JobStatus.IN_PROGRESS,
          },
        });
        await this.outbox.enqueue(
          tx,
          items.map((item, index) => ({
            transport: 'pulsar' as const,
            destination: name,
            key: String(job.id),
            payload: { ...item, jobId: job.id, index },
          })),
        );
        return job;
      },
      { timeout: 30_000 },
    );
    this.outboxRelay.poke();
    return job;
  }

  private async validateData(items: T[], isArray: boolean) {
    if (!items.length) {
      throw new BadRequestException('Job data must not be empty.');
    }
    if (items.length > MAX_JOB_ITEMS) {
      throw new BadRequestException(
        `A job can have at most ${MAX_JOB_ITEMS} items; got ${items.length}.`,
      );
    }
    const messages = (
      await Promise.all(
        items.map(async (item, index) => {
          const errors = await validate(
            plainToInstance(this.messageClass, item),
          );
          return constraintMessages(errors).map((message) =>
            isArray ? `data[${index}]: ${message}` : message,
          );
        }),
      )
    ).flat();

    if (messages.length) {
      // An array message matches `ValidationPipe`'s error shape, which clients already unwrap.
      throw new BadRequestException(messages);
    }
  }
}

function constraintMessages(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...constraintMessages(error.children ?? []),
  ]);
}

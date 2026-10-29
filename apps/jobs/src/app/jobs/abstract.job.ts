import { Producer } from 'pulsar-client';
import { plainToInstance } from 'class-transformer';
import { PulsarClient, serialize } from '@jobber/pulsar';
import { ValidationError, validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobStatus } from '../models/job-status.enum';

export abstract class AbstractJob<T extends object> {
  protected abstract messageClass: new () => T;
  private producer: Producer;

  protected constructor(
    private readonly pulsarClient: PulsarClient,
    private readonly prismaService: PrismaService,
  ) {}

  async execute(data: T | T[], name: string) {
    const items = Array.isArray(data) ? data : [data];
    // Validate everything before the job row exists: a rejected payload must not leave behind
    // an IN_PROGRESS job that no consumer will ever complete.
    await this.validateData(items, Array.isArray(data));

    if (!this.producer) {
      this.producer = await this.pulsarClient.createProducer(name);
    }
    const job = await this.prismaService.job.create({
      data: {
        name,
        size: items.length,
        completed: 0,
        status: JobStatus.IN_PROGRESS,
      },
    });
    await Promise.all(
      items.map((item) => this.send({ ...item, jobId: job.id })),
    );
    return job;
  }

  private async send(data: T) {
    await this.producer.send({ data: serialize(data) });
  }

  private async validateData(items: T[], isArray: boolean) {
    if (!items.length) {
      throw new BadRequestException('Job data must not be empty.');
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

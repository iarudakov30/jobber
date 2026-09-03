import { Producer } from 'pulsar-client';
import { plainToInstance } from 'class-transformer';
import { PulsarClient, serialize } from '@jobber/pulsar';
import { validate } from 'class-validator';
import { BadRequestException } from '@nestjs/common';

export abstract class AbstractJob<T extends object> {
  protected abstract messageClass: new () => T;
  private producer: Producer;

  protected constructor(private readonly pulsarClient: PulsarClient) {}

  async execute(data: T, job: string) {
    if (!this.producer) {
      this.producer = await this.pulsarClient.createProducer(job);
    }
    if (Array.isArray(data)) {
      for (const message of data) {
        this.send(message);
      }
      return;
    }
    this.send(data);
  }

  private send(data: T) {
    this.validateData(data).then(() => {
      this.producer.send({ data: serialize(data) });
    });
  }

  private async validateData(data: T) {
    const items = Array.isArray(data) ? data : [data];
    const errors = (
      await Promise.all(
        items.map((item) => validate(plainToInstance(this.messageClass, item))),
      )
    ).flat();

    if (errors.length) {
      throw new BadRequestException(
        `Job data is invalid: ${JSON.stringify(errors)}`,
      );
    }
  }
}

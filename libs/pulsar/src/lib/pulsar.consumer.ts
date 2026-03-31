import { deserialize } from './pulsar.consumer';
import { PulsarClient } from './pulsar.client';
import { Consumer, Message } from 'pulsar-client';
import { Logger, OnModuleInit } from '@nestjs/common';

export abstract class PulsarConsumer<T> implements OnModuleInit{

  protected readonly logger = new Logger(this.topic);
  private consumer!: Consumer;

  protected constructor(
    private readonly pulsarClient: PulsarClient,
    private readonly topic: string
  ) {}

  async onModuleInit() {
    this.consumer = await this.pulsarClient.createConsumer(
      this.topic,
      this.listener.bind(this),
    );
  }

  protected abstract onMessage(data: T): Promise<void>;

  private async listener(message: Message) {
    try {
      const data: T = deserialize<T>(message.getData());

      this.logger.debug(`PulsarConsumer: ${JSON.stringify(data)}`);

      await this.onMessage(data);
    } catch (e) {
      this.logger.error(e);
    } finally {
      await this.consumer.acknowledge(message);
    }
  }
}

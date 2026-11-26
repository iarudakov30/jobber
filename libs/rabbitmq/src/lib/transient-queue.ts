import { Logger } from '@nestjs/common';
import type { Channel, ChannelModel, ConsumeMessage } from 'amqplib';

import { RabbitConnection, errorText } from './rabbit.connection';

export interface TransientQueueOptions {
  /** The exchange every binding is on. */
  exchange: string;
  /** Routing keys bound from the start (more come and go with `bind` / `unbind`). */
  bindings?: string[];
  /**
   * Messages the queue keeps while its consumer falls behind; past that the oldest are dropped
   * (`x-overflow: drop-head`). Default 10,000.
   */
  maxLength?: number;
  /** Every delivery. Consumed without acks: a transient queue's messages are disposable. */
  onMessage(message: ConsumeMessage): void;
  /**
   * After the queue is (re)declared and bound. `reconnected` is true from the second time on:
   * messages published in between were lost, so whoever relies on them should resync.
   */
  onReady?(info: { reconnected: boolean }): void;
}

/**
 * A server-named, exclusive, auto-delete queue: one per process, gone with its connection. Its
 * bindings change at runtime (`bind`, `unbind`); the set is remembered, so after a reconnect a
 * new queue gets all of them again. For fan-out to whoever is connected right now, such as the
 * realtime gateway's per-instance queue.
 *
 * `bind` and `unbind` go out on one channel in the order they are called, so a quick unbind and
 * bind of the same key end bound.
 */
export class TransientQueue {
  private readonly logger = new Logger(TransientQueue.name);
  private readonly keys: Set<string>;
  private model?: ChannelModel;
  private channel?: Channel;
  private queue?: string;
  private setups = 0;

  constructor(
    connection: RabbitConnection,
    private readonly options: TransientQueueOptions,
  ) {
    this.keys = new Set(options.bindings ?? []);
    connection.onConnect((model) => this.setUp(model));
  }

  /** The server-assigned queue name; undefined while disconnected. */
  get name(): string | undefined {
    return this.queue;
  }

  get isReady(): boolean {
    return this.channel !== undefined;
  }

  /** The routing keys bound now, and again after every reconnect. */
  get bindings(): string[] {
    return [...this.keys];
  }

  /** Resolves once bound, or at once while disconnected (the next connect binds it). */
  async bind(key: string): Promise<void> {
    this.keys.add(key);
    const { channel, queue } = this;
    if (channel && queue) {
      await channel
        .bindQueue(queue, this.options.exchange, key)
        .catch((e) =>
          this.logger.warn(`Binding ${key} failed: ${errorText(e)}`),
        );
    }
  }

  async unbind(key: string): Promise<void> {
    this.keys.delete(key);
    const { channel, queue } = this;
    if (channel && queue) {
      await channel
        .unbindQueue(queue, this.options.exchange, key)
        .catch((e) =>
          this.logger.warn(`Unbinding ${key} failed: ${errorText(e)}`),
        );
    }
  }

  private async setUp(model: ChannelModel): Promise<void> {
    if (this.model !== model) {
      this.model = model;
      model.once('close', () => {
        if (this.model === model) {
          this.model = undefined;
          this.channel = undefined;
          this.queue = undefined;
        }
      });
    }
    const channel = await model.createChannel();
    channel.on('error', (e) =>
      this.logger.warn(`Transient queue channel failed: ${errorText(e)}`),
    );
    channel.once('close', () => {
      if (this.channel !== channel) {
        return;
      }
      this.channel = undefined;
      this.queue = undefined;
      // Only this channel closed (a channel-level error): a new one, a new queue.
      setTimeout(() => {
        if (this.model === model) {
          this.setUp(model).catch((e) =>
            this.logger.error(
              `Re-creating the transient queue failed: ${errorText(e)}`,
            ),
          );
        }
      }, 1_000);
    });
    const { queue } = await channel.assertQueue('', {
      exclusive: true,
      autoDelete: true,
      durable: false,
      arguments: {
        'x-max-length': this.options.maxLength ?? 10_000,
        'x-overflow': 'drop-head',
      },
    });
    // From here on bind() and unbind() go to the channel; keys added before are in the set.
    this.channel = channel;
    this.queue = queue;
    for (const key of [...this.keys]) {
      await channel.bindQueue(queue, this.options.exchange, key);
    }
    await channel.consume(
      queue,
      (message) => {
        if (message) {
          this.options.onMessage(message);
        }
      },
      { noAck: true },
    );
    this.options.onReady?.({ reconnected: this.setups++ > 0 });
  }
}

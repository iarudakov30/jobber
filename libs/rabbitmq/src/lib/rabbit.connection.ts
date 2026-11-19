import { Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import {
  ChannelModel,
  ConfirmChannel,
  ConsumeMessage,
  Options,
  connect,
} from 'amqplib';

import {
  DEFAULT_RETRY,
  RabbitTopology,
  RetrySpec,
  declareTopology,
} from './topology';

export interface RabbitOptions {
  /** e.g. `amqp://guest:guest@localhost:5672` */
  url: string;
  topology?: RabbitTopology;
  /** Shown in the management UI's connection list. */
  connectionName?: string;
  /** Backoff between connection attempts. Default 1 s, doubling up to 30 s. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

/** Thrown by a publish while there is no connection: the caller (usually the outbox) retries later. */
export class RabbitUnavailableError extends Error {
  constructor() {
    super('RabbitMQ is not connected');
    this.name = 'RabbitUnavailableError';
  }
}

type DeliveryHandler = (
  message: ConsumeMessage,
  channel: ConfirmChannel,
) => Promise<void>;

interface Subscription {
  queue: string;
  prefetch: number;
  handler: DeliveryHandler;
}

/**
 * One AMQP connection that keeps itself up. A background loop connects, declares the topology,
 * opens a channel per consumer, and after any disconnect does it all again (1 s → 30 s backoff).
 * Publishing goes through a confirm channel and resolves only once the broker has the message.
 *
 * The application starts even while RabbitMQ is down: publishes fail fast with
 * `RabbitUnavailableError` until the connection is back.
 */
export class RabbitConnection implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RabbitConnection.name);
  private readonly subscriptions: Subscription[] = [];
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private model?: ChannelModel;
  private publishChannel?: Promise<ConfirmChannel>;
  private readonly channelErrors = new WeakMap<ConfirmChannel, Error>();
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;
  private waiters: (() => void)[] = [];

  constructor(private readonly options: RabbitOptions) {
    this.minDelayMs = options.minReconnectDelayMs ?? 1_000;
    this.maxDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  onModuleInit(): void {
    this.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  get isConnected(): boolean {
    return this.model !== undefined;
  }

  /** Resolves once connected (at once if already connected). */
  whenConnected(): Promise<void> {
    if (this.model) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    const model = this.model;
    this.model = undefined;
    this.publishChannel = undefined;
    await model?.close().catch(() => undefined);
    await this.loop;
  }

  /** The retry settings the topology gives `queue`. */
  retryFor(queue: string): RetrySpec {
    return (
      this.options.topology?.queues?.find((q) => q.name === queue)?.retry ??
      DEFAULT_RETRY
    );
  }

  /** Consumes `queue` now if connected, and again after every reconnect. */
  consume(queue: string, prefetch: number, handler: DeliveryHandler): void {
    const subscription = { queue, prefetch, handler };
    this.subscriptions.push(subscription);
    const model = this.model;
    if (model) {
      this.subscribe(model, subscription).catch((e) =>
        this.logger.error(`Consuming ${queue} failed: ${errorText(e)}`),
      );
    }
  }

  /**
   * Publishes on the shared confirm channel and resolves once the broker confirms. Rejects at
   * once when disconnected, and when the broker refuses the message (an unknown exchange closes
   * the channel; the next publish opens a new one).
   */
  async publish(
    exchange: string,
    routingKey: string,
    content: Buffer,
    options: Options.Publish,
  ): Promise<void> {
    const channel = await this.confirmChannel();
    try {
      await confirmedPublish(channel, (callback) =>
        channel.publish(exchange, routingKey, content, options, callback),
      );
    } catch (e) {
      // amqplib reports only "channel closed"; the broker's reason came as the channel's error.
      const reason = this.channelErrors.get(channel);
      // `cause` set by hand: the `new Error(msg, { cause })` overload needs lib es2022, and every
      // project that imports this library would have to raise its lib for it.
      throw reason
        ? Object.assign(
            new Error(`Publish to ${exchange} refused: ${reason.message}`),
            { cause: e },
          )
        : e;
    }
  }

  private confirmChannel(): Promise<ConfirmChannel> {
    const model = this.model;
    if (!model) {
      return Promise.reject(new RabbitUnavailableError());
    }
    if (!this.publishChannel) {
      const channel = model.createConfirmChannel().then((ch) => {
        ch.on('error', (e) => {
          this.channelErrors.set(ch, e);
          this.logger.warn(`Publish channel error: ${errorText(e)}`);
        });
        ch.once('close', () => {
          if (this.publishChannel === channel) {
            this.publishChannel = undefined;
          }
        });
        return ch;
      });
      channel.catch(() => {
        if (this.publishChannel === channel) {
          this.publishChannel = undefined;
        }
      });
      this.publishChannel = channel;
    }
    return this.publishChannel;
  }

  private async run(): Promise<void> {
    let delayMs = this.minDelayMs;
    let down = false;
    while (this.running) {
      let closed: Promise<void> | undefined;
      try {
        ({ closed } = await this.connectOnce());
        delayMs = this.minDelayMs;
        if (down) {
          this.logger.log('RabbitMQ is back');
        }
        down = false;
      } catch (e) {
        if (!down) {
          this.logger.warn(
            `RabbitMQ unavailable (${errorText(e)}); retrying in the background`,
          );
        }
        down = true;
      }
      if (closed) {
        await closed;
        this.model = undefined;
        this.publishChannel = undefined;
        if (this.running) {
          this.logger.warn('RabbitMQ connection lost; reconnecting');
          down = true;
        }
      }
      if (!this.running) {
        break;
      }
      await this.sleep(delayMs);
      delayMs = Math.min(delayMs * 2, this.maxDelayMs);
    }
  }

  /** Connects and sets everything up; `closed` settles when the connection closes. */
  private async connectOnce(): Promise<{ closed: Promise<void> }> {
    const model = await connect(this.options.url, {
      clientProperties: {
        connection_name: this.options.connectionName ?? 'jobber',
      },
    });
    const closed = new Promise<void>((resolve) =>
      model.once('close', () => resolve()),
    );
    model.on('error', (e) =>
      this.logger.warn(`RabbitMQ connection error: ${errorText(e)}`),
    );
    try {
      const setup = await model.createChannel();
      await declareTopology(setup, this.options.topology ?? {});
      await setup.close();
      for (const subscription of this.subscriptions) {
        await this.subscribe(model, subscription);
      }
    } catch (e) {
      await model.close().catch(() => undefined);
      throw e;
    }
    if (!this.running) {
      await model.close().catch(() => undefined);
      return { closed };
    }
    this.model = model;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((resolve) => resolve());
    return { closed };
  }

  /**
   * Opens a channel for one consumer. If the broker closes just that channel (a channel-level
   * error, or the queue was deleted), it is reopened after a second while the connection lasts.
   */
  private async subscribe(
    model: ChannelModel,
    subscription: Subscription,
  ): Promise<void> {
    const { queue, prefetch, handler } = subscription;
    const channel = await model.createConfirmChannel();
    channel.on('error', (e) =>
      this.logger.warn(`Channel for ${queue} failed: ${errorText(e)}`),
    );
    channel.once('close', () => {
      setTimeout(() => {
        if (this.running && this.model === model) {
          this.subscribe(model, subscription).catch((e) =>
            this.logger.error(`Re-consuming ${queue} failed: ${errorText(e)}`),
          );
        }
      }, 1_000);
    });
    await channel.prefetch(prefetch);
    await channel.consume(
      queue,
      (message) => {
        if (message === null) {
          // The broker cancelled the consumer (queue deleted); reopen to resubscribe.
          this.logger.warn(`Consumer of ${queue} was cancelled by the broker`);
          channel.close().catch(() => undefined);
          return;
        }
        void handler(message, channel);
      },
      { noAck: false },
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      this.wake = done;
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/** Runs a confirm-channel publish and resolves when the broker acks it. */
export function confirmedPublish(
  channel: ConfirmChannel,
  publish: (callback: (err: unknown) => void) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      // amqplib calls the callback with an error if the broker nacks or the channel closes first.
      publish((err) => (err ? reject(err) : resolve()));
    } catch (e) {
      // Publishing on a closed channel throws synchronously.
      reject(e);
    }
  });
}

/**
 * A readable reason for logs and `x-dead-letter-reason`. Some errors have an empty message: a
 * refused connection tried on ::1 and 127.0.0.1 is an `AggregateError` whose text is only in
 * its `errors` (nodemailer, Node's net). Then the inner messages and the code are used.
 */
export function errorText(e: unknown): string {
  if (!(e instanceof Error)) {
    return String(e);
  }
  if (e.message) {
    return e.message;
  }
  const inner = (e as { errors?: unknown[] }).errors;
  const code = (e as { code?: unknown }).code;
  const parts = [
    ...(Array.isArray(inner) ? inner.map(errorText) : []),
    ...(code ? [String(code)] : []),
  ];
  return parts.length ? parts.join('; ') : e.name;
}

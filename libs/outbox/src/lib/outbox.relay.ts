import {
  BeforeApplicationShutdown,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

import {
  OutboxPublisher,
  OutboxRecord,
  OutboxStore,
  OutboxTransport,
} from './outbox.types';

export interface OutboxRelayOptions {
  /** Records claimed per transaction. Default 100. */
  batchSize?: number;
  /** Wait after an empty or failed batch, doubling up to `maxIdleMs`. Default 200 ms. */
  minIdleMs?: number;
  /** Default 2000 ms. */
  maxIdleMs?: number;
}

/**
 * Publishes outbox records in the background: runs a batch, and after an empty or failed one
 * sleeps with backoff. `poke()` wakes it right away after a write.
 *
 * Delivery is at-least-once: a crash between publishing and marking a record publishes it again,
 * so consumers must be idempotent.
 */
export class OutboxRelay
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly publishers: Map<OutboxTransport, OutboxPublisher>;
  private readonly batchSize: number;
  private readonly minIdleMs: number;
  private readonly maxIdleMs: number;
  private idleMs: number;
  private running = false;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(
    private readonly store: OutboxStore,
    publishers: OutboxPublisher[],
    options: OutboxRelayOptions = {},
  ) {
    this.publishers = new Map(publishers.map((p) => [p.transport, p]));
    this.batchSize = options.batchSize ?? 100;
    this.minIdleMs = options.minIdleMs ?? 200;
    this.maxIdleMs = options.maxIdleMs ?? 2000;
    this.idleMs = this.minIdleMs;
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
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
    await this.loop;
  }

  /** Publish soon: call after committing new records. */
  poke(): void {
    this.idleMs = this.minIdleMs;
    this.wake?.();
  }

  /** Runs one batch; returns how many records went out. */
  async tick(): Promise<number> {
    try {
      const { published, error } = await this.store.processBatch(
        this.batchSize,
        (record) => this.publish(record),
      );
      if (error) {
        this.logger.error(
          `Publish failed after ${published} record(s); retrying: ${errorText(error)}`,
        );
      }
      return error ? -1 : published;
    } catch (e) {
      this.logger.error(`Outbox batch failed: ${errorText(e)}`);
      return -1;
    }
  }

  private async run(): Promise<void> {
    while (this.running) {
      const published = await this.tick();
      if (published > 0) {
        // More may be waiting: go again at once.
        this.idleMs = this.minIdleMs;
        continue;
      }
      await this.sleep(this.idleMs);
      this.idleMs = Math.min(this.idleMs * 2, this.maxIdleMs);
    }
  }

  private publish(record: OutboxRecord): Promise<void> {
    const publisher = this.publishers.get(record.transport);
    if (!publisher) {
      return Promise.reject(
        new Error(`No outbox publisher for transport "${record.transport}"`),
      );
    }
    return publisher.publish(record);
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

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

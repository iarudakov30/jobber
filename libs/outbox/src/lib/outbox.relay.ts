import {
  BeforeApplicationShutdown,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';

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
 * Each transport is published separately, in id order within it: a RabbitMQ outage holds back
 * only RabbitMQ records (retried with their own backoff), never the Pulsar ones written after
 * them.
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
  /** Per transport, after a failure: wait before trying it again. */
  private readonly retry = new Map<
    OutboxTransport,
    { backoffMs: number; at: number }
  >();
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

  /**
   * Runs one batch per transport (skipping a transport that is backing off after a failure).
   * Returns how many records went out, or -1 when nothing did and something failed.
   */
  async tick(): Promise<number> {
    let published = 0;
    let failed = false;
    for (const transport of this.publishers.keys()) {
      const retry = this.retry.get(transport);
      if (retry && Date.now() < retry.at) {
        continue;
      }
      const result = await this.batch(transport);
      if (result < 0) {
        failed = true;
        const backoffMs = Math.min(
          Math.max((retry?.backoffMs ?? 0) * 2, this.minIdleMs),
          this.maxIdleMs,
        );
        this.retry.set(transport, { backoffMs, at: Date.now() + backoffMs });
      } else {
        this.retry.delete(transport);
        published += result;
      }
    }
    return published === 0 && failed ? -1 : published;
  }

  private async batch(transport: OutboxTransport): Promise<number> {
    try {
      const { published, error } = await this.store.processBatch(
        this.batchSize,
        (record) => this.publish(record),
        transport,
      );
      if (error) {
        this.logger.error(
          `${transport}: publish failed after ${published} record(s); retrying: ${errorText(error)}`,
        );
      }
      return error ? -1 : published;
    } catch (e) {
      this.logger.error(`${transport}: outbox batch failed: ${errorText(e)}`);
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

  /**
   * Publishes inside a PRODUCER span that continues the trace saved at enqueue time, and passes
   * that span on in the headers so the consumer's span becomes its child.
   */
  private async publish(record: OutboxRecord): Promise<void> {
    const publisher = this.publishers.get(record.transport);
    if (!publisher) {
      throw new Error(
        `No outbox publisher for transport "${record.transport}"`,
      );
    }
    const parent = propagation.extract(ROOT_CONTEXT, record.headers);
    const span = tracer.startSpan(
      `${record.destination} publish`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': record.transport,
          'messaging.destination.name': record.destination,
          'outbox.id': record.id.toString(),
        },
      },
      parent,
    );
    const spanContext = trace.setSpan(parent, span);
    const headers = { ...record.headers };
    propagation.inject(spanContext, headers);
    try {
      await context.with(spanContext, () =>
        publisher.publish({ ...record, headers }),
      );
    } catch (e) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorText(e) });
      throw e;
    } finally {
      span.end();
    }
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

const tracer = trace.getTracer('@jobber/outbox');

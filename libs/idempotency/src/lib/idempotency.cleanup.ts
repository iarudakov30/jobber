import {
  BeforeApplicationShutdown,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';

import { IdempotencyStore } from './idempotency.types';

/** Deletes expired keys every `intervalMs` (default hourly) while the app runs. */
export class IdempotencyCleanup
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(IdempotencyCleanup.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly store: IdempotencyStore,
    private readonly intervalMs = 60 * 60 * 1000,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
  }

  beforeApplicationShutdown(): void {
    clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    try {
      const deleted = await this.store.deleteExpired();
      if (deleted) {
        this.logger.log(`Deleted ${deleted} expired idempotency key(s)`);
      }
      return deleted;
    } catch (error) {
      this.logger.error(`Idempotency cleanup failed: ${error}`);
      return 0;
    }
  }
}

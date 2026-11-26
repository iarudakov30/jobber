import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { hostname } from 'os';
import { RealtimePriceMessage, errorText } from '@jobber/rabbitmq';
import { REDIS } from '../redis/redis.module';
import { LeaderLock } from './leader-lock';
import { PriceTicker } from './price-ticker';

export const SIMULATOR_OPTIONS = Symbol('SIMULATOR_OPTIONS');
export const LEADER_KEY = 'market:simulator';

export interface SimulatorOptions {
  /** False keeps this replica out of the election: it serves quotes but never ticks. */
  enabled: boolean;
  /** How long the leader lock lives without a renewal. */
  lockTtlMs: number;
  /** How often the leader renews it. */
  renewMs: number;
  tickMs: number;
}

export const DEFAULT_SIMULATOR_OPTIONS: SimulatorOptions = {
  enabled: true,
  lockTtlMs: 5_000,
  renewMs: 2_000,
  tickMs: 1_000,
};

/** Called with every tick the leader stored and sent (one message per coin). */
export type TickListener = (ticks: RealtimePriceMessage[]) => void;

/** Followers retry this long after the leader's key expires, so they don't hit it early. */
const TAKEOVER_MARGIN_MS = 20;
/** And at least this often, to notice a lock released by a leader shutting down. */
const FOLLOWER_POLL_MS = 500;

/**
 * Runs the price simulator on exactly one replica. Every replica campaigns for the Redis lock
 * `market:simulator`; the one holding it ticks every second, renews the lock every 2 s, and
 * stops ticking as soon as its lease can no longer be trusted. A follower that finds the lock
 * taken asks Redis when it expires and tries again just after (or in 500 ms, whichever comes
 * first). A dead leader is replaced as soon as its key is gone, at most the 5 s TTL after its
 * last renewal; one that shuts down releases the key and is replaced within half a second.
 */
@Injectable()
export class SimulatorService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(SimulatorService.name);
  readonly instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly lock: LeaderLock;
  private campaignTimer?: NodeJS.Timeout;
  private tickTimer?: NodeJS.Timeout;
  private leading = false;
  private ticking = false;
  private stopped = false;
  private redisDown = false;
  private readonly tickListeners: TickListener[] = [];

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    private readonly ticker: PriceTicker,
    @Inject(SIMULATOR_OPTIONS) private readonly options: SimulatorOptions,
  ) {
    this.lock = new LeaderLock(
      this.redis,
      LEADER_KEY,
      this.instanceId,
      options.lockTtlMs,
    );
  }

  /**
   * Whether this replica may tick right now. A leader cut off from Redis keeps `leading` until
   * its next tick notices, but its lease has run out before that, and so has this.
   */
  get isLeader(): boolean {
    return this.leading && this.lock.held;
  }

  /** Runs `listener` after each tick of this replica while it leads (the order matcher). */
  onTick(listener: TickListener): void {
    this.tickListeners.push(listener);
  }

  onApplicationBootstrap(): void {
    if (!this.options.enabled) {
      this.logger.log('Price simulator disabled on this replica');
      return;
    }
    this.logger.log(
      `Campaigning for the price simulator as ${this.instanceId} (seed ${this.ticker.seed})`,
    );
    // The client connects in the background: the first attempt waits for it rather than
    // failing and reporting Redis down. While Redis stays down, RedisModule reports it.
    if (this.redis.status === 'ready') {
      void this.campaign();
    } else {
      this.redis.once('ready', () => void this.campaign());
    }
  }

  /** Before Redis and PostgreSQL close: save the open candles and hand the lock over at once. */
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.campaignTimer);
    if (this.leading) {
      await this.stepDown('shutting down');
      await this.lock
        .release()
        .catch((e) =>
          this.logger.warn(`Releasing the leader lock failed: ${errorText(e)}`),
        );
    }
  }

  private async campaign(): Promise<void> {
    if (this.stopped) {
      return;
    }
    let delay = this.options.renewMs;
    try {
      if (this.leading) {
        if (!(await this.lock.renew())) {
          await this.stepDown('another replica holds the lock');
        }
      } else if (await this.lock.acquire()) {
        await this.lead();
      } else {
        const expiresIn = await this.lock.expiresInMs();
        delay = Math.min(
          FOLLOWER_POLL_MS,
          Math.max(expiresIn, 0) + TAKEOVER_MARGIN_MS,
        );
      }
      if (this.redisDown) {
        this.redisDown = false;
        this.logger.log('Leader election reaches Redis again');
      }
    } catch (error) {
      // Can't reach Redis. A leader keeps ticking until its lease runs out (checked on every
      // tick), then stops: by then its key may have expired and someone else may lead.
      if (!this.redisDown) {
        this.redisDown = true;
        this.logger.warn(`Leader election failed: ${errorText(error)}`);
      }
    }
    if (!this.stopped) {
      this.campaignTimer = setTimeout(() => void this.campaign(), delay);
    }
  }

  private async lead(): Promise<void> {
    await this.ticker.resume();
    if (this.stopped || !this.lock.held) {
      return;
    }
    this.leading = true;
    this.logger.log(`Leading the price simulator (${this.instanceId})`);
    this.tickTimer = setInterval(() => void this.tick(), this.options.tickMs);
    await this.tick();
  }

  private async stepDown(reason: string): Promise<void> {
    if (!this.leading) {
      return;
    }
    this.leading = false;
    clearInterval(this.tickTimer);
    this.logger.warn(`Stopped leading the price simulator: ${reason}`);
    await this.ticker.flush();
  }

  private async tick(): Promise<void> {
    if (!this.leading || this.ticking) {
      return; // the previous tick is still waiting for Redis
    }
    if (!this.lock.held) {
      await this.stepDown('the lease ran out before it could be renewed');
      return;
    }
    this.ticking = true;
    let ticks: RealtimePriceMessage[];
    try {
      ticks = await this.ticker.tick(Date.now());
    } catch {
      // Redis didn't store the tick, so nothing was sent; the election loop reports Redis.
      return;
    } finally {
      this.ticking = false;
    }
    for (const listener of this.tickListeners) {
      listener(ticks);
    }
  }
}

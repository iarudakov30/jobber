import { LiveCoin } from '../coins';
import { ProviderName } from '../providers/price-provider';

export interface RatePickerOptions {
  /** Order of preference: the first healthy one prices a coin. */
  providers: readonly ProviderName[];
  /**
   * A provider's price for a coin is stale once neither a price nor a heartbeat for that coin
   * has arrived for this long. Default 10 s, the age at which quotes refuse a price anyway.
   */
  staleAfterMs: number;
  /** A provider that failed must be healthy this long in a row to get a coin back. Default 30 s. */
  failbackAfterMs: number;
  /** A price further than this from the coin's last published price is held back. Default 10%. */
  badPrintJump: number;
  /** A held price is confirmed by another within this long … Default 5 s. */
  confirmWithinMs: number;
  /** … and within this distance of it. Default 2%. */
  confirmTolerance: number;
  /** Both healthy and further apart than this: logged. Default 1%. */
  divergence: number;
}

export const DEFAULT_RATE_PICKER_OPTIONS: Omit<RatePickerOptions, 'providers'> =
  {
    staleAfterMs: 10_000,
    failbackAfterMs: 30_000,
    badPrintJump: 0.1,
    confirmWithinMs: 5_000,
    confirmTolerance: 0.02,
    divergence: 0.01,
  };

/** A live coin's price for this tick: USD cents, unrounded, and who it came from. */
export interface LivePick {
  coin: LiveCoin;
  price: number;
  source: ProviderName;
}

/** What the picker decided, for the log (and the tests). */
export type PickerEvent =
  | {
      type: 'switch';
      coin: LiveCoin;
      from: ProviderName | null;
      to: ProviderName;
      reason: string;
    }
  | { type: 'unavailable'; coin: LiveCoin; from: ProviderName }
  | {
      type: 'held';
      coin: LiveCoin;
      provider: ProviderName;
      price: number;
      reference: number;
    }
  | {
      type: 'confirmed';
      coin: LiveCoin;
      provider: ProviderName;
      price: number;
      by: ProviderName;
    }
  | { type: 'diverging'; coin: LiveCoin; prices: Record<string, number> }
  | { type: 'converged'; coin: LiveCoin };

/** What one provider has said about one coin. */
interface Feed {
  /** The last accepted price, and when it arrived (local time). */
  price?: number;
  priceAt?: number;
  /** The last heartbeat for this coin (Coinbase sends one a second per product). */
  heartbeatAt?: number;
  /** A price held back by the bad print guard, waiting for confirmation. */
  suspect?: { price: number; at: number };
  /** Healthy at every pick since then; undefined while not healthy. */
  healthySince?: number;
  /** It was healthy once and then wasn't: it must earn the coin back (failback). */
  failed: boolean;
}

interface CoinState {
  source: ProviderName | null;
  /** The last price picked for the coin: the bad print guard's reference. */
  published?: number;
  diverging: boolean;
}

/**
 * Chooses, once a second, each live coin's price from the providers' latest prices. Pure: it
 * is given the time and which connections are alive, so its tests need no clock or sockets.
 *
 * - **Healthy** = the provider's connection is alive and its price for the coin is fresh (a
 *   price or a heartbeat within `staleAfterMs`).
 * - **Failover, per coin:** when the coin's provider isn't healthy, the first healthy one in
 *   preference order takes over at once. Nobody healthy: no price, and no tick.
 * - **Failback:** a more preferred provider takes the coin back once it has been healthy for
 *   `failbackAfterMs` in a row, so a flapping connection can't move it every second. A provider
 *   that has never been healthy for the coin yet (still connecting at startup) takes it at once.
 * - **Bad print guard:** a price more than `badPrintJump` away from the coin's last published
 *   price is held back until the same provider repeats it (within `confirmTolerance`, within
 *   `confirmWithinMs`) or another provider says the same. Until then the provider's previous
 *   price stands, and ages.
 */
export class RatePicker {
  private readonly options: RatePickerOptions;
  private readonly feeds = new Map<string, Feed>();
  private readonly coins = new Map<LiveCoin, CoinState>();

  constructor(
    readonly liveCoins: readonly LiveCoin[],
    options: Partial<RatePickerOptions> & Pick<RatePickerOptions, 'providers'>,
    private readonly onEvent: (event: PickerEvent) => void = () => undefined,
  ) {
    this.options = { ...DEFAULT_RATE_PICKER_OPTIONS, ...options };
    for (const coin of liveCoins) {
      this.coins.set(coin, { source: null, diverging: false });
    }
  }

  /** Continue from the price a previous leader published, so the guard has a reference. */
  setReference(coin: LiveCoin, price: number): void {
    const state = this.coins.get(coin);
    if (state) state.published = price;
  }

  /** The coin's current provider, or null while it has no price. */
  sourceOf(coin: LiveCoin): ProviderName | null {
    return this.coins.get(coin)?.source ?? null;
  }

  observe(
    provider: ProviderName,
    coin: LiveCoin,
    price: number,
    now: number,
  ): void {
    const state = this.coins.get(coin);
    if (!state) return;
    const feed = this.feed(provider, coin);
    const reference = state.published;
    if (
      reference === undefined ||
      this.near(price, reference, this.options.badPrintJump)
    ) {
      accept(feed, price, now);
      return;
    }
    // A jump. The same provider repeating it confirms it…
    if (this.confirms(feed, price, now)) {
      this.onEvent({ type: 'confirmed', coin, provider, price, by: provider });
      accept(feed, price, now);
      return;
    }
    // … and so does another provider saying the same (held, or already accepted).
    for (const other of this.options.providers) {
      if (other === provider) continue;
      const theirs = this.feed(other, coin);
      if (this.confirms(theirs, price, now)) {
        const suspect = theirs.suspect as { price: number; at: number };
        accept(theirs, suspect.price, suspect.at);
        accept(feed, price, now);
        this.onEvent({ type: 'confirmed', coin, provider, price, by: other });
        return;
      }
      if (
        theirs.price !== undefined &&
        theirs.priceAt !== undefined &&
        now - theirs.priceAt <= this.options.confirmWithinMs &&
        this.near(price, theirs.price, this.options.confirmTolerance)
      ) {
        accept(feed, price, now);
        this.onEvent({ type: 'confirmed', coin, provider, price, by: other });
        return;
      }
    }
    feed.suspect = { price, at: now };
    this.onEvent({ type: 'held', coin, provider, price, reference });
  }

  heartbeat(provider: ProviderName, coin: LiveCoin, now: number): void {
    if (this.coins.has(coin)) {
      this.feed(provider, coin).heartbeatAt = now;
    }
  }

  /**
   * Each coin's price for the tick at `now`, given which provider connections are alive. A
   * coin nobody prices is left out.
   */
  pick(now: number, alive: (provider: ProviderName) => boolean): LivePick[] {
    const picks: LivePick[] = [];
    for (const [coin, state] of this.coins) {
      const healthy = new Set<ProviderName>();
      for (const provider of this.options.providers) {
        const feed = this.feed(provider, coin);
        if (alive(provider) && this.fresh(feed, now)) {
          healthy.add(provider);
          feed.healthySince ??= now;
        } else {
          if (feed.healthySince !== undefined) feed.failed = true;
          feed.healthySince = undefined;
        }
      }

      const choice = this.choose(coin, state, healthy, now);
      if (!choice) {
        if (state.source) {
          this.onEvent({ type: 'unavailable', coin, from: state.source });
          state.source = null;
        }
        continue;
      }
      const price = this.feed(choice, coin).price as number;
      state.source = choice;
      state.published = price;
      picks.push({ coin, price, source: choice });
      this.checkDivergence(coin, state, healthy);
    }
    return picks;
  }

  private choose(
    coin: LiveCoin,
    state: CoinState,
    healthy: Set<ProviderName>,
    now: number,
  ): ProviderName | null {
    const order = this.options.providers;
    const current = state.source;
    if (!current || !healthy.has(current)) {
      const next = order.find((p) => healthy.has(p));
      if (next) {
        this.onEvent({
          type: 'switch',
          coin,
          from: current,
          to: next,
          reason: !current
            ? 'first healthy provider'
            : `${current} is ${this.whyUnhealthy(current, coin, now)}`,
        });
      }
      return next ?? null;
    }
    // A more preferred provider that is back (or newly connected) may take the coin.
    for (const candidate of order.slice(0, order.indexOf(current))) {
      if (!healthy.has(candidate)) continue;
      const feed = this.feed(candidate, coin);
      const steady =
        now - (feed.healthySince ?? now) >= this.options.failbackAfterMs;
      if (!feed.failed || steady) {
        this.onEvent({
          type: 'switch',
          coin,
          from: current,
          to: candidate,
          reason: feed.failed
            ? `${candidate} healthy for ${Math.round((now - (feed.healthySince ?? now)) / 1000)} s`
            : `${candidate} connected`,
        });
        return candidate;
      }
    }
    return current;
  }

  private checkDivergence(
    coin: LiveCoin,
    state: CoinState,
    healthy: Set<ProviderName>,
  ): void {
    if (healthy.size < 2) return;
    const prices = Object.fromEntries(
      [...healthy].map((p) => [p, this.feed(p, coin).price as number]),
    );
    const values = Object.values(prices);
    const spread =
      (Math.max(...values) - Math.min(...values)) / Math.min(...values);
    if (spread > this.options.divergence && !state.diverging) {
      state.diverging = true;
      this.onEvent({ type: 'diverging', coin, prices });
    } else if (spread <= this.options.divergence && state.diverging) {
      state.diverging = false;
      this.onEvent({ type: 'converged', coin });
    }
  }

  private whyUnhealthy(
    provider: ProviderName,
    coin: LiveCoin,
    now: number,
  ): string {
    const feed = this.feed(provider, coin);
    return this.fresh(feed, now) ? 'disconnected' : `silent for ${coin}`;
  }

  private fresh(feed: Feed, now: number): boolean {
    if (feed.price === undefined || feed.priceAt === undefined) return false;
    const last = Math.max(feed.priceAt, feed.heartbeatAt ?? 0);
    return now - last <= this.options.staleAfterMs;
  }

  private confirms(feed: Feed, price: number, now: number): boolean {
    return (
      feed.suspect !== undefined &&
      now - feed.suspect.at <= this.options.confirmWithinMs &&
      this.near(price, feed.suspect.price, this.options.confirmTolerance)
    );
  }

  private near(price: number, reference: number, fraction: number): boolean {
    return Math.abs(price - reference) <= fraction * reference;
  }

  private feed(provider: ProviderName, coin: LiveCoin): Feed {
    const key = `${provider}:${coin}`;
    let feed = this.feeds.get(key);
    if (!feed) {
      feed = { failed: false };
      this.feeds.set(key, feed);
    }
    return feed;
  }
}

function accept(feed: Feed, price: number, at: number): void {
  feed.price = price;
  feed.priceAt = at;
  feed.suspect = undefined;
}

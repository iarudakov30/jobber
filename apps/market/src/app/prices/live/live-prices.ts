import { Inject, Injectable, Logger } from '@nestjs/common';
import { LIVE_COINS, LiveCoin } from '../coins';
import {
  BINANCE_REST_URL,
  BINANCE_WS_URL,
  BinanceProvider,
} from '../providers/binance.provider';
import {
  COINBASE_REST_URL,
  COINBASE_WS_URL,
  CoinbaseProvider,
} from '../providers/coinbase.provider';
import {
  PROVIDER_NAMES,
  PriceProvider,
  ProviderName,
  ProviderOptions,
} from '../providers/price-provider';
import {
  LivePick,
  PickerEvent,
  RatePicker,
  RatePickerOptions,
} from './rate-picker';

export const LIVE_PRICES_OPTIONS = Symbol('LIVE_PRICES_OPTIONS');

export interface LivePricesOptions {
  /** Off: the live coins have no price (tests, offline). */
  enabled: boolean;
  /** Order of preference. */
  providers: ProviderName[];
  endpoints: Record<ProviderName, { wsUrl: string; restUrl: string }>;
  /** Timings for the providers' connections (tests shorten them). */
  connection?: Omit<ProviderOptions, 'wsUrl' | 'restUrl'>;
  picker?: Partial<Omit<RatePickerOptions, 'providers'>>;
}

type Env = (name: string) => string | undefined;

/**
 * `MARKET_LIVE_PRICES` (`on` to connect; unset or anything else is off, so nothing reaches the
 * internet unless asked), `MARKET_PRICE_PROVIDERS` (default `binance,coinbase`: Coinbase's
 * market data terms are the stricter, so it only prices a coin Binance can't), and the four
 * endpoint URLs (default the public ones).
 */
export function livePricesOptionsFromEnv(env: Env): LivePricesOptions {
  const listed = (env('MARKET_PRICE_PROVIDERS') ?? 'binance,coinbase')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = listed.filter(
    (name) => !(PROVIDER_NAMES as readonly string[]).includes(name),
  );
  if (
    listed.length === 0 ||
    unknown.length > 0 ||
    new Set(listed).size !== listed.length
  ) {
    throw new Error(
      `MARKET_PRICE_PROVIDERS must list ${PROVIDER_NAMES.join(' and/or ')} once each, got "${env('MARKET_PRICE_PROVIDERS')}"`,
    );
  }
  return {
    enabled: env('MARKET_LIVE_PRICES') === 'on',
    providers: listed as ProviderName[],
    endpoints: {
      coinbase: {
        wsUrl: env('COINBASE_WS_URL') || COINBASE_WS_URL,
        restUrl: env('COINBASE_REST_URL') || COINBASE_REST_URL,
      },
      binance: {
        wsUrl: env('BINANCE_WS_URL') || BINANCE_WS_URL,
        restUrl: env('BINANCE_REST_URL') || BINANCE_REST_URL,
      },
    },
  };
}

/**
 * The live coins' prices on the leader: both providers connected the whole time it leads (hot
 * standby, so a failover costs no reconnect), their prices fed to a `RatePicker`, which the
 * ticker asks once a second. Followers keep the providers too (unconnected): their REST
 * candles serve `GenerateCandles` on any replica (step 4).
 */
@Injectable()
export class LivePrices {
  private readonly logger = new Logger(LivePrices.name);
  readonly providers: PriceProvider[];
  private picker: RatePicker | null = null;

  constructor(
    @Inject(LIVE_PRICES_OPTIONS) private readonly options: LivePricesOptions,
  ) {
    this.providers = options.providers.map((name) => {
      const config = { ...options.connection, ...options.endpoints[name] };
      return name === 'coinbase'
        ? new CoinbaseProvider(config)
        : new BinanceProvider(config);
    });
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Whether each provider's connection is alive right now (false while not leading). */
  status(): Record<string, boolean> {
    return Object.fromEntries(this.providers.map((p) => [p.name, p.alive]));
  }

  /**
   * Connects every provider. `references` are the live prices the previous leader published
   * recently, so a first price that jumps from them is checked like any other.
   */
  start(references: Partial<Record<LiveCoin, number>> = {}): void {
    if (!this.options.enabled || this.picker) return;
    const picker = new RatePicker(
      LIVE_COINS,
      { ...this.options.picker, providers: this.options.providers },
      (event) => this.log(event),
    );
    for (const [coin, price] of Object.entries(references)) {
      picker.setReference(coin as LiveCoin, price);
    }
    this.picker = picker;
    this.logger.log(
      `Live prices from ${this.options.providers.join(', then ')}`,
    );
    for (const provider of this.providers) {
      provider.connect(
        LIVE_COINS,
        (coin, price) => picker.observe(provider.name, coin, price, Date.now()),
        (coin) => picker.heartbeat(provider.name, coin, Date.now()),
      );
    }
  }

  /** Disconnects; the next `start` begins with no state. */
  async stop(): Promise<void> {
    if (!this.picker) return;
    this.picker = null;
    await Promise.all(this.providers.map((p) => p.disconnect()));
    this.logger.log('Live prices stopped');
  }

  /** The live coins' prices for the tick at `now`: those with a healthy provider. */
  pick(now: number): LivePick[] {
    if (!this.picker) return [];
    const alive = new Map(this.providers.map((p) => [p.name, p.alive]));
    return this.picker.pick(now, (name) => alive.get(name) ?? false);
  }

  private log(event: PickerEvent): void {
    switch (event.type) {
      case 'switch':
        if (event.from === null) {
          this.logger.log(`${event.coin}: priced by ${event.to}`);
        } else {
          this.logger.warn(
            `${event.coin}: ${event.from} → ${event.to} (${event.reason})`,
          );
        }
        return;
      case 'unavailable':
        this.logger.warn(`${event.coin}: no healthy provider, no price`);
        return;
      case 'held':
        this.logger.warn(
          `${event.coin}: held back ${dollars(event.price)} from ${event.provider}, ` +
            `${pct(event.price, event.reference)} from ${dollars(event.reference)}`,
        );
        return;
      case 'confirmed':
        this.logger.log(
          `${event.coin}: ${dollars(event.price)} from ${event.provider} confirmed by ${event.by}`,
        );
        return;
      case 'diverging':
        this.logger.warn(
          `${event.coin}: providers differ by more than 1%: ` +
            Object.entries(event.prices)
              .map(([name, price]) => `${name} ${dollars(price)}`)
              .join(', '),
        );
        return;
      case 'converged':
        this.logger.log(`${event.coin}: providers agree again`);
        return;
    }
  }
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function pct(price: number, reference: number): string {
  const change = ((price - reference) / reference) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}%`;
}

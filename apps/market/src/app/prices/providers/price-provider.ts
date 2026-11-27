import { Candle } from '../candle-builder';
import { LiveCoin } from '../coins';

/** The exchanges a live coin's price can come from, in no particular order. */
export const PROVIDER_NAMES = ['coinbase', 'binance'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * A price from an exchange: `price` is USD cents per whole coin, not rounded (the tick rounds it
 * once), `at` the exchange's own time of the price in ms.
 */
export type OnPrice = (coin: LiveCoin, price: number, at: number) => void;

/** The exchange says a coin's stream is working, with no new price (no trade since). */
export type OnHeartbeat = (coin: LiveCoin) => void;

/**
 * One exchange's public market data: a live price stream over WebSocket and 1-minute candles
 * over REST. A provider reconnects on its own; whoever uses it only reads `alive` and the
 * prices it reports.
 */
export interface PriceProvider {
  readonly name: ProviderName;
  /** Opens the stream for `coins` and keeps it open (reconnecting) until `disconnect`. */
  connect(
    coins: readonly LiveCoin[],
    onPrice: OnPrice,
    onHeartbeat?: OnHeartbeat,
  ): void;
  /** Closes the stream and stops reconnecting. */
  disconnect(): Promise<void>;
  /** The connection is open and something (a price or a heartbeat) arrived in the last 5 s. */
  readonly alive: boolean;
  /**
   * 1-minute candles in USD cents with `from <= start < to`, oldest first. Throws
   * `ProviderError` when the exchange refuses or can't be reached.
   */
  candles(coin: LiveCoin, from: Date, to: Date): Promise<Candle[]>;
}

/** The exchange refused a request, answered with something unusable, or couldn't be reached. */
export class ProviderError extends Error {
  constructor(
    readonly provider: ProviderName,
    message: string,
    /** The HTTP status, when the exchange answered. */
    readonly status?: number,
  ) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

export interface ProviderOptions {
  /** WebSocket endpoint, without a path the provider adds itself. */
  wsUrl: string;
  /** REST endpoint, without a trailing slash. */
  restUrl: string;
  /** How recent the last message must be for `alive`. Default 5 s. */
  aliveWindowMs?: number;
  /**
   * An open connection that has received nothing (not even a ping) for this long is assumed
   * dead and replaced. Default 30 s.
   */
  stallTimeoutMs?: number;
  /** Reconnect delays: from `min`, doubling to `max`, each ×(0.5–1). Default 1 s → 30 s. */
  backoff?: { minMs: number; maxMs: number };
  /** Per REST request. Default 10 s. */
  requestTimeoutMs?: number;
}

export const DEFAULT_ALIVE_WINDOW_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 30_000;
export const DEFAULT_BACKOFF = { minMs: 1_000, maxMs: 30_000 };
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

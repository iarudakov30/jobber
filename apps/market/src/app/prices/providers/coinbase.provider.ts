import { Logger } from '@nestjs/common';
import { Candle, MINUTE_MS } from '../candle-builder';
import { LiveCoin, liveSymbols } from '../coins';
import { floatCentsOf } from './cents';
import { ceilToMinute, getJson, sortedUnique, toCandle } from './http';
import {
  DEFAULT_ALIVE_WINDOW_MS,
  DEFAULT_BACKOFF,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  OnPrice,
  PriceProvider,
  ProviderError,
  ProviderOptions,
} from './price-provider';
import { ReconnectingSocket } from './reconnecting-socket';

export const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';
export const COINBASE_REST_URL = 'https://api.exchange.coinbase.com';

/** The most candles Coinbase returns for one request: 5 requests a day. */
export const COINBASE_CANDLES_PER_REQUEST = 300;

/**
 * Coinbase Exchange's public market data (no API key), USD pairs (`BTC-USD`).
 *
 * - **Stream:** one connection to the feed, subscribed to `ticker` and `heartbeat` for every
 *   product. A ticker arrives on every trade (and once right after subscribing); a heartbeat
 *   arrives every second per product, so a quiet pair still keeps the connection `alive`.
 * - **Candles:** `GET /products/{id}/candles?granularity=60`, at most 300 per request, each
 *   `[time (s), low, high, open, close, volume]`.
 */
export class CoinbaseProvider implements PriceProvider {
  readonly name = 'coinbase';
  private readonly logger = new Logger(CoinbaseProvider.name);
  private readonly socket: ReconnectingSocket;

  constructor(private readonly options: ProviderOptions) {
    this.socket = new ReconnectingSocket(this.logger, {
      aliveWindowMs: options.aliveWindowMs ?? DEFAULT_ALIVE_WINDOW_MS,
      stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
      backoff: options.backoff ?? DEFAULT_BACKOFF,
    });
  }

  get alive(): boolean {
    return this.socket.alive;
  }

  connect(coins: readonly LiveCoin[], onPrice: OnPrice): void {
    const byProduct = new Map(
      coins.map((coin) => [liveSymbols(coin).coinbase, coin]),
    );
    this.socket.start({
      url: () => this.options.wsUrl,
      onOpen: (send) =>
        send({
          type: 'subscribe',
          product_ids: [...byProduct.keys()],
          channels: ['ticker', 'heartbeat'],
        }),
      onMessage: (text) => this.handle(text, byProduct, onPrice),
    });
  }

  disconnect(): Promise<void> {
    return this.socket.stop();
  }

  async candles(coin: LiveCoin, from: Date, to: Date): Promise<Candle[]> {
    const product = liveSymbols(coin).coinbase;
    const end = to.getTime();
    const candles: Candle[] = [];
    const step = COINBASE_CANDLES_PER_REQUEST * MINUTE_MS;
    for (let start = ceilToMinute(from.getTime()); start < end; start += step) {
      const windowEnd = Math.min(start + step, end);
      // Coinbase includes both ends of the range: end at the last minute that starts in it.
      const last = ceilToMinute(windowEnd) - MINUTE_MS;
      const params = new URLSearchParams({
        granularity: '60',
        start: new Date(start).toISOString(),
        end: new Date(last).toISOString(),
      });
      const rows = await getJson(
        this.name,
        `${this.options.restUrl}/products/${product}/candles?${params}`,
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (!Array.isArray(rows)) {
        throw new ProviderError(
          this.name,
          `candles for ${product}: not a list`,
        );
      }
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const [time, low, high, open, close] = row;
        const at = Number(time) * 1000;
        if (at < start || at >= windowEnd) continue;
        const candle = toCandle(coin, at, { open, high, low, close });
        if (candle) {
          candles.push(candle);
        } else {
          this.logger.warn(
            `Skipped a malformed ${product} candle: ${JSON.stringify(row)}`,
          );
        }
      }
    }
    return sortedUnique(candles);
  }

  private handle(
    text: string,
    byProduct: Map<string, LiveCoin>,
    onPrice: OnPrice,
  ): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      this.logger.warn(`Ignored a non-JSON message: ${text.slice(0, 100)}`);
      return;
    }
    switch (message['type']) {
      case 'ticker': {
        const coin = byProduct.get(String(message['product_id']));
        const price = floatCentsOf(message['price']);
        const at = Date.parse(String(message['time']));
        if (coin && price !== null && Number.isFinite(at)) {
          onPrice(coin, price, at);
        } else {
          this.logger.warn(`Ignored a malformed ticker: ${text.slice(0, 200)}`);
        }
        return;
      }
      case 'error':
        // Coinbase closes the connection after an error; the socket reconnects.
        this.logger.error(
          `Coinbase error: ${message['message']}${message['reason'] ? ` (${message['reason']})` : ''}`,
        );
        return;
      default:
        // `heartbeat` and `subscriptions` only keep the connection alive.
        return;
    }
  }
}

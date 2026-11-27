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

/** Binance's market-data-only hosts: the same public data as stream/api.binance.com, no keys. */
export const BINANCE_WS_URL = 'wss://data-stream.binance.vision';
export const BINANCE_REST_URL = 'https://data-api.binance.vision';

/** The most klines Binance returns for one request: 2 requests a day. */
export const BINANCE_KLINES_PER_REQUEST = 1000;

/**
 * Binance's public market data (no API key), USDT pairs (`BTCUSDT`): the fallback. USDT is used
 * as USD (normally within 0.1%).
 *
 * - **Stream:** one combined-stream connection, `/stream?streams=btcusdt@miniTicker/…`. Each
 *   mini-ticker comes once a second with the last price (`c`) and the event time (`E`). Binance
 *   has no heartbeat message, but four symbols ticking every second keep the connection
 *   `alive`; its ping frames (every 20 s) are answered by `ws` and count against stalling. A
 *   connection lasts at most 24 h, and `serverShutdown` announces a planned close: both just
 *   reconnect, the second at once.
 * - **Candles:** `GET /api/v3/klines?interval=1m`, at most 1,000 per request, oldest first, each
 *   `[open time (ms), open, high, low, close, …]`.
 */
export class BinanceProvider implements PriceProvider {
  readonly name = 'binance';
  private readonly logger = new Logger(BinanceProvider.name);
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
    const bySymbol = new Map(
      coins.map((coin) => [liveSymbols(coin).binance, coin]),
    );
    const streams = [...bySymbol.keys()]
      .map((symbol) => `${symbol.toLowerCase()}@miniTicker`)
      .join('/');
    this.socket.start({
      url: () => `${this.options.wsUrl}/stream?streams=${streams}`,
      onMessage: (text) => this.handle(text, bySymbol, onPrice),
    });
  }

  disconnect(): Promise<void> {
    return this.socket.stop();
  }

  async candles(coin: LiveCoin, from: Date, to: Date): Promise<Candle[]> {
    const symbol = liveSymbols(coin).binance;
    const end = to.getTime();
    const candles: Candle[] = [];
    let start = ceilToMinute(from.getTime());
    while (start < end) {
      const params = new URLSearchParams({
        symbol,
        interval: '1m',
        startTime: String(start),
        endTime: String(end - 1),
        limit: String(BINANCE_KLINES_PER_REQUEST),
      });
      const rows = await getJson(
        this.name,
        `${this.options.restUrl}/api/v3/klines?${params}`,
        this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      );
      if (!Array.isArray(rows)) {
        throw new ProviderError(this.name, `klines for ${symbol}: not a list`);
      }
      let latest = -1;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const [openTime, open, high, low, close] = row;
        const at = Number(openTime);
        if (at < start || at >= end) continue;
        latest = Math.max(latest, at);
        const candle = toCandle(coin, at, { open, high, low, close });
        if (candle) {
          candles.push(candle);
        } else {
          this.logger.warn(
            `Skipped a malformed ${symbol} kline: ${JSON.stringify(row)}`,
          );
        }
      }
      if (rows.length < BINANCE_KLINES_PER_REQUEST || latest < start) {
        break; // the range is exhausted (or the answer made no progress)
      }
      start = latest + MINUTE_MS;
    }
    return sortedUnique(candles);
  }

  private handle(
    text: string,
    bySymbol: Map<string, LiveCoin>,
    onPrice: OnPrice,
  ): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text);
    } catch {
      this.logger.warn(`Ignored a non-JSON message: ${text.slice(0, 100)}`);
      return;
    }
    // Combined streams wrap each event as { stream, data }.
    const event = (message['data'] ?? message) as Record<string, unknown>;
    switch (event['e']) {
      case '24hrMiniTicker': {
        const coin = bySymbol.get(String(event['s']));
        const price = floatCentsOf(event['c']);
        const at = Number(event['E']);
        if (coin && price !== null && Number.isSafeInteger(at) && at > 0) {
          onPrice(coin, price, at);
        } else {
          this.logger.warn(
            `Ignored a malformed mini-ticker: ${text.slice(0, 200)}`,
          );
        }
        return;
      }
      case 'serverShutdown':
        this.socket.reconnectNow('Binance announced a server shutdown');
        return;
      default:
        return;
    }
  }
}

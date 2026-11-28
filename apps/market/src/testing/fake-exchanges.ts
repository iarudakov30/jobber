import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { AddressInfo, Socket } from 'net';
import WebSocket, { WebSocketServer } from 'ws';

/** A 1-minute candle as an exchange stores it: decimal strings, `start` in ms. */
export interface FakeCandle {
  start: number;
  open: string;
  high: string;
  low: string;
  close: string;
}

/**
 * A day of made-up 1-minute candles around `price` (USD, e.g. 60000): 1,440 of them, each a
 * little different, so a test can tell the minutes apart.
 */
export function fakeDay(day: string, price: number): FakeCandle[] {
  return fakeCandles(Date.parse(`${day}T00:00:00Z`), 1440, price);
}

/**
 * `count` made-up 1-minute candles from `start` (ms, a whole minute): minute `i` opens at
 * `price + i/100` and closes 50 cents higher.
 */
export function fakeCandles(
  start: number,
  count: number,
  price: number,
): FakeCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const open = price + i / 100;
    const close = open + 0.5;
    return {
      start: start + i * 60_000,
      open: open.toFixed(2),
      high: (close + 1).toFixed(2),
      low: (open - 1).toFixed(2),
      close: close.toFixed(2),
    };
  });
}

interface Client {
  socket: WebSocket;
  /** The symbols it gets prices for, in the exchange's spelling. */
  symbols: Set<string>;
}

/**
 * What both fakes share: an HTTP server for REST and WebSocket upgrades on one random port,
 * and the switches tests use to break things.
 *
 * - `setPrice(symbol, price)`: the current price, sent to subscribers at once.
 * - `silence(symbol)`: nothing more about that symbol (no prices, no heartbeats); `mute()`:
 *   nothing at all, the connection stays open.
 * - `drop()`: closes every connection; `refuse(status)`: upgrades get that HTTP status.
 * - `setCandles`, `failRest(status)`, `restRequests` for the REST side.
 */
abstract class FakeExchange {
  readonly prices = new Map<string, string>();
  readonly candles = new Map<string, FakeCandle[]>();
  /** Path and query of every REST request, in order. */
  readonly restRequests: string[] = [];
  /** Accepted WebSocket connections, ever. */
  connections = 0;
  /** Refused WebSocket upgrades, ever. */
  refused = 0;
  protected readonly clients = new Set<Client>();
  private readonly silenced = new Set<string>();
  private muted = false;
  private refusing: number | null = null;
  private restFailure: number | null = null;
  private readonly server: Server;
  private readonly wss = new WebSocketServer({ noServer: true });
  private ticker: NodeJS.Timeout | null = null;

  protected constructor(private readonly tickMs: number) {
    this.server = createServer((req, res) => this.handleRest(req, res));
    this.server.on('upgrade', (req, socket, head) =>
      this.upgrade(req, socket as Socket, head),
    );
  }

  protected async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve),
    );
    this.ticker = setInterval(() => this.tick(), this.tickMs);
  }

  get wsUrl(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  get restUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** Open connections. */
  get open(): number {
    return this.clients.size;
  }

  setPrice(symbol: string, price: string): void {
    this.prices.set(symbol, price);
    for (const client of this.clients) {
      if (client.symbols.has(symbol) && this.speaks(symbol)) {
        client.socket.send(this.priceMessage(symbol, price));
      }
    }
  }

  silence(symbol: string): void {
    this.silenced.add(symbol);
  }

  unsilence(symbol: string): void {
    this.silenced.delete(symbol);
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  /** Every connection closed (1001, going away). */
  drop(): void {
    for (const client of this.clients) {
      client.socket.close(1001);
    }
  }

  /** New upgrades get `status` until `accept()`. */
  refuse(status = 503): void {
    this.refusing = status;
  }

  accept(): void {
    this.refusing = null;
  }

  /** Sends `text` as is to every connection. */
  sendRaw(text: string): void {
    for (const client of this.clients) {
      client.socket.send(text);
    }
  }

  setCandles(symbol: string, candles: FakeCandle[]): void {
    this.candles.set(symbol, candles);
  }

  /** Every REST request gets `status` until `failRest(null)`. */
  failRest(status: number | null): void {
    this.restFailure = status;
  }

  async stop(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    for (const client of this.clients) {
      client.socket.terminate();
    }
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The symbols a new connection gets, from its URL; null if it subscribes by message. */
  protected abstract symbolsFromUrl(url: URL): Set<string> | null;
  protected abstract onClientMessage(client: Client, text: string): void;
  protected abstract priceMessage(symbol: string, price: string): string;
  /** Sent every `tickMs` per symbol that speaks (a heartbeat, or the price again). */
  protected abstract tickMessage(symbol: string): string | null;
  protected abstract rest(url: URL): { status: number; body: unknown };

  protected speaks(symbol: string): boolean {
    return !this.muted && !this.silenced.has(symbol);
  }

  private get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (this.refusing !== null) {
      this.refused += 1;
      socket.end(
        `HTTP/1.1 ${this.refusing} Refused\r\nConnection: close\r\n\r\n`,
      );
      return;
    }
    const url = new URL(req.url ?? '/', 'http://fake');
    const symbols = this.symbolsFromUrl(url);
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.connections += 1;
      const client: Client = { socket: ws, symbols: symbols ?? new Set() };
      this.clients.add(client);
      ws.on('message', (data) => this.onClientMessage(client, data.toString()));
      ws.on('close', () => this.clients.delete(client));
    });
  }

  private tick(): void {
    for (const client of this.clients) {
      for (const symbol of client.symbols) {
        if (!this.speaks(symbol)) continue;
        const message = this.tickMessage(symbol);
        if (message) client.socket.send(message);
      }
    }
  }

  private handleRest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://fake');
    this.restRequests.push(url.pathname + url.search);
    const { status, body } =
      this.restFailure !== null
        ? { status: this.restFailure, body: { message: 'refused by the test' } }
        : this.rest(url);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/**
 * Coinbase Exchange's public feed and candles: `subscribe` to `ticker` + `heartbeat` by
 * product; a ticker on every `setPrice` (and the current one right after subscribing), a
 * heartbeat per product every `tickMs`. Candles newest first, `[time (s), low, high, open,
 * close, volume]` as numbers, both ends of the range included, at most 300 (more is a 400).
 */
export class FakeCoinbase extends FakeExchange {
  private sequence = 0;

  static async start(tickMs = 1_000): Promise<FakeCoinbase> {
    const fake = new FakeCoinbase(tickMs);
    await fake.listen();
    return fake;
  }

  /** Every `subscribe` received, in order. */
  readonly subscriptions: { product_ids: string[]; channels: string[] }[] = [];

  protected symbolsFromUrl(): null {
    return null;
  }

  protected onClientMessage(client: Client, text: string): void {
    const message = JSON.parse(text);
    if (message.type !== 'subscribe') return;
    this.subscriptions.push(message);
    for (const product of message.product_ids) {
      client.symbols.add(product);
    }
    client.socket.send(
      JSON.stringify({
        type: 'subscriptions',
        channels: message.channels.map((name: string) => ({
          name,
          product_ids: message.product_ids,
        })),
      }),
    );
    for (const product of message.product_ids) {
      const price = this.prices.get(product);
      if (price && this.speaks(product)) {
        client.socket.send(this.priceMessage(product, price));
      }
    }
  }

  protected priceMessage(product: string, price: string): string {
    return JSON.stringify({
      type: 'ticker',
      sequence: ++this.sequence,
      product_id: product,
      price,
      side: 'buy',
      time: new Date().toISOString(),
      trade_id: this.sequence,
      last_size: '0.001',
    });
  }

  protected tickMessage(product: string): string {
    return JSON.stringify({
      type: 'heartbeat',
      sequence: ++this.sequence,
      last_trade_id: this.sequence,
      product_id: product,
      time: new Date().toISOString(),
    });
  }

  protected rest(url: URL): { status: number; body: unknown } {
    const match = /^\/products\/([^/]+)\/candles$/.exec(url.pathname);
    if (!match || url.searchParams.get('granularity') !== '60') {
      return { status: 404, body: { message: 'NotFound' } };
    }
    const from = Date.parse(url.searchParams.get('start') ?? '');
    const to = Date.parse(url.searchParams.get('end') ?? '');
    const rows = (this.candles.get(match[1]) ?? []).filter(
      (c) => c.start >= from && c.start <= to,
    );
    if (rows.length > 300) {
      return {
        status: 400,
        body: { message: 'granularity too small for the requested time range' },
      };
    }
    return {
      status: 200,
      body: rows
        .map((c) => [c.start / 1000, +c.low, +c.high, +c.open, +c.close, 12.5])
        .reverse(),
    };
  }
}

/**
 * Binance's combined stream and klines: `/stream?streams=btcusdt@kline_1s/…`, a 1-second kline
 * per symbol every `tickMs` (and on every `setPrice`) as `{ stream, data }`, its close the
 * current price, trades or not (`n`: 1 after a `setPrice`, else 0); `shutdownNotice()` sends
 * `serverShutdown`. Klines over REST oldest first, `[open time, open, high, low, close, …]` as
 * strings, `limit` at most.
 */
export class FakeBinance extends FakeExchange {
  static async start(tickMs = 1_000): Promise<FakeBinance> {
    const fake = new FakeBinance(tickMs);
    await fake.listen();
    return fake;
  }

  /** The `streams` query of every connection, in order. */
  readonly streamQueries: string[] = [];

  shutdownNotice(): void {
    const now = Date.now();
    this.sendRaw(
      JSON.stringify({
        stream: '!serverShutdown',
        data: { e: 'serverShutdown', E: now, T: now + 1_000 },
      }),
    );
  }

  protected symbolsFromUrl(url: URL): Set<string> {
    const streams = url.searchParams.get('streams') ?? '';
    this.streamQueries.push(streams);
    return new Set(
      streams
        .split('/')
        .filter((s) => s.endsWith('@kline_1s'))
        .map((s) => s.slice(0, -'@kline_1s'.length).toUpperCase()),
    );
  }

  protected onClientMessage(): void {
    // Combined streams take their subscriptions from the URL.
  }

  protected priceMessage(symbol: string, price: string): string {
    return this.kline(symbol, price, 1);
  }

  protected tickMessage(symbol: string): string | null {
    const price = this.prices.get(symbol);
    return price ? this.kline(symbol, price, 0) : null;
  }

  private kline(symbol: string, price: string, trades: number): string {
    const now = Date.now();
    const second = Math.floor(now / 1_000) * 1_000;
    return JSON.stringify({
      stream: `${symbol.toLowerCase()}@kline_1s`,
      data: {
        e: 'kline',
        E: now,
        s: symbol,
        k: {
          t: second,
          T: second + 999,
          s: symbol,
          i: '1s',
          o: price,
          c: price,
          h: price,
          l: price,
          v: trades ? '0.5' : '0',
          n: trades,
          x: false,
        },
      },
    });
  }

  protected rest(url: URL): { status: number; body: unknown } {
    if (
      url.pathname !== '/api/v3/klines' ||
      url.searchParams.get('interval') !== '1m'
    ) {
      return { status: 404, body: { code: -1, msg: 'not found' } };
    }
    const symbol = url.searchParams.get('symbol') ?? '';
    const from = Number(url.searchParams.get('startTime') ?? 0);
    const to = Number(
      url.searchParams.get('endTime') ?? Number.MAX_SAFE_INTEGER,
    );
    const limit = Number(url.searchParams.get('limit') ?? 500);
    const rows = (this.candles.get(symbol) ?? [])
      .filter((c) => c.start >= from && c.start <= to)
      .slice(0, limit);
    return {
      status: 200,
      body: rows.map((c) => [
        c.start,
        c.open,
        c.high,
        c.low,
        c.close,
        '100',
        c.start + 59_999,
        '1000000',
        42,
        '50',
        '500000',
        '0',
      ]),
    };
  }
}

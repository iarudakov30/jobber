import { Logger } from '@nestjs/common';
import WebSocket from 'ws';

export interface ReconnectingSocketOptions {
  aliveWindowMs: number;
  stallTimeoutMs: number;
  backoff: { minMs: number; maxMs: number };
  /** How long the WebSocket handshake may take. Default 10 s. */
  handshakeTimeoutMs?: number;
}

export interface SocketHandlers {
  /** Called on every connect: the URL to open (it may depend on the subscribed coins). */
  url(): string;
  /** The connection is open: subscribe here. */
  onOpen?(send: (message: unknown) => void): void;
  /** A text message. Never throws into the socket: parse errors are the handler's own. */
  onMessage(text: string): void;
}

/**
 * A client WebSocket that stays connected: after any close it reconnects from 1 s, doubling to
 * 30 s, each delay ×(0.5–1), back to 1 s once a connection has delivered a message (a server
 * that accepts and closes at once still backs off). A connection that delivers nothing, not
 * even a ping, for `stallTimeoutMs` is terminated and replaced: a half-open TCP connection
 * would otherwise look open forever.
 */
export class ReconnectingSocket {
  private socket: WebSocket | null = null;
  private handlers: SocketHandlers | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private lastMessageAt = 0;
  private immediate = false;
  private stopped = true;

  constructor(
    private readonly logger: Logger,
    private readonly options: ReconnectingSocketOptions,
  ) {}

  /** Open and something arrived within `aliveWindowMs`. */
  get alive(): boolean {
    return (
      this.socket?.readyState === WebSocket.OPEN &&
      Date.now() - this.lastMessageAt <= this.options.aliveWindowMs
    );
  }

  start(handlers: SocketHandlers): void {
    if (!this.stopped) {
      throw new Error('already started');
    }
    this.handlers = handlers;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Drops the current connection and reconnects at once (the server announced a shutdown). */
  reconnectNow(reason: string): void {
    if (!this.socket || this.stopped) return;
    this.logger.log(`Reconnecting at once: ${reason}`);
    this.immediate = true;
    this.socket.terminate();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      const forced = setTimeout(() => socket.terminate(), 1_000);
      socket.once('close', () => {
        clearTimeout(forced);
        resolve();
      });
      socket.close(1000);
    });
  }

  private open(): void {
    const handlers = this.handlers;
    if (!handlers) return;
    const url = handlers.url();
    const socket = new WebSocket(url, {
      handshakeTimeout: this.options.handshakeTimeoutMs ?? 10_000,
    });
    this.socket = socket;
    this.lastMessageAt = 0;

    socket.on('open', () => {
      this.logger.log(`Connected to ${withoutQuery(url)}`);
      this.stallTimer = setTimeout(() => {
        this.logger.warn(
          `Nothing received for ${this.options.stallTimeoutMs} ms: reconnecting`,
        );
        socket.terminate();
      }, this.options.stallTimeoutMs);
      handlers.onOpen?.((message) => socket.send(JSON.stringify(message)));
    });
    socket.on('ping', () => this.stallTimer?.refresh());
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      this.lastMessageAt = Date.now();
      this.attempt = 0;
      this.stallTimer?.refresh();
      handlers.onMessage(data.toString());
    });
    socket.on('error', (error) => {
      // 'close' follows; this only says why.
      this.logger.warn(`${withoutQuery(url)}: ${error.message}`);
    });
    socket.on('close', (code) => {
      if (this.stallTimer) {
        clearTimeout(this.stallTimer);
        this.stallTimer = null;
      }
      if (this.socket === socket) {
        this.socket = null;
      }
      if (this.stopped) return;
      const delay = this.immediate ? 0 : this.nextDelay();
      this.immediate = false;
      this.logger.warn(
        `Disconnected (${code}); reconnecting in ${Math.round(delay)} ms`,
      );
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (!this.stopped) this.open();
      }, delay);
    });
  }

  private nextDelay(): number {
    const { minMs, maxMs } = this.options.backoff;
    const base = Math.min(maxMs, minMs * 2 ** this.attempt);
    this.attempt += 1;
    return base * (0.5 + Math.random() * 0.5);
  }
}

function withoutQuery(url: string): string {
  const query = url.indexOf('?');
  return query < 0 ? url : url.slice(0, query);
}

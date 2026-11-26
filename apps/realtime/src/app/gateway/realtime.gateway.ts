import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { RawData, WebSocket, WebSocketServer } from 'ws';
import { User } from '@jobber/grpc';
import { errorText, userChannel } from '@jobber/rabbitmq';
import {
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SUBSCRIPTIONS,
  ProtocolError,
  ServerFrame,
  parseClientMessage,
} from './protocol';
import { RealtimeFeed } from './realtime-feed';
import { Registry } from './registry';
import { AuthUnavailableError, SocketAuth, cookieValue } from './socket-auth';

export const GATEWAY_OPTIONS = Symbol('GATEWAY_OPTIONS');

export interface GatewayOptions {
  /** The URL path that upgrades; anything else gets 404. */
  path: string;
  /** Browser origins allowed to connect; a request without `Origin` (not a browser) is allowed. */
  allowedOrigins: string[];
  /** A ping this often; a socket that missed `missedPongsAllowed` pongs in a row is terminated. */
  pingIntervalMs: number;
  missedPongsAllowed: number;
  /** Over this much unsent data, price messages to the socket are dropped. */
  dropPricesAboveBytes: number;
  /** Over this much for `closeAfterMs`, the socket is closed with 1013. */
  closeAboveBytes: number;
  closeAfterMs: number;
  /** How often sockets are checked against `closeAboveBytes`. */
  backpressureCheckMs: number;
  /** How long shutdown waits for clients to answer the 1012 close before cutting them off. */
  shutdownGraceMs: number;
}

export const DEFAULT_GATEWAY_OPTIONS: Omit<GatewayOptions, 'allowedOrigins'> = {
  path: '/realtime',
  pingIntervalMs: 25_000,
  missedPongsAllowed: 2,
  dropPricesAboveBytes: 1024 * 1024,
  closeAboveBytes: 4 * 1024 * 1024,
  closeAfterMs: 10_000,
  backpressureCheckMs: 1_000,
  shutdownGraceMs: 1_000,
};

/** Close codes the gateway uses. */
export const CLOSE_SERVICE_RESTART = 1012;
export const CLOSE_TRY_AGAIN_LATER = 1013;

interface SocketState {
  userId: number;
  missedPongs: number;
  /** Since when the socket has had more than `closeAboveBytes` unsent. */
  overSince?: number;
  /** Removed from the registry; only waiting for its close to finish. */
  released: boolean;
}

export interface GatewayStats {
  sockets: number;
  users: number;
  channels: number;
  feedReady: boolean;
  bindings: string[];
  received: number;
  delivered: number;
  droppedPrices: number;
  closedSlow: number;
  terminatedIdle: number;
  memory: { rssMb: number; heapUsedMb: number };
}

const REASONS: Record<number, string> = {
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};

/**
 * The WebSocket gateway: a raw `ws` server without its own HTTP server (`noServer`), attached to
 * Nest's. It handles `upgrade` itself, so the cookie is checked before a socket exists: a
 * missing or invalid one gets `HTTP/1.1 401` and the TCP connection is destroyed.
 *
 * Each socket joins its own `user.<id>` channel and may subscribe to public ones
 * (`prices.<coin>`). Messages come from `RealtimeFeed` and go to the channel's sockets.
 * Heartbeats find dead connections; backpressure protects the process from clients that don't
 * read; shutdown closes every socket with 1012 so clients reconnect (to another replica) at once.
 */
@Injectable()
export class RealtimeGateway
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CLIENT_MESSAGE_BYTES,
    clientTracking: false,
  });
  private readonly registry = new Registry<WebSocket>();
  private readonly states = new Map<WebSocket, SocketState>();
  private server?: Server;
  private heartbeat?: NodeJS.Timeout;
  private backpressure?: NodeJS.Timeout;
  private closing = false;
  private readonly counters = {
    delivered: 0,
    droppedPrices: 0,
    closedSlow: 0,
    terminatedIdle: 0,
  };
  private readonly onUpgrade = (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => this.upgrade(req, socket, head);

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly auth: SocketAuth,
    private readonly feed: RealtimeFeed,
    @Inject(GATEWAY_OPTIONS) private readonly options: GatewayOptions,
  ) {}

  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter.getHttpServer() as Server;
    this.server.on('upgrade', this.onUpgrade);
    this.feed.onMessage((channel, frame) => this.dispatch(channel, frame));
    this.feed.onResync(() => this.broadcast({ type: 'resync' }));
    this.heartbeat = setInterval(
      () => this.beat(),
      this.options.pingIntervalMs,
    );
    this.backpressure = setInterval(
      () => this.checkBackpressure(),
      this.options.backpressureCheckMs,
    );
  }

  /** Stops taking sockets and closes every open one with 1012 ("service restart"). */
  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    this.server?.off('upgrade', this.onUpgrade);
    clearInterval(this.heartbeat);
    clearInterval(this.backpressure);
    const sockets = [...this.states.keys()];
    const closed = sockets.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            return resolve();
          }
          ws.once('close', () => resolve());
          ws.close(CLOSE_SERVICE_RESTART, 'Service restart: reconnect');
        }),
    );
    if (sockets.length) {
      this.logger.log(`Closing ${sockets.length} socket(s) for shutdown`);
    }
    await Promise.race([
      Promise.all(closed),
      new Promise((r) => setTimeout(r, this.options.shutdownGraceMs)),
    ]);
    for (const ws of sockets) {
      ws.terminate();
    }
    this.wss.close();
  }

  stats(): GatewayStats {
    const memory = process.memoryUsage();
    return {
      ...this.registry.counts,
      feedReady: this.feed.isReady,
      bindings: this.feed.bindings,
      received: this.feed.received,
      ...this.counters,
      memory: {
        rssMb: Math.round(memory.rss / 1024 / 1024),
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      },
    };
  }

  // ---- upgrade -----------------------------------------------------------------------------

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // A client that resets mid-handshake mustn't take the process down.
    socket.on('error', () => socket.destroy());
    const path = new URL(req.url ?? '/', 'http://gateway').pathname;
    if (path !== this.options.path) {
      return refuse(socket, 404);
    }
    if (this.closing) {
      return refuse(socket, 503);
    }
    const origin = req.headers.origin;
    if (origin && !this.options.allowedOrigins.includes(origin)) {
      // A page on another site can't open a socket with the user's cookie.
      return refuse(socket, 403);
    }
    const token = cookieValue(req.headers.cookie, 'Authentication');
    if (!token) {
      return refuse(socket, 401);
    }
    this.auth.authenticate(token).then(
      (user) => {
        if (socket.destroyed) {
          return;
        }
        if (this.closing) {
          return refuse(socket, 503);
        }
        this.wss.handleUpgrade(req, socket, head, (ws) =>
          this.accept(ws, user),
        );
      },
      (error) =>
        refuse(socket, error instanceof AuthUnavailableError ? 503 : 401),
    );
  }

  private accept(ws: WebSocket, user: User): void {
    const state: SocketState = {
      userId: user.id,
      missedPongs: 0,
      released: false,
    };
    this.states.set(ws, state);
    const own = userChannel(user.id);
    this.registry.addSocket(user.id, ws);
    this.registry.join(ws, own);

    ws.on('pong', () => (state.missedPongs = 0));
    ws.on('message', (data, isBinary) => this.receive(ws, data, isBinary));
    ws.on('error', () => undefined);
    ws.on('close', () => {
      this.release(ws);
      this.states.delete(ws);
    });

    // The welcome goes out once RabbitMQ has the user's binding: a client that fetches its
    // snapshot after the welcome can't miss a change published after that fetch.
    this.feed.bindUser(user.id).then(() =>
      this.send(ws, {
        type: 'welcome',
        userId: user.id,
        channels: [...this.registry.channelsOf(ws)],
      }),
    );
  }

  // ---- client messages ---------------------------------------------------------------------

  private receive(ws: WebSocket, data: RawData, isBinary: boolean): void {
    try {
      if (isBinary) {
        throw new ProtocolError('BAD_REQUEST', 'Messages must be text frames');
      }
      const request = parseClientMessage(rawText(data));
      if (request.op === 'subscribe') {
        if (
          !this.registry.channelsOf(ws).has(request.channel) &&
          this.registry.channelsOf(ws).size >= MAX_SUBSCRIPTIONS
        ) {
          throw new ProtocolError(
            'TOO_MANY_SUBSCRIPTIONS',
            `At most ${MAX_SUBSCRIPTIONS} subscriptions per socket`,
            request.channel,
          );
        }
        this.registry.join(ws, request.channel);
        this.send(ws, { type: 'subscribed', channel: request.channel });
      } else {
        this.registry.leave(ws, request.channel);
        this.send(ws, { type: 'unsubscribed', channel: request.channel });
      }
    } catch (error) {
      if (error instanceof ProtocolError) {
        this.send(ws, error.toFrame());
        return;
      }
      this.logger.error(
        `Handling a client message failed: ${errorText(error)}`,
      );
    }
  }

  // ---- delivery ----------------------------------------------------------------------------

  /** One frame to every socket on the channel. Prices are dropped for sockets far behind. */
  private dispatch(channel: string, frame: string): void {
    const droppable = channel.startsWith('prices.');
    for (const ws of this.registry.subscribers(channel)) {
      if (droppable && ws.bufferedAmount > this.options.dropPricesAboveBytes) {
        // The next tick replaces this one; a user message is never dropped.
        this.counters.droppedPrices++;
        continue;
      }
      ws.send(frame);
      this.counters.delivered++;
    }
  }

  private send(ws: WebSocket, frame: ServerFrame): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  }

  private broadcast(frame: ServerFrame): void {
    const text = JSON.stringify(frame);
    for (const ws of this.registry.sockets()) {
      ws.send(text);
    }
  }

  // ---- liveness ----------------------------------------------------------------------------

  private beat(): void {
    for (const [ws, state] of this.states) {
      if (state.missedPongs >= this.options.missedPongsAllowed) {
        this.counters.terminatedIdle++;
        this.release(ws);
        ws.terminate();
        continue;
      }
      state.missedPongs++;
      ws.ping();
    }
  }

  /**
   * A socket with more than `closeAboveBytes` unsent for `closeAfterMs` gets a 1013 close and
   * leaves the registry at once. Its client never reads, so the close frame waits behind its
   * backlog; `ws` destroys the connection if the close doesn't complete in 30 s.
   */
  private checkBackpressure(): void {
    const now = Date.now();
    for (const [ws, state] of this.states) {
      if (state.released) {
        continue;
      }
      if (ws.bufferedAmount <= this.options.closeAboveBytes) {
        state.overSince = undefined;
        continue;
      }
      state.overSince ??= now;
      if (now - state.overSince >= this.options.closeAfterMs) {
        this.counters.closedSlow++;
        this.logger.warn(
          `Closing a socket of user ${state.userId}: ${ws.bufferedAmount} bytes unsent for ${now - state.overSince} ms`,
        );
        this.release(ws);
        ws.close(CLOSE_TRY_AGAIN_LATER, 'Too slow: messages are piling up');
      }
    }
  }

  /** Takes a socket out of the registry, and unbinds its user if it was their last here. */
  private release(ws: WebSocket): void {
    const state = this.states.get(ws);
    if (!state || state.released) {
      return;
    }
    state.released = true;
    if (this.registry.removeSocket(state.userId, ws)) {
      void this.feed.unbindUser(state.userId);
    }
  }
}

/** Answers the upgrade request with a plain HTTP error and closes the connection. */
function refuse(socket: Duplex, status: number): void {
  if (socket.destroyed) {
    return;
  }
  const reason = REASONS[status] ?? 'Error';
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: text/plain\r\n' +
      `Content-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8');
  }
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

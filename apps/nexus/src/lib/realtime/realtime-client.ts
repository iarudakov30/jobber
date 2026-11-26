/**
 * The browser side of the realtime gateway (`apps/realtime`, protocol in its `protocol.ts`): one
 * WebSocket per tab that subscribes to price channels on demand, gets the user's own messages,
 * and keeps itself connected.
 *
 * - **Ref-counted subscriptions.** `subscribe(channel, listener)` sends `subscribe` for the
 *   first listener of a channel and `unsubscribe` after the last one leaves.
 * - **Reconnect.** After a close it reconnects with a backoff from 1 s doubling to 30 s, each
 *   delay randomized (×0.5–1) so a thousand tabs don't come back in the same millisecond. A
 *   gateway shutting down (1012) is reconnected to at once, within a random second.
 * - **Resync.** Every `welcome` (the first connect and every reconnect) and every `resync` from
 *   the gateway fire `onResynced`: messages may have been missed, so whoever shows server data
 *   refetches it. The gateway sends `welcome` only once the user's channel is bound, so a
 *   refetch started then can't miss a later change.
 * - **Order.** A message whose `seq` isn't higher than the last one of its kind is dropped:
 *   per price channel, per asset for balances (the wallet orders those per asset), per order
 *   for fills (a redelivered fill has the same `seq`).
 */

export type ConnectionStatus = 'connecting' | 'open' | 'closed';

export interface RealtimeMessage {
  channel: string;
  seq: number;
  data: unknown;
}

type Listener = (message: RealtimeMessage) => void;

/** The parts of `WebSocket` the client uses, so tests can pass a fake. */
export interface SocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RealtimeClientOptions {
  url: string;
  createSocket?: (url: string) => SocketLike;
  minDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

const OPEN = 1;
/** The gateway is restarting: reconnect at once (to another replica). */
const SERVICE_RESTART = 1012;

export class RealtimeClient {
  private socket?: SocketLike;
  private currentStatus: ConnectionStatus = 'closed';
  private running = false;
  private attempt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly channels = new Map<string, Set<Listener>>();
  private readonly userListeners = new Set<Listener>();
  private readonly statusListeners = new Set<() => void>();
  private readonly resyncListeners = new Set<() => void>();
  private readonly lastSeq = new Map<string, number>();
  private readonly createSocket: (url: string) => SocketLike;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  /** The signed-in user, from the gateway's welcome. */
  userId?: number;

  constructor(private readonly options: RealtimeClientOptions) {
    this.createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
    this.minDelayMs = options.minDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.random = options.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  /** Closes the socket and stops reconnecting (sign-out). */
  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, 'Signed out');
    this.lastSeq.clear();
    this.userId = undefined;
    this.setStatus('closed');
  }

  /** Listens to a public channel (`prices.NXC`); returns the function that stops listening. */
  subscribe(channel: string, listener: Listener): () => void {
    let listeners = this.channels.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.channels.set(channel, listeners);
      this.sendRequest('subscribe', channel);
    }
    listeners.add(listener);
    return () => {
      const current = this.channels.get(channel);
      if (!current?.delete(listener) || current.size > 0) {
        return;
      }
      this.channels.delete(channel);
      this.sendRequest('unsubscribe', channel);
    };
  }

  /** The user's own messages (`balance`, `fill`). */
  onUserMessage(listener: Listener): () => void {
    this.userListeners.add(listener);
    return () => this.userListeners.delete(listener);
  }

  /** After every (re)connect and every `resync`: refetch what may have been missed. */
  onResynced(listener: () => void): () => void {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private connect(): void {
    this.setStatus('connecting');
    const socket = this.createSocket(this.options.url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.socket === socket) {
        this.receive(String(event.data));
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = undefined;
        this.closed(event.code);
      }
    };
    socket.onerror = () => undefined; // a close follows
  }

  private receive(text: string): void {
    let frame: {
      type?: string;
      userId?: number;
      channel?: string;
      seq?: number;
      data?: unknown;
    };
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    switch (frame.type) {
      case 'welcome':
        this.userId = frame.userId;
        this.attempt = 0;
        // Open first: sendRequest only sends while open.
        this.setStatus('open');
        for (const channel of this.channels.keys()) {
          this.sendRequest('subscribe', channel);
        }
        this.emit(this.resyncListeners);
        return;
      case 'resync':
        this.emit(this.resyncListeners);
        return;
      case 'message':
        if (
          typeof frame.channel === 'string' &&
          typeof frame.seq === 'number'
        ) {
          this.deliver({
            channel: frame.channel,
            seq: frame.seq,
            data: frame.data,
          });
        }
        return;
    }
  }

  private deliver(message: RealtimeMessage): void {
    const key = orderKey(message);
    const last = this.lastSeq.get(key);
    if (last !== undefined && message.seq <= last) {
      return;
    }
    this.lastSeq.set(key, message.seq);
    const listeners = message.channel.startsWith('user.')
      ? this.userListeners
      : this.channels.get(message.channel);
    for (const listener of [...(listeners ?? [])]) {
      listener(message);
    }
  }

  private closed(code: number): void {
    this.setStatus('closed');
    if (!this.running) {
      return;
    }
    const delay =
      code === SERVICE_RESTART
        ? this.random() * this.minDelayMs
        : Math.min(this.maxDelayMs, this.minDelayMs * 2 ** this.attempt) *
          (0.5 + this.random() / 2);
    this.attempt++;
    this.timer = setTimeout(() => {
      if (this.running) {
        this.connect();
      }
    }, delay);
  }

  private sendRequest(op: 'subscribe' | 'unsubscribe', channel: string): void {
    // While connecting, the welcome sends every channel's subscribe.
    if (this.currentStatus === 'open' && this.socket?.readyState === OPEN) {
      this.socket.send(JSON.stringify({ op, channel }));
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.emit(this.statusListeners);
    }
  }

  private emit(listeners: Set<() => void>): void {
    for (const listener of [...listeners]) {
      listener();
    }
  }
}

/** What a message is ordered against: its channel, or for user messages its asset or order. */
function orderKey({ channel, data }: RealtimeMessage): string {
  const body = data as { type?: string; asset?: string; orderId?: string };
  if (body?.type === 'balance') {
    return `${channel}:balance:${body.asset}`;
  }
  if (body?.type === 'fill') {
    return `${channel}:fill:${body.orderId}`;
  }
  return channel;
}

/** The gateway's URL through the dev proxy (or the same origin in production). */
export function realtimeUrl(location: Location = window.location): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}/api/realtime`;
}

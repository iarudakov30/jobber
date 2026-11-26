import {
  RealtimeClient,
  type SocketLike,
} from '../lib/realtime/realtime-client';
import { PriceBook, type Realtime } from '../lib/realtime/realtime';

/** A WebSocket the test plays the gateway for. */
export class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closedWith?: number;
  onopen: SocketLike['onopen'] = null;
  onmessage: SocketLike['onmessage'] = null;
  onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    this.readyState = 3;
    this.closedWith = code;
  }

  // ---- the gateway's side ----

  /** Opens and sends the welcome, as the gateway does once the user's channel is bound. */
  welcome(userId = 7): void {
    this.readyState = 1;
    this.onopen?.({});
    this.frame({ type: 'welcome', userId, channels: [`user.${userId}`] });
  }

  frame(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  message(channel: string, seq: number, data: unknown): void {
    this.frame({ type: 'message', channel, seq, data });
  }

  /** The connection drops (1006) or the gateway closes it with `code`. */
  drop(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }

  /** What the client asked for: `[op, channel]` pairs. */
  get requests(): [string, string][] {
    return this.sent.map((s) => {
      const { op, channel } = JSON.parse(s);
      return [op, channel];
    });
  }
}

/** A realtime client on fake sockets, and the sockets it opened (newest last). */
export function fakeRealtime(options: { random?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new RealtimeClient({
    url: 'ws://gateway.test/realtime',
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    random: options.random ?? (() => 0),
  });
  const realtime: Realtime = { client, prices: new PriceBook() };
  return {
    realtime,
    client,
    sockets,
    latest: () => {
      const socket = sockets.at(-1);
      if (!socket) {
        throw new Error('no socket opened yet');
      }
      return socket;
    },
  };
}

/**
 * Who is connected and who listens to what, in this gateway instance: sockets by user (to bind
 * and unbind `user.<id>` in RabbitMQ on a user's first and last socket) and by channel (to pick
 * the sockets a message goes to). Generic over the socket type, so it is tested without sockets.
 */
export class Registry<S> {
  private readonly byUser = new Map<number, Set<S>>();
  private readonly byChannel = new Map<string, Set<S>>();
  private readonly channelsBySocket = new Map<S, Set<string>>();

  /** Adds a socket; true if it is the user's first one here. */
  addSocket(userId: number, socket: S): boolean {
    let sockets = this.byUser.get(userId);
    const first = !sockets;
    if (!sockets) {
      sockets = new Set();
      this.byUser.set(userId, sockets);
    }
    sockets.add(socket);
    this.channelsBySocket.set(socket, new Set());
    return first;
  }

  /** Removes a socket from its user and every channel; true if it was the user's last one. */
  removeSocket(userId: number, socket: S): boolean {
    for (const channel of this.channelsBySocket.get(socket) ?? []) {
      this.leave(socket, channel);
    }
    this.channelsBySocket.delete(socket);
    const sockets = this.byUser.get(userId);
    if (!sockets?.delete(socket)) {
      return false;
    }
    if (sockets.size === 0) {
      this.byUser.delete(userId);
      return true;
    }
    return false;
  }

  /** True if the socket wasn't on the channel yet. */
  join(socket: S, channel: string): boolean {
    const channels = this.channelsBySocket.get(socket);
    if (!channels || channels.has(channel)) {
      return false;
    }
    channels.add(channel);
    let sockets = this.byChannel.get(channel);
    if (!sockets) {
      sockets = new Set();
      this.byChannel.set(channel, sockets);
    }
    sockets.add(socket);
    return true;
  }

  /** True if the socket was on the channel. */
  leave(socket: S, channel: string): boolean {
    if (!this.channelsBySocket.get(socket)?.delete(channel)) {
      return false;
    }
    const sockets = this.byChannel.get(channel);
    sockets?.delete(socket);
    if (sockets?.size === 0) {
      this.byChannel.delete(channel);
    }
    return true;
  }

  subscribers(channel: string): ReadonlySet<S> {
    return this.byChannel.get(channel) ?? EMPTY;
  }

  channelsOf(socket: S): ReadonlySet<string> {
    return this.channelsBySocket.get(socket) ?? EMPTY;
  }

  sockets(): IterableIterator<S> {
    return this.channelsBySocket.keys();
  }

  get counts(): { sockets: number; users: number; channels: number } {
    return {
      sockets: this.channelsBySocket.size,
      users: this.byUser.size,
      channels: this.byChannel.size,
    };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EMPTY: ReadonlySet<any> = new Set();

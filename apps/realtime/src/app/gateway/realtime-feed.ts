import { Injectable, Logger } from '@nestjs/common';
import type { ConsumeMessage } from 'amqplib';
import {
  REALTIME_EXCHANGE,
  RabbitConnection,
  TransientQueue,
  userChannel,
} from '@jobber/rabbitmq';
import { messageFrame, seqOf } from './protocol';

/** Every coin's price channel, bound for the instance's whole life. */
export const PRICES_BINDING = 'prices.*';

export type FeedListener = (channel: string, frame: string) => void;

/**
 * This instance's view of the `realtime` exchange: one exclusive, auto-delete queue (gone with
 * the connection), bound to `prices.*` from the start and to `user.<id>` while that user has a
 * socket here. Each delivery becomes one serialized frame, sent as is to every socket on the
 * channel.
 *
 * After a reconnect the queue is new and the messages published in between are lost: the
 * listeners hear `resync` and tell the clients to refetch.
 */
@Injectable()
export class RealtimeFeed {
  private readonly logger = new Logger(RealtimeFeed.name);
  private readonly queue: TransientQueue;
  private readonly userBindings = new Map<number, Promise<void>>();
  private messageListener?: FeedListener;
  private resyncListener?: () => void;
  private unordered = 0;
  received = 0;

  constructor(connection: RabbitConnection) {
    this.queue = new TransientQueue(connection, {
      exchange: REALTIME_EXCHANGE,
      bindings: [PRICES_BINDING],
      onMessage: (message) => this.deliver(message),
      onReady: ({ reconnected }) => {
        if (reconnected) {
          this.logger.warn(
            'Realtime feed reconnected: messages may have been missed; asking clients to resync',
          );
          this.resyncListener?.();
        }
      },
    });
  }

  get isReady(): boolean {
    return this.queue.isReady;
  }

  get bindings(): string[] {
    return this.queue.bindings;
  }

  onMessage(listener: FeedListener): void {
    this.messageListener = listener;
  }

  onResync(listener: () => void): void {
    this.resyncListener = listener;
  }

  /**
   * Binds `user.<id>` (once, however many sockets ask); resolves when RabbitMQ has the binding,
   * so a welcome sent after it can't miss a message published after it.
   */
  bindUser(userId: number): Promise<void> {
    let bound = this.userBindings.get(userId);
    if (!bound) {
      bound = this.queue.bind(userChannel(userId));
      this.userBindings.set(userId, bound);
    }
    return bound;
  }

  unbindUser(userId: number): Promise<void> {
    this.userBindings.delete(userId);
    return this.queue.unbind(userChannel(userId));
  }

  private deliver(message: ConsumeMessage): void {
    this.received++;
    const channel = message.fields.routingKey;
    let body: unknown;
    try {
      body = JSON.parse(message.content.toString());
    } catch {
      this.dropUnordered(channel, 'not JSON');
      return;
    }
    const seq = seqOf(channel, body, message.properties.messageId);
    if (seq === undefined) {
      this.dropUnordered(channel, 'no seq');
      return;
    }
    this.messageListener?.(channel, messageFrame(channel, seq, body));
  }

  /** A message a client couldn't order is useless to it; logged once in a while. */
  private dropUnordered(channel: string, why: string): void {
    if (this.unordered++ % 1_000 === 0) {
      this.logger.warn(
        `Dropped a message on ${channel} (${why}); ${this.unordered} so far`,
      );
    }
  }
}

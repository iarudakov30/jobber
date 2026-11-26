import { COINS } from '@jobber/money';
import { priceChannel } from '@jobber/rabbitmq';

/**
 * The wire protocol: JSON text frames.
 *
 * Client → gateway:
 *   { "op": "subscribe",   "channel": "prices.NXC" }
 *   { "op": "unsubscribe", "channel": "prices.NXC" }
 *
 * Gateway → client:
 *   { "type": "welcome", "userId": 19, "channels": ["user.19"] }   once, after the upgrade
 *   { "type": "subscribed", "channel": "prices.NXC" }
 *   { "type": "unsubscribed", "channel": "prices.NXC" }
 *   { "type": "message", "channel": "prices.NXC", "seq": 812, "data": { ... } }
 *   { "type": "error", "code": "FORBIDDEN", "message": "...", "channel": "user.7" }
 *   { "type": "resync" }   the gateway lost messages (its RabbitMQ connection dropped): refetch
 *
 * `seq` only increases per channel (prices: the simulator's per-coin counter; user channels: the
 * wallet's outbox id, compared per asset for balances). It may skip numbers, so a gap means
 * nothing; clients drop a message whose `seq` isn't higher than the last one they applied.
 */

/** Every channel a client may subscribe to. Its own `user.<id>` channel is joined for it. */
export const PUBLIC_CHANNELS: ReadonlySet<string> = new Set(
  COINS.map(priceChannel),
);

/** A client message is a few dozen bytes; anything much bigger is not one. */
export const MAX_CLIENT_MESSAGE_BYTES = 1_024;
/** At most this many subscriptions per socket (there are four public channels today). */
export const MAX_SUBSCRIPTIONS = 16;

export type ErrorCode =
  'BAD_REQUEST' | 'FORBIDDEN' | 'UNKNOWN_CHANNEL' | 'TOO_MANY_SUBSCRIPTIONS';

export type ClientRequest = {
  op: 'subscribe' | 'unsubscribe';
  channel: string;
};

export type ServerFrame =
  | { type: 'welcome'; userId: number; channels: string[] }
  | { type: 'subscribed' | 'unsubscribed'; channel: string }
  | { type: 'error'; code: ErrorCode; message: string; channel?: string }
  | { type: 'resync' };

export class ProtocolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly channel?: string,
  ) {
    super(message);
  }

  toFrame(): ServerFrame {
    return {
      type: 'error',
      code: this.code,
      message: this.message,
      ...(this.channel === undefined ? {} : { channel: this.channel }),
    };
  }
}

/**
 * Parses and checks one client frame. Throws `ProtocolError`:
 *
 * - `BAD_REQUEST`: not JSON, not an object, unknown `op`, `channel` not a string;
 * - `FORBIDDEN`: any `user.*` channel, the caller's own included (it is joined automatically,
 *   and nobody may listen to anyone else's);
 * - `UNKNOWN_CHANNEL`: anything else that isn't a public channel.
 */
export function parseClientMessage(raw: string): ClientRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ProtocolError('BAD_REQUEST', 'Messages must be JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProtocolError('BAD_REQUEST', 'A message must be a JSON object');
  }
  const { op, channel } = value as Record<string, unknown>;
  if (op !== 'subscribe' && op !== 'unsubscribe') {
    throw new ProtocolError(
      'BAD_REQUEST',
      'op must be "subscribe" or "unsubscribe"',
    );
  }
  if (typeof channel !== 'string') {
    throw new ProtocolError('BAD_REQUEST', 'channel must be a string');
  }
  if (channel === 'user' || channel.startsWith('user.')) {
    throw new ProtocolError(
      'FORBIDDEN',
      'User channels are joined automatically: each socket gets its own user.<id> and no other',
      channel,
    );
  }
  if (!PUBLIC_CHANNELS.has(channel)) {
    throw new ProtocolError(
      'UNKNOWN_CHANNEL',
      `Unknown channel; one of: ${[...PUBLIC_CHANNELS].join(', ')}`,
      channel,
    );
  }
  return { op, channel };
}

/**
 * The `seq` of a message from RabbitMQ on `channel`, or undefined if it has none (then it isn't
 * forwarded: a client couldn't order it).
 *
 * - prices: the body's `seq`;
 * - user channels: the outbox id in the `messageId` (`outbox-<service>-<id>`).
 */
export function seqOf(
  channel: string,
  body: unknown,
  messageId: string | undefined,
): number | undefined {
  if (channel.startsWith('prices.')) {
    const seq = (body as { seq?: unknown } | null)?.seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0
      ? seq
      : undefined;
  }
  const match = /^outbox-[a-z0-9-]+?-(\d+)$/.exec(messageId ?? '');
  if (!match) {
    return undefined;
  }
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : undefined;
}

/** The frame a channel's subscribers get, serialized once for all of them. */
export function messageFrame(
  channel: string,
  seq: number,
  data: unknown,
): string {
  return JSON.stringify({ type: 'message', channel, seq, data });
}

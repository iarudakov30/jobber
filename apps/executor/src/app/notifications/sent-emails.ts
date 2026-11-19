import Redis from 'ioredis';

export const SENT_EMAILS = 'SENT_EMAILS';

/** Remembers which messages were already emailed, so a redelivery doesn't email twice. */
export interface SentEmails {
  has(messageId: string): Promise<boolean>;
  remember(messageId: string): Promise<void>;
  close?(): Promise<void>;
}

const TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * `email:sent:<messageId>` in Redis for 7 days, checked before sending and set after. A crash
 * between the two can send an email twice; acceptable for an email, never for money. When
 * Redis is down the check throws and the message is retried later rather than sent unchecked.
 */
export class RedisSentEmails implements SentEmails {
  constructor(private readonly redis: Redis) {}

  static connect(url: string): RedisSentEmails {
    return new RedisSentEmails(
      new Redis(url, {
        // Fail at once instead of queueing commands while disconnected.
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      }),
    );
  }

  async has(messageId: string): Promise<boolean> {
    return (await this.redis.exists(key(messageId))) === 1;
  }

  async remember(messageId: string): Promise<void> {
    await this.redis.set(key(messageId), '1', 'EX', TTL_SECONDS);
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

function key(messageId: string): string {
  return `email:sent:${messageId}`;
}

import { RabbitTopology } from './topology';

/**
 * Topic exchange for everything the realtime gateway (`apps/realtime`) pushes to browsers. The
 * routing key is the channel: `prices.<coin>` for the market's ticks, `user.<id>` for one
 * user's events. The gateway binds its own per-instance queue; with no gateway running the
 * exchange drops the messages, which is fine: clients refetch a snapshot when they connect.
 */
export const REALTIME_EXCHANGE = 'realtime';

/** One user's private channel: balance changes and fills. */
export function userChannel(userId: number | string): string {
  return `user.${userId}`;
}

/** A coin's public price channel. */
export function priceChannel(coin: string): string {
  return `prices.${coin}`;
}

/** Declared by every publisher (wallet, market) and by the gateway. */
export function realtimeTopology(): RabbitTopology {
  return { exchanges: [{ name: REALTIME_EXCHANGE, type: 'topic' }] };
}

/**
 * A user's balances in one asset after a posting, on `user.<id>`. Absolute values, not deltas:
 * a client that missed a message is still right after the next one. Amounts are minor-units
 * strings.
 *
 * Order: the wallet writes it in the posting's transaction while holding both of that asset's
 * accounts locked, so for one (user, asset) a later message always has a higher outbox id
 * (the `messageId` is `outbox-wallet-<id>`). Messages for different assets may arrive in any
 * order, so a client compares ids per asset.
 */
export interface RealtimeBalanceMessage {
  type: 'balance';
  asset: string;
  available: string;
  held: string;
}

/** A settled trade, on `user.<id>`, written with the posting that settled it. */
export interface RealtimeFillMessage {
  type: 'fill';
  /** The market's order id (the trade id). */
  orderId: string;
  transactionId: string;
  coin: string;
  side: 'BUY' | 'SELL';
  /** Coin minor units. */
  qty: string;
  /** USD cents before the fee. */
  usdAmount: string;
  /** USD cents. */
  fee: string;
}

export type RealtimeUserMessage = RealtimeBalanceMessage | RealtimeFillMessage;

/** Where a tick's price came from: the walk, or an exchange (phase 4.5). */
export const PRICE_TICK_SOURCES = ['simulator', 'coinbase', 'binance'] as const;
export type PriceTickSource = (typeof PRICE_TICK_SOURCES)[number];

/**
 * A coin's price, once a second on `prices.<coin>` from the market's simulator leader. Sent
 * non-persistent with a 5 s expiration: a stale tick is worth nothing.
 *
 * `seq` comes from a per-coin counter in Redis (`HINCRBY price:<coin> seq 1`), so it keeps
 * increasing when another replica takes over the simulator. Clients drop a tick whose `seq`
 * isn't higher than the one they have.
 */
export interface RealtimePriceMessage {
  type: 'price';
  coin: string;
  /** USD cents per whole coin, as a decimal string. */
  price: string;
  seq: number;
  /** Tick time, epoch milliseconds. */
  at: number;
  /** The simulator for the invented coins; Coinbase or, as the fallback, Binance for real ones. */
  source: PriceTickSource;
}

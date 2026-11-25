import { IsIn, IsInt, IsUUID, Matches, Min } from 'class-validator';

/** Pulsar topic `wallet` publishes to (from its outbox) when it settles a trade. */
export const TRADE_EXECUTED_TOPIC = 'trade-executed';

export const TRADE_SIDES = ['BUY', 'SELL'] as const;
export type TradeSide = (typeof TRADE_SIDES)[number];

const POSITIVE = /^[1-9]\d*$/;
const NON_NEGATIVE = /^(0|[1-9]\d*)$/;

/**
 * A trade was settled: the wallet moved USD and coins between the user and the market maker.
 * Written to the wallet's outbox in the same transaction as the posting, keyed by `userId`, so
 * one user's trades arrive in order. Nothing consumes it yet (phase 5's reconciliation will).
 *
 * Amounts are minor units as decimal strings (`toWire`), never JSON numbers: `qty` in coin units
 * (8 decimals), `usdAmount` and `fee` in cents. `coin` is checked by shape only, not against
 * `COINS`: importing `@jobber/money` would pull bigint code into every user of this library.
 */
export class TradeExecutedMessage {
  /** The market's order id, also the ledger `externalRef`. */
  @IsUUID()
  tradeId: string;

  /** The wallet transaction that settled it. */
  @IsUUID()
  transactionId: string;

  @IsInt()
  @Min(1)
  userId: number;

  @Matches(/^[A-Z]{2,10}$/, { message: 'coin must be an asset code' })
  coin: string;

  @IsIn(TRADE_SIDES)
  side: TradeSide;

  @Matches(POSITIVE, { message: 'qty must be a positive integer string' })
  qty: string;

  @Matches(POSITIVE, {
    message: 'usdAmount must be a positive integer string',
  })
  usdAmount: string;

  @Matches(NON_NEGATIVE, {
    message: 'fee must be a non-negative integer string',
  })
  fee: string;
}

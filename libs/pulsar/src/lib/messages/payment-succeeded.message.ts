import { IsIn, IsInt, IsUUID, Matches, Min } from 'class-validator';

/** Pulsar topic `payments` publishes to (from its outbox) when Stripe confirms a top-up. */
export const PAYMENT_SUCCEEDED_TOPIC = 'payment-succeeded';

/**
 * Currencies a top-up can be paid in. Kept here instead of importing `ASSETS` from `@jobber/money`:
 * that would pull bigint code into every project that uses this library.
 */
export const PAYMENT_CURRENCIES = ['USD'] as const;

/**
 * A top-up was paid. Published by `payments` in the same transaction that marks the payment
 * SUCCEEDED, keyed by `userId` (so a Key_Shared consumer handles one user's messages in order).
 * The wallet credits `amount` from `stripe_clearing` with `externalRef = paymentId`, so a
 * redelivered message credits once.
 */
export class PaymentSucceededMessage {
  @IsUUID()
  paymentId: string;

  @IsInt()
  @Min(1)
  userId: number;

  /** Minor units as a decimal string (`toWire`), never a JSON number: `"5000"` is $50.00. */
  @Matches(/^[1-9]\d*$/, {
    message: 'amount must be a positive integer string',
  })
  amount: string;

  @IsIn(PAYMENT_CURRENCIES)
  currency: string;
}

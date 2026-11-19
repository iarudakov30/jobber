import { Injectable } from '@nestjs/common';
import { fromWire } from '@jobber/money';
import { OutboxRelay } from '@jobber/outbox';
import {
  MessageMeta,
  NonRetryableError,
  PAYMENT_SUCCEEDED_TOPIC,
  PaymentSucceededMessage,
  PulsarClient,
  PulsarConsumer,
  validateMessage,
} from '@jobber/pulsar';
import {
  EMAIL_TOPUP,
  NOTIFICATIONS_EXCHANGE,
  TopUpEmailMessage,
} from '@jobber/rabbitmq';
import { InvalidPostingError } from '../ledger/ledger.errors';
import { LedgerService } from '../ledger/ledger.service';

/** The wallet's own subscription: it gets every `payment-succeeded`, whoever else listens. */
export const WALLET_SUBSCRIPTION = 'wallet';
/** Where top-ups come from: a system account that goes negative by what Stripe owes us. */
export const STRIPE_CLEARING = 'stripe_clearing';

/**
 * Test hook (acceptance test 7): with `FAULT_CRASH_AFTER_CREDIT=1` the process exits right
 * after the credit commits and before the message is acknowledged, so Pulsar redelivers it.
 * Ignored in production.
 */
function crashAfterCredit(): boolean {
  return (
    process.env['NODE_ENV'] !== 'production' &&
    process.env['FAULT_CRASH_AFTER_CREDIT'] === '1'
  );
}

/**
 * Credits paid top-ups. One posting `stripe_clearing −X / user +X` with
 * `externalRef = paymentId`, and the `email.topup` notification in the same transaction: a
 * redelivered message hits `UNIQUE (type, external_ref)`, writes nothing and sends no second
 * email. Key_Shared on the `userId` key keeps one user's top-ups in order across replicas.
 */
@Injectable()
export class PaymentSucceededConsumer extends PulsarConsumer<PaymentSucceededMessage> {
  constructor(
    pulsarClient: PulsarClient,
    private readonly ledger: LedgerService,
    private readonly relay: OutboxRelay,
  ) {
    super(pulsarClient, PAYMENT_SUCCEEDED_TOPIC, {
      subscription: WALLET_SUBSCRIPTION,
      subscriptionType: 'KeyShared',
    });
  }

  /** Public for tests: what one delivery does. */
  async credit(data: unknown): Promise<{ duplicate: boolean }> {
    const message = await validateMessage(PaymentSucceededMessage, data);
    const amount = fromWire(message.amount);
    const [clearing, user] = await Promise.all([
      this.ledger.ensureSystemAccount(STRIPE_CLEARING, message.currency),
      this.ledger.ensureAccounts(message.userId, message.currency),
    ]);
    const email: TopUpEmailMessage = {
      userId: message.userId,
      paymentId: message.paymentId,
      amount: message.amount,
      currency: message.currency,
    };
    try {
      const { duplicate, transactionId } = await this.ledger.post({
        type: 'topup',
        externalRef: message.paymentId,
        legs: [
          { accountId: clearing, asset: message.currency, amount: -amount },
          { accountId: user.available, asset: message.currency, amount },
        ],
        metadata: { paymentId: message.paymentId, toUserId: message.userId },
        outbox: () => [
          {
            transport: 'rabbitmq',
            destination: NOTIFICATIONS_EXCHANGE,
            key: EMAIL_TOPUP,
            payload: email,
          },
        ],
      });
      this.logger.log(
        `Top-up ${message.paymentId}: ${duplicate ? 'already credited' : `credited (transaction ${transactionId})`}`,
      );
      if (!duplicate) {
        this.relay.poke();
      }
      return { duplicate };
    } catch (error) {
      if (error instanceof InvalidPostingError) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }

  protected async onMessage(
    data: PaymentSucceededMessage,
    meta: MessageMeta,
  ): Promise<void> {
    await this.credit(data);
    if (crashAfterCredit()) {
      this.logger.warn(
        `FAULT_CRASH_AFTER_CREDIT: exiting before acking ${meta.messageId}`,
      );
      process.exit(1);
    }
  }
}

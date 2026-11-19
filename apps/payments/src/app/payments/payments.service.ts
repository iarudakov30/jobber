import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import Stripe from 'stripe';
import { User } from '@jobber/grpc';
import { formatAmount, toWire } from '@jobber/money';
import { DrizzleOutboxStore, OutboxRelay } from '@jobber/outbox';
import {
  PAYMENT_SUCCEEDED_TOPIC,
  PaymentSucceededMessage,
} from '@jobber/pulsar';
import { NonRetryableError } from '@jobber/rabbitmq';
import {
  DATABASE_CONNECTION,
  PaymentsDatabase,
  PaymentsTx,
} from '../database/database';
import { PaymentProviderError, PaymentsInputError } from './payments.errors';
import {
  MAX_TOP_UP,
  MIN_TOP_UP,
  PaymentStatus,
  payments,
  reconIssues,
  stripeEvents,
} from './schema';
import { STRIPE_CLIENT } from './stripe.client';
import { DELAY_BUCKETS, PAYMENT_EXPIRE } from './topology';

type Payment = typeof payments.$inferSelect;

/** At most USD 2,000 per user in any rolling 24 hours, counting PENDING and SUCCEEDED. */
export const DAILY_TOP_UP_LIMIT = 200_000n;
const CURRENCY = 'USD';
/** First key of `pg_advisory_xact_lock(key1, userId)`: serialises one user's top-ups. */
const TOP_UP_LOCK = 3005;
/**
 * Stripe refuses an `expires_at` less than 30 minutes after it creates the session, and our
 * clock started before the request did. The `payment.expire` command (30 min) expires the
 * session first anyway.
 */
const SESSION_LIFETIME_S = 31 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ExpireOutcome =
  'expired' | 'succeeded' | 'already-final' | 'awaiting-payment';

@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly appUrl: string;
  private readonly expiryBucket: string;

  constructor(
    @Inject(DATABASE_CONNECTION) private readonly db: PaymentsDatabase,
    @Inject(STRIPE_CLIENT) private readonly stripe: Stripe,
    private readonly outbox: DrizzleOutboxStore,
    private readonly relay: OutboxRelay,
    configService: ConfigService,
  ) {
    this.appUrl = configService.getOrThrow<string>('APP_URL');
    this.expiryBucket = configService.get('PAYMENT_EXPIRY_BUCKET', 'delay.30m');
  }

  onModuleInit(): void {
    // A typo here would park every expiry command on an exchange that doesn't exist.
    if (!DELAY_BUCKETS.some((b) => b.name === this.expiryBucket)) {
      throw new Error(
        `PAYMENT_EXPIRY_BUCKET must be one of ${DELAY_BUCKETS.map((b) => b.name).join(', ')}`,
      );
    }
  }

  /**
   * Starts a top-up: a PENDING payment and its expiry command in one transaction, then the
   * Stripe Checkout session outside any transaction (a network call must never hold row
   * locks), then the session id.
   */
  async createTopUp(
    user: User,
    amount: bigint,
  ): Promise<{ paymentId: string; checkoutUrl: string }> {
    if (
      typeof amount !== 'bigint' ||
      amount < MIN_TOP_UP ||
      amount > MAX_TOP_UP
    ) {
      throw new PaymentsInputError(
        `amount must be between ${usd(MIN_TOP_UP)} and ${usd(MAX_TOP_UP)}`,
      );
    }

    const payment = await this.db.transaction(async (tx) => {
      // Two top-ups by one user at once would both pass the limit check without this.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${TOP_UP_LOCK}, ${user.id})`,
      );
      const [{ total }] = await tx
        .select({
          total: sql<string>`coalesce(sum(${payments.amount}), 0)::text`,
        })
        .from(payments)
        .where(
          and(
            eq(payments.userId, user.id),
            inArray(payments.status, ['PENDING', 'SUCCEEDED']),
            gt(payments.createdAt, sql`now() - interval '24 hours'`),
          ),
        );
      const left = DAILY_TOP_UP_LIMIT - BigInt(total);
      if (amount > left) {
        throw new PaymentsInputError(
          `amount is over your limit of ${usd(DAILY_TOP_UP_LIMIT)} per 24 hours: ` +
            `${usd(left > 0n ? left : 0n)} left`,
        );
      }
      const [row] = await tx
        .insert(payments)
        .values({ userId: user.id, amount, currency: CURRENCY })
        .returning();
      await this.outbox.enqueue(tx, [
        {
          transport: 'rabbitmq',
          destination: this.expiryBucket,
          key: PAYMENT_EXPIRE,
          payload: { paymentId: row.id },
        },
      ]);
      return row;
    });
    this.relay.poke();

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.create(
        {
          mode: 'payment',
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: CURRENCY.toLowerCase(),
                unit_amount: Number(amount), // ≤ 100,000: exact as a JS number
                product_data: { name: 'NexusPay wallet top-up' },
              },
            },
          ],
          metadata: { paymentId: payment.id, userId: String(user.id) },
          payment_intent_data: {
            metadata: { paymentId: payment.id, userId: String(user.id) },
          },
          client_reference_id: payment.id,
          expires_at: Math.floor(Date.now() / 1000) + SESSION_LIFETIME_S,
          success_url: `${this.appUrl}/wallet?topup=${payment.id}`,
          cancel_url: `${this.appUrl}/topup`,
        },
        // A retry of this call (by the SDK or by us) gets the same session back.
        { idempotencyKey: `checkout-session:${payment.id}` },
      );
    } catch (error) {
      this.logger.error(
        `Stripe refused the Checkout session for payment ${payment.id}: ${errorText(error)}`,
      );
      await this.db
        .update(payments)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(
          and(eq(payments.id, payment.id), eq(payments.status, 'PENDING')),
        );
      throw new PaymentProviderError(
        'Stripe is not available right now; try again in a minute',
      );
    }

    await this.db
      .update(payments)
      .set({ stripeSessionId: session.id, updatedAt: new Date() })
      .where(and(eq(payments.id, payment.id), eq(payments.status, 'PENDING')));
    if (!session.url) {
      throw new PaymentProviderError('Stripe returned no Checkout URL');
    }
    return { paymentId: payment.id, checkoutUrl: session.url };
  }

  /** The user's payment, or null when it doesn't exist or belongs to someone else. */
  async payment(userId: number, id: string): Promise<Payment | null> {
    if (!UUID.test(id)) {
      throw new PaymentsInputError('id must be a payment id (a UUID)');
    }
    const [row] = await this.db
      .select()
      .from(payments)
      .where(and(eq(payments.id, id), eq(payments.userId, userId)));
    return row ?? null;
  }

  /** The user's payments, newest first. */
  list(userId: number, first: number): Promise<Payment[]> {
    if (!Number.isInteger(first) || first < 1 || first > 100) {
      throw new PaymentsInputError('first must be between 1 and 100');
    }
    return this.db
      .select()
      .from(payments)
      .where(eq(payments.userId, userId))
      .orderBy(desc(payments.createdAt), desc(payments.id))
      .limit(first);
  }

  /**
   * Applies one verified Stripe webhook event, once. The event id is stored in the same
   * transaction as its effect, so a redelivery or `stripe events resend` finds it and stops.
   */
  async applyStripeEvent(
    event: Stripe.Event,
  ): Promise<'applied' | 'duplicate'> {
    let published = false;
    const outcome = await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(stripeEvents)
        .values({ eventId: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ eventId: stripeEvents.eventId });
      if (!inserted.length) {
        return 'duplicate' as const;
      }

      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded': {
          const session = event.data.object;
          if (session.payment_status === 'paid') {
            published = await this.settlePaid(tx, session, event.id);
          }
          break;
        }
        case 'checkout.session.expired': {
          const paymentId = paymentIdOf(event.data.object);
          if (paymentId) {
            await this.markExpired(tx, paymentId);
          }
          break;
        }
        // Anything else is stored and otherwise ignored.
      }
      return 'applied' as const;
    });
    if (published) {
      this.relay.poke();
    }
    return outcome;
  }

  /**
   * The `payment.expire` command. Asks Stripe to expire the session first: once Stripe says
   * it's expired, nobody can pay it any more, so EXPIRED is safe. If the session was paid at
   * the last second, Stripe refuses, and the session (fetched from Stripe, which is the truth)
   * settles the payment here instead; the `completed` webhook then finds it done. Throws to
   * retry when Stripe can't be reached.
   */
  async expire(paymentId: string): Promise<ExpireOutcome> {
    const [payment] = await this.db
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId));
    if (!payment) {
      throw new NonRetryableError(`No payment ${paymentId}`);
    }
    if (payment.status !== 'PENDING') {
      return 'already-final';
    }
    if (!payment.stripeSessionId) {
      // The request died before Stripe answered or before the session id was stored. Nobody
      // received a Checkout URL, so nobody can pay it.
      await this.markExpired(this.db, paymentId);
      return 'expired';
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await this.stripe.checkout.sessions.expire(
        payment.stripeSessionId,
      );
    } catch (error) {
      if (stripeErrorType(error) !== 'StripeInvalidRequestError') {
        throw error;
      }
      // "Only Checkout Sessions with a status of `open` can be expired": see what it is.
      session = await this.stripe.checkout.sessions.retrieve(
        payment.stripeSessionId,
      );
    }

    if (session.status === 'expired') {
      await this.markExpired(this.db, paymentId);
      return 'expired';
    }
    if (session.status === 'complete' && session.payment_status === 'paid') {
      const published = await this.db.transaction((tx) =>
        this.settlePaid(tx, session, null),
      );
      if (published) {
        this.relay.poke();
      }
      return 'succeeded';
    }
    if (session.status === 'complete') {
      // Paid by a delayed method (bank debit): `async_payment_succeeded` settles it later.
      return 'awaiting-payment';
    }
    throw new Error(
      `Session ${session.id} is still ${session.status} after expiring it`,
    );
  }

  /**
   * PENDING → SUCCEEDED plus the `payment-succeeded` event, in the caller's transaction.
   * Anything that doesn't add up (unknown payment, already expired, another amount) becomes a
   * recon issue instead, and no money moves. Returns whether an event was queued.
   */
  private async settlePaid(
    tx: PaymentsTx,
    session: Stripe.Checkout.Session,
    eventId: string | null,
  ): Promise<boolean> {
    const paymentId = paymentIdOf(session);
    if (!paymentId) {
      // Not one of ours, e.g. a fixture from `stripe trigger`.
      this.logger.warn(`Ignoring Checkout session ${session.id}: no paymentId`);
      return false;
    }
    const [payment] = await tx
      .select()
      .from(payments)
      .where(eq(payments.id, paymentId))
      .for('update');

    if (payment?.status === 'SUCCEEDED') {
      return false; // settled already, by the webhook or by the expiry command
    }
    const problem = !payment
      ? 'unknown_payment'
      : payment.status !== 'PENDING'
        ? `paid_after_${payment.status.toLowerCase()}`
        : BigInt(session.amount_total ?? -1) !== payment.amount ||
            session.currency?.toUpperCase() !== payment.currency
          ? 'amount_mismatch'
          : payment.stripeSessionId && payment.stripeSessionId !== session.id
            ? 'session_mismatch'
            : null;

    if (problem || !payment) {
      await tx.insert(reconIssues).values({
        kind: problem ?? 'unknown_payment',
        paymentId: payment ? paymentId : null,
        stripeEventId: eventId,
        stripeSessionId: session.id,
        details: {
          paymentStatus: payment?.status ?? null,
          expected: payment
            ? { amount: toWire(payment.amount), currency: payment.currency }
            : null,
          paid: { amount: session.amount_total, currency: session.currency },
        },
      });
      this.logger.error(
        `Recon issue ${problem} for payment ${paymentId} (session ${session.id})`,
      );
      return false;
    }
    const updated = await tx
      .update(payments)
      .set({
        status: 'SUCCEEDED',
        stripeSessionId: session.id,
        updatedAt: new Date(),
      })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')))
      .returning({ id: payments.id });
    if (!updated.length) {
      return false;
    }
    const message: PaymentSucceededMessage = {
      paymentId,
      userId: payment.userId,
      amount: toWire(payment.amount),
      currency: payment.currency,
    };
    await this.outbox.enqueue(tx, [
      {
        transport: 'pulsar',
        destination: PAYMENT_SUCCEEDED_TOPIC,
        key: String(payment.userId),
        payload: message,
      },
    ]);
    this.logger.log(`Payment ${paymentId} succeeded`);
    return true;
  }

  private async markExpired(
    db: PaymentsDatabase | PaymentsTx,
    paymentId: string,
  ): Promise<void> {
    await db
      .update(payments)
      .set({ status: 'EXPIRED' satisfies PaymentStatus, updatedAt: new Date() })
      .where(and(eq(payments.id, paymentId), eq(payments.status, 'PENDING')));
  }
}

/** Our payment id from a Checkout session we created; null for anyone else's. */
function paymentIdOf(session: Stripe.Checkout.Session): string | null {
  const id = session.metadata?.['paymentId'] ?? session.client_reference_id;
  return id && UUID.test(id) ? id : null;
}

function stripeErrorType(error: unknown): string | undefined {
  return (error as { type?: string } | null)?.type;
}

function usd(minor: bigint): string {
  return formatAmount(minor, 'USD');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

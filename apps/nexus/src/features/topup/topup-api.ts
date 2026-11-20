import { graphql } from '../../gql/payments';
import type {
  CreateTopUpMutation,
  PaymentQuery,
} from '../../gql/payments/graphql';
import { paymentsClient } from '../../lib/graphql';

export type TopUp = CreateTopUpMutation['createTopUp'];
export type Payment = NonNullable<PaymentQuery['payment']>;

const CREATE_TOP_UP = graphql(`
  mutation CreateTopUp($input: CreateTopUpInput!) {
    createTopUp(input: $input) {
      paymentId
      checkoutUrl
    }
  }
`);

const PAYMENT = graphql(`
  query Payment($id: ID!) {
    payment(id: $id) {
      id
      amount
      currency
      status
    }
  }
`);

export const topUpKeys = {
  payment: (id: string) => ['payments', 'payment', id] as const,
  /** Not under `walletKeys.all`: refreshing the wallet after the credit must not refetch it. */
  credit: (id: string) => ['payments', 'credit', id] as const,
};

/**
 * Starts a top-up and returns the Stripe Checkout page to send the browser to. The same
 * `idempotencyKey` and amount (a retry after a timeout) return the first top-up, not a second.
 */
export async function createTopUp(
  amount: string,
  idempotencyKey: string,
): Promise<TopUp> {
  const { createTopUp } = await paymentsClient.request(
    CREATE_TOP_UP,
    { input: { amount } },
    { 'Idempotency-Key': idempotencyKey },
  );
  return createTopUp;
}

/** One of the signed-in user's payments, or null if there is none with that id. */
export async function fetchPayment(id: string): Promise<Payment | null> {
  return (await paymentsClient.request(PAYMENT, { id })).payment ?? null;
}

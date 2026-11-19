import { GraphQLError } from 'graphql';

/**
 * A request the caller can fix. Messages start with the input field they're about ("amount
 * must be …"), so the React form puts them on that field.
 */
export class PaymentsInputError extends Error {
  override readonly name = 'PaymentsInputError';
}

/** Stripe refused or didn't answer when creating the Checkout session. */
export class PaymentProviderError extends Error {
  override readonly name = 'PaymentProviderError';
}

/** Runs `fn`, reporting the caller's mistakes as `BAD_USER_INPUT` and Stripe outages plainly. */
export async function asGraphQL<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof PaymentsInputError) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (error instanceof PaymentProviderError) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' },
      });
    }
    throw error;
  }
}

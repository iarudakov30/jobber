import { GraphQLError } from 'graphql';

/**
 * A request the caller can fix. Messages start with the input field they're about ("qty must
 * be …"), so the React form puts them on that field.
 */
export class MarketInputError extends Error {
  override readonly name = 'MarketInputError';
}

/** No recent price for the coin: no replica has been leading the simulator. */
export class PricesUnavailableError extends Error {
  override readonly name = 'PricesUnavailableError';
}

/** Runs `fn`, reporting the caller's mistakes as `BAD_USER_INPUT`. */
export async function asGraphQL<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof MarketInputError) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'BAD_USER_INPUT' },
      });
    }
    if (error instanceof PricesUnavailableError) {
      throw new GraphQLError(error.message, {
        extensions: { code: 'PRICES_UNAVAILABLE' },
      });
    }
    throw error;
  }
}

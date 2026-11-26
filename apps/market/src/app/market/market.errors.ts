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

/** The quote was used, expired after 10 s, or was never this user's: ask for a new one. */
export class QuoteExpiredError extends Error {
  override readonly name = 'QuoteExpiredError';
}

/** Only an open order can be cancelled; this one was filled, expired, rejected, or isn't open yet. */
export class OrderNotOpenError extends Error {
  override readonly name = 'OrderNotOpenError';
}

const CODES = new Map<string, string>([
  ['MarketInputError', 'BAD_USER_INPUT'],
  ['PricesUnavailableError', 'PRICES_UNAVAILABLE'],
  ['QuoteExpiredError', 'QUOTE_EXPIRED'],
  ['OrderNotOpenError', 'ORDER_NOT_OPEN'],
]);

/** Runs `fn`, reporting the caller's mistakes with their GraphQL error codes. */
export async function asGraphQL<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = error instanceof Error ? CODES.get(error.name) : undefined;
    if (code) {
      throw new GraphQLError((error as Error).message, {
        extensions: { code },
      });
    }
    throw error;
  }
}

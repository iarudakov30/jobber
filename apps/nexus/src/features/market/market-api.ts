import { graphql } from '../../gql/market';
import type {
  CandlesQuery,
  CoinsQuery,
  OrderFieldsFragment,
  OrderStatus,
  PlaceOrderInput,
  QuoteMutation,
} from '../../gql/market/graphql';
import { graphqlClient } from '../../lib/graphql';

export const marketClient = graphqlClient('/api/market');

export type MarketCoin = CoinsQuery['coins'][number];
export type CandleRow = CandlesQuery['candles'][number];
export type Quote = QuoteMutation['quote'];
export type Order = OrderFieldsFragment;
export type { OrderStatus, PlaceOrderInput };

const COINS = graphql(`
  query Coins {
    coins {
      code
      name
      tick {
        price
        seq
        at
      }
      open24h
    }
  }
`);

const CANDLES = graphql(`
  query Candles($coin: String!) {
    candles(coin: $coin) {
      start
      open
      high
      low
      close
    }
  }
`);

const QUOTE = graphql(`
  mutation Quote($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {
    quote(coin: $coin, side: $side, qty: $qty) {
      id
      coin
      side
      qty
      price
      usdAmount
      fee
      total
      expiresAt
    }
  }
`);

graphql(`
  fragment OrderFields on Order {
    id
    type
    coin
    side
    qty
    limitPrice
    fillPrice
    usdAmount
    fee
    total
    status
    reason
    expiresAt
    createdAt
  }
`);

const PLACE_ORDER = graphql(`
  mutation PlaceOrder($input: PlaceOrderInput!) {
    placeOrder(input: $input) {
      ...OrderFields
    }
  }
`);

const CANCEL_ORDER = graphql(`
  mutation CancelOrder($id: ID!) {
    cancelOrder(id: $id) {
      ...OrderFields
    }
  }
`);

const ORDERS = graphql(`
  query Orders($status: [OrderStatus!], $first: Int) {
    orders(status: $status, first: $first) {
      ...OrderFields
    }
  }
`);

/** Query keys: a fill invalidates `marketKeys.orders`. */
export const marketKeys = {
  coins: ['market', 'coins'] as const,
  candles: (coin: string) => ['market', 'candles', coin] as const,
  orders: ['market', 'orders'] as const,
};

export async function fetchCoins(): Promise<MarketCoin[]> {
  return (await marketClient.request(COINS)).coins;
}

/** The last 24 hours of 1-minute candles, oldest first. */
export async function fetchCandles(coin: string): Promise<CandleRow[]> {
  return (await marketClient.request(CANDLES, { coin })).candles;
}

export async function requestQuote(
  coin: string,
  side: 'BUY' | 'SELL',
  qty: string,
): Promise<Quote> {
  return (await marketClient.request(QUOTE, { coin, side, qty })).quote;
}

/**
 * Places an order. `idempotencyKey` identifies this order: a retry with the same key (after a
 * timeout) returns the first order instead of placing a second.
 */
export async function placeOrder(
  input: PlaceOrderInput,
  idempotencyKey: string,
): Promise<Order> {
  return (
    await marketClient.request(
      PLACE_ORDER,
      { input },
      { 'Idempotency-Key': idempotencyKey },
    )
  ).placeOrder;
}

export async function cancelOrder(id: string): Promise<Order> {
  return (await marketClient.request(CANCEL_ORDER, { id })).cancelOrder;
}

export async function fetchOrders(): Promise<Order[]> {
  return (await marketClient.request(ORDERS, { first: 50 })).orders;
}

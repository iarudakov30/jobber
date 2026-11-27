/* eslint-disable */
import * as types from './graphql';
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';

/**
 * Map of all GraphQL operations in the project.
 *
 * This map has several performance disadvantages:
 * 1. It is not tree-shakeable, so it will include all operations in the project.
 * 2. It is not minifiable, so the string of a GraphQL query will be multiple times inside the bundle.
 * 3. It does not support dead code elimination, so it will add unused operations.
 *
 * Therefore it is highly recommended to use the babel or swc plugin for production.
 * Learn more about it here: https://the-guild.dev/graphql/codegen/plugins/presets/preset-client#reducing-bundle-size
 */
type Documents = {
    "\n  query Coins {\n    coins {\n      code\n      name\n      live\n      providers\n      tick {\n        price\n        seq\n        at\n        source\n      }\n      open24h\n    }\n  }\n": typeof types.CoinsDocument,
    "\n  query Candles($coin: String!) {\n    candles(coin: $coin) {\n      start\n      open\n      high\n      low\n      close\n    }\n  }\n": typeof types.CandlesDocument,
    "\n  mutation Quote($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {\n    quote(coin: $coin, side: $side, qty: $qty) {\n      id\n      coin\n      side\n      qty\n      price\n      usdAmount\n      fee\n      total\n      expiresAt\n    }\n  }\n": typeof types.QuoteDocument,
    "\n  fragment OrderFields on Order {\n    id\n    type\n    coin\n    side\n    qty\n    limitPrice\n    fillPrice\n    usdAmount\n    fee\n    total\n    status\n    reason\n    expiresAt\n    createdAt\n  }\n": typeof types.OrderFieldsFragmentDoc,
    "\n  mutation PlaceOrder($input: PlaceOrderInput!) {\n    placeOrder(input: $input) {\n      ...OrderFields\n    }\n  }\n": typeof types.PlaceOrderDocument,
    "\n  mutation CancelOrder($id: ID!) {\n    cancelOrder(id: $id) {\n      ...OrderFields\n    }\n  }\n": typeof types.CancelOrderDocument,
    "\n  query Orders($status: [OrderStatus!], $first: Int) {\n    orders(status: $status, first: $first) {\n      ...OrderFields\n    }\n  }\n": typeof types.OrdersDocument,
};
const documents: Documents = {
    "\n  query Coins {\n    coins {\n      code\n      name\n      live\n      providers\n      tick {\n        price\n        seq\n        at\n        source\n      }\n      open24h\n    }\n  }\n": types.CoinsDocument,
    "\n  query Candles($coin: String!) {\n    candles(coin: $coin) {\n      start\n      open\n      high\n      low\n      close\n    }\n  }\n": types.CandlesDocument,
    "\n  mutation Quote($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {\n    quote(coin: $coin, side: $side, qty: $qty) {\n      id\n      coin\n      side\n      qty\n      price\n      usdAmount\n      fee\n      total\n      expiresAt\n    }\n  }\n": types.QuoteDocument,
    "\n  fragment OrderFields on Order {\n    id\n    type\n    coin\n    side\n    qty\n    limitPrice\n    fillPrice\n    usdAmount\n    fee\n    total\n    status\n    reason\n    expiresAt\n    createdAt\n  }\n": types.OrderFieldsFragmentDoc,
    "\n  mutation PlaceOrder($input: PlaceOrderInput!) {\n    placeOrder(input: $input) {\n      ...OrderFields\n    }\n  }\n": types.PlaceOrderDocument,
    "\n  mutation CancelOrder($id: ID!) {\n    cancelOrder(id: $id) {\n      ...OrderFields\n    }\n  }\n": types.CancelOrderDocument,
    "\n  query Orders($status: [OrderStatus!], $first: Int) {\n    orders(status: $status, first: $first) {\n      ...OrderFields\n    }\n  }\n": types.OrdersDocument,
};

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 *
 *
 * @example
 * ```ts
 * const query = graphql(`query GetUser($id: ID!) { user(id: $id) { name } }`);
 * ```
 *
 * The query argument is unknown!
 * Please regenerate the types.
 */
export function graphql(source: string): unknown;

/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Coins {\n    coins {\n      code\n      name\n      live\n      providers\n      tick {\n        price\n        seq\n        at\n        source\n      }\n      open24h\n    }\n  }\n"): (typeof documents)["\n  query Coins {\n    coins {\n      code\n      name\n      live\n      providers\n      tick {\n        price\n        seq\n        at\n        source\n      }\n      open24h\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Candles($coin: String!) {\n    candles(coin: $coin) {\n      start\n      open\n      high\n      low\n      close\n    }\n  }\n"): (typeof documents)["\n  query Candles($coin: String!) {\n    candles(coin: $coin) {\n      start\n      open\n      high\n      low\n      close\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Quote($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {\n    quote(coin: $coin, side: $side, qty: $qty) {\n      id\n      coin\n      side\n      qty\n      price\n      usdAmount\n      fee\n      total\n      expiresAt\n    }\n  }\n"): (typeof documents)["\n  mutation Quote($coin: String!, $side: TradeSide!, $qty: MinorUnits!) {\n    quote(coin: $coin, side: $side, qty: $qty) {\n      id\n      coin\n      side\n      qty\n      price\n      usdAmount\n      fee\n      total\n      expiresAt\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  fragment OrderFields on Order {\n    id\n    type\n    coin\n    side\n    qty\n    limitPrice\n    fillPrice\n    usdAmount\n    fee\n    total\n    status\n    reason\n    expiresAt\n    createdAt\n  }\n"): (typeof documents)["\n  fragment OrderFields on Order {\n    id\n    type\n    coin\n    side\n    qty\n    limitPrice\n    fillPrice\n    usdAmount\n    fee\n    total\n    status\n    reason\n    expiresAt\n    createdAt\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation PlaceOrder($input: PlaceOrderInput!) {\n    placeOrder(input: $input) {\n      ...OrderFields\n    }\n  }\n"): (typeof documents)["\n  mutation PlaceOrder($input: PlaceOrderInput!) {\n    placeOrder(input: $input) {\n      ...OrderFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation CancelOrder($id: ID!) {\n    cancelOrder(id: $id) {\n      ...OrderFields\n    }\n  }\n"): (typeof documents)["\n  mutation CancelOrder($id: ID!) {\n    cancelOrder(id: $id) {\n      ...OrderFields\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Orders($status: [OrderStatus!], $first: Int) {\n    orders(status: $status, first: $first) {\n      ...OrderFields\n    }\n  }\n"): (typeof documents)["\n  query Orders($status: [OrderStatus!], $first: Int) {\n    orders(status: $status, first: $first) {\n      ...OrderFields\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;
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
    "\n  query Balances {\n    balances {\n      asset\n      available\n      held\n    }\n  }\n": typeof types.BalancesDocument,
    "\n  query Entries($after: ID, $first: Int) {\n    entries(after: $after, first: $first) {\n      items {\n        id\n        transactionId\n        type\n        asset\n        amount\n        createdAt\n      }\n      nextCursor\n    }\n  }\n": typeof types.EntriesDocument,
    "\n  mutation Transfer($input: TransferInput!) {\n    transfer(input: $input) {\n      transactionId\n      amount\n      asset\n    }\n  }\n": typeof types.TransferDocument,
};
const documents: Documents = {
    "\n  query Balances {\n    balances {\n      asset\n      available\n      held\n    }\n  }\n": types.BalancesDocument,
    "\n  query Entries($after: ID, $first: Int) {\n    entries(after: $after, first: $first) {\n      items {\n        id\n        transactionId\n        type\n        asset\n        amount\n        createdAt\n      }\n      nextCursor\n    }\n  }\n": types.EntriesDocument,
    "\n  mutation Transfer($input: TransferInput!) {\n    transfer(input: $input) {\n      transactionId\n      amount\n      asset\n    }\n  }\n": types.TransferDocument,
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
export function graphql(source: "\n  query Balances {\n    balances {\n      asset\n      available\n      held\n    }\n  }\n"): (typeof documents)["\n  query Balances {\n    balances {\n      asset\n      available\n      held\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  query Entries($after: ID, $first: Int) {\n    entries(after: $after, first: $first) {\n      items {\n        id\n        transactionId\n        type\n        asset\n        amount\n        createdAt\n      }\n      nextCursor\n    }\n  }\n"): (typeof documents)["\n  query Entries($after: ID, $first: Int) {\n    entries(after: $after, first: $first) {\n      items {\n        id\n        transactionId\n        type\n        asset\n        amount\n        createdAt\n      }\n      nextCursor\n    }\n  }\n"];
/**
 * The graphql function is used to parse GraphQL queries into a document that can be used by GraphQL clients.
 */
export function graphql(source: "\n  mutation Transfer($input: TransferInput!) {\n    transfer(input: $input) {\n      transactionId\n      amount\n      asset\n    }\n  }\n"): (typeof documents)["\n  mutation Transfer($input: TransferInput!) {\n    transfer(input: $input) {\n      transactionId\n      amount\n      asset\n    }\n  }\n"];

export function graphql(source: string) {
  return (documents as any)[source] ?? {};
}

export type DocumentType<TDocumentNode extends DocumentNode<any, any>> = TDocumentNode extends DocumentNode<  infer TType,  any>  ? TType  : never;
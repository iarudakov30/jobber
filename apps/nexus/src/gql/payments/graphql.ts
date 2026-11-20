/* eslint-disable */
/** Internal type. DO NOT USE DIRECTLY. */
type Exact<T extends { [key: string]: unknown }> = { [K in keyof T]: T[K] };
/** Internal type. DO NOT USE DIRECTLY. */
export type Incremental<T> = T | { [P in keyof T]?: P extends ' $fragmentName' | '__typename' ? T[P] : never };
import type { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core';
export type CreateTopUpInput = {
  /** USD minor units, "100" to "100000" ($1.00 to $1,000.00). */
  amount: string;
};

/** PENDING until Stripe reports the outcome; then SUCCEEDED (credited), EXPIRED (not paid in time) or FAILED (Checkout could not be started). */
export type PaymentStatus =
  | 'EXPIRED'
  | 'FAILED'
  | 'PENDING'
  | 'SUCCEEDED';

export type CreateTopUpMutationVariables = Exact<{
  input: CreateTopUpInput;
}>;


export type CreateTopUpMutation = { createTopUp: { paymentId: string, checkoutUrl: string } };

export type PaymentQueryVariables = Exact<{
  id: string | number;
}>;


export type PaymentQuery = { payment: { id: string, amount: string, currency: string, status: PaymentStatus } | null };


export const CreateTopUpDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"mutation","name":{"kind":"Name","value":"CreateTopUp"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"input"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"CreateTopUpInput"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"createTopUp"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"input"},"value":{"kind":"Variable","name":{"kind":"Name","value":"input"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"paymentId"}},{"kind":"Field","name":{"kind":"Name","value":"checkoutUrl"}}]}}]}}]} as unknown as DocumentNode<CreateTopUpMutation, CreateTopUpMutationVariables>;
export const PaymentDocument = {"kind":"Document","definitions":[{"kind":"OperationDefinition","operation":"query","name":{"kind":"Name","value":"Payment"},"variableDefinitions":[{"kind":"VariableDefinition","variable":{"kind":"Variable","name":{"kind":"Name","value":"id"}},"type":{"kind":"NonNullType","type":{"kind":"NamedType","name":{"kind":"Name","value":"ID"}}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"payment"},"arguments":[{"kind":"Argument","name":{"kind":"Name","value":"id"},"value":{"kind":"Variable","name":{"kind":"Name","value":"id"}}}],"selectionSet":{"kind":"SelectionSet","selections":[{"kind":"Field","name":{"kind":"Name","value":"id"}},{"kind":"Field","name":{"kind":"Name","value":"amount"}},{"kind":"Field","name":{"kind":"Name","value":"currency"}},{"kind":"Field","name":{"kind":"Name","value":"status"}}]}}]}}]} as unknown as DocumentNode<PaymentQuery, PaymentQueryVariables>;
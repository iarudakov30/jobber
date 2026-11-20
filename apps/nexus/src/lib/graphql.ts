import { ClientError, GraphQLClient } from 'graphql-request';

/**
 * A client for one backend's GraphQL endpoint. Paths are relative (`/api/auth`) and proxied by
 * Vite in development; `credentials: 'include'` sends the `Authentication` cookie.
 */
export function graphqlClient(path: string): GraphQLClient {
  return new GraphQLClient(new URL(path, window.location.origin).toString(), {
    credentials: 'include',
  });
}

export const authClient = graphqlClient('/api/auth');
export const walletClient = graphqlClient('/api/wallet');
export const paymentsClient = graphqlClient('/api/payments');

/** The `extensions.code` of a GraphQL error response (`FORBIDDEN`, `CONFLICT`, ...). */
export function graphqlErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ClientError)) {
    return undefined;
  }
  const code = error.response.errors?.[0]?.extensions?.['code'];
  return typeof code === 'string' ? code : undefined;
}

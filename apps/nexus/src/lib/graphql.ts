import { GraphQLClient } from 'graphql-request';

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

import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';

import { graphqlErrorCode } from './graphql';
import { session } from './session';

/**
 * The app's QueryClient. A FORBIDDEN answer means the session cookie is gone or expired
 * (`GqlAuthGuard`), so the remembered user is cleared and `onSignedOut` sends the person to the
 * login page.
 */
export function createQueryClient(onSignedOut: () => void): QueryClient {
  const onError = (error: unknown) => {
    if (graphqlErrorCode(error) === 'FORBIDDEN' && session.get()) {
      session.clear();
      onSignedOut();
    }
  };
  return new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      // A refused session won't fix itself by retrying.
      queries: {
        retry: (count, error) =>
          graphqlErrorCode(error) !== 'FORBIDDEN' && count < 2,
      },
    },
  });
}

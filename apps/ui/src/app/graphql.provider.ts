import { inject } from '@angular/core';
import { Router } from '@angular/router';
import {
  ApolloLink,
  CombinedGraphQLErrors,
  InMemoryCache,
} from '@apollo/client';
import { ErrorLink } from '@apollo/client/link/error';
import { provideNamedApollo } from 'apollo-angular';
import { HttpLink } from 'apollo-angular/http';

import { Session } from './auth/session';

/** Named Apollo client for the `auth` service; the default client talks to `jobs`. */
export const AUTH_CLIENT = 'auth';

// Relative URIs are proxied to the backend by `proxy.conf.json` during `nx serve ui`,
// so the browser sees a single origin and the HttpOnly `Authentication` cookie is sent as-is.
const AUTH_URI = '/api/auth';
const JOBS_URI = '/api/jobs';

export function provideGraphQL() {
  return provideNamedApollo(() => {
    const httpLink = inject(HttpLink);
    const session = inject(Session);
    const router = inject(Router);

    // `GqlAuthGuard` in `jobs` rejects a missing/expired cookie with a FORBIDDEN error.
    const sessionExpiredLink = new ErrorLink(({ error }) => {
      if (
        CombinedGraphQLErrors.is(error) &&
        error.errors.some((e) => e.extensions?.['code'] === 'FORBIDDEN')
      ) {
        session.clear();
        void router.navigate(['/login'], {
          queryParams: { returnUrl: router.url },
        });
      }
    });

    return {
      default: {
        link: ApolloLink.from([
          sessionExpiredLink,
          httpLink.create({ uri: JOBS_URI, withCredentials: true }),
        ]),
        cache: new InMemoryCache(),
      },
      [AUTH_CLIENT]: {
        link: httpLink.create({ uri: AUTH_URI, withCredentials: true }),
        cache: new InMemoryCache(),
      },
    };
  });
}

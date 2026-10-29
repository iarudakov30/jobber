import { Injectable, inject } from '@angular/core';
import { Apollo } from 'apollo-angular';
import { Observable, map, tap } from 'rxjs';

import { AUTH_CLIENT } from '../graphql.provider';
import { requireData } from '../shared/require-data';
import { CREATE_USER, LOGIN } from './auth.graphql';
import { Session } from './session';
import { Credentials, User } from './user.model';

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly auth = inject(Apollo).use(AUTH_CLIENT);
  private readonly session = inject(Session);

  /** Logs in; the `auth` service sets the HttpOnly `Authentication` cookie on the response. */
  login(credentials: Credentials): Observable<User> {
    return this.auth
      .mutate({ mutation: LOGIN, variables: { loginInput: credentials } })
      .pipe(
        requireData(),
        map(({ login }) => login),
        tap((user) => this.session.set(user)),
      );
  }

  register(credentials: Credentials): Observable<User> {
    return this.auth
      .mutate({
        mutation: CREATE_USER,
        variables: { createUserInput: credentials },
      })
      .pipe(
        requireData(),
        map(({ createUser }) => createUser),
      );
  }
}

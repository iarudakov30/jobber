import { TestBed } from '@angular/core/testing';
import {
  ApolloTestingController,
  ApolloTestingModule,
} from 'apollo-angular/testing';
import { firstValueFrom } from 'rxjs';

import { AUTH_CLIENT } from '../graphql.provider';
import { AuthService } from './auth.service';
import { Session } from './session';

describe('AuthService', () => {
  const credentials = { email: 'test@example.com', password: 'Test@1234' };
  const user = { id: '1', email: credentials.email };

  let controller: ApolloTestingController;
  let service: AuthService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      imports: [ApolloTestingModule.withClients([AUTH_CLIENT])],
    });
    controller = TestBed.inject(ApolloTestingController);
    service = TestBed.inject(AuthService);
  });

  afterEach(() => controller.verify());

  it('logs in and records the session', async () => {
    const result = firstValueFrom(service.login(credentials));

    const op = controller.expectOne('Login');
    expect(op.operation.variables).toEqual({ loginInput: credentials });
    op.flushData({ login: { __typename: 'User', ...user } });

    expect(await result).toMatchObject(user);
    expect(TestBed.inject(Session).user()).toMatchObject(user);
  });

  it('registers without starting a session', async () => {
    const result = firstValueFrom(service.register(credentials));

    const op = controller.expectOne('CreateUser');
    expect(op.operation.variables).toEqual({ createUserInput: credentials });
    op.flushData({ createUser: { __typename: 'User', ...user } });

    expect(await result).toMatchObject(user);
    expect(TestBed.inject(Session).isAuthenticated()).toBe(false);
  });
});

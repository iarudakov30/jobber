import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CombinedGraphQLErrors } from '@apollo/client';
import { form } from '@angular/forms/signals';

import { errorMessage, serverErrors } from './error-message';

describe('errorMessage', () => {
  it('unwraps NestJS validation messages', () => {
    const error = new CombinedGraphQLErrors({
      errors: [
        {
          message: 'Bad Request Exception',
          extensions: {
            code: 'BAD_REQUEST',
            originalError: {
              message: [
                'email must be an email',
                'password is not strong enough',
              ],
            },
          },
        },
      ],
    });
    expect(errorMessage(error)).toBe(
      'email must be an email\npassword is not strong enough',
    );
  });

  it('falls back to the GraphQL message', () => {
    const error = new CombinedGraphQLErrors({
      errors: [{ message: 'Credentials are not valid' }],
    });
    expect(errorMessage(error)).toBe('Credentials are not valid');
  });

  it('handles plain errors', () => {
    expect(errorMessage(new Error('Network down'))).toBe('Network down');
    expect(errorMessage('nope')).toBe('Something went wrong.');
  });
});

describe('serverErrors', () => {
  const validationError = () =>
    new CombinedGraphQLErrors({
      errors: [
        {
          message: 'Bad Request Exception',
          extensions: {
            originalError: {
              message: ['password is not strong enough', 'request rejected'],
            },
          },
        },
      ],
    });

  it('attaches messages to the field they name, the rest to the form', () => {
    const credentials = TestBed.runInInjectionContext(() =>
      form(signal({ email: '', password: '' })),
    );

    const [password, other] = serverErrors(validationError(), {
      password: credentials.password,
    });

    expect(password).toEqual({
      kind: 'server',
      message: 'password is not strong enough',
      fieldTree: credentials.password,
    });
    expect(other.fieldTree).toBeUndefined();
  });
});

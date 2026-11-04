import { ClientError } from 'graphql-request';

import { applyServerErrors, errorMessages } from './errors';

function clientError(
  errors: { message: string; extensions?: Record<string, unknown> }[],
  status = 200,
) {
  return new ClientError({ status, headers: new Headers(), errors } as never, {
    query: '',
  });
}

describe('errorMessages', () => {
  it('prefers the original NestJS validation messages', () => {
    const error = clientError([
      {
        message: 'Bad Request Exception',
        extensions: {
          originalError: {
            message: [
              'email must be an email',
              'password is not strong enough',
            ],
          },
        },
      },
    ]);

    expect(errorMessages(error)).toEqual([
      'email must be an email',
      'password is not strong enough',
    ]);
  });

  it('falls back to the GraphQL error message', () => {
    expect(
      errorMessages(clientError([{ message: 'Credentials are not valid' }])),
    ).toEqual(['Credentials are not valid']);
  });

  it('reports an HTTP failure without GraphQL errors', () => {
    expect(errorMessages(clientError([], 502))).toEqual([
      'Request failed (HTTP 502).',
    ]);
  });

  it('explains a network failure', () => {
    expect(errorMessages(new TypeError('Failed to fetch'))).toEqual([
      'Cannot reach the server. Is it running?',
    ]);
  });
});

describe('applyServerErrors', () => {
  it('puts field-named messages on the field and the rest on the form', () => {
    const setError = vi.fn();
    const error = clientError([
      {
        message: 'Bad Request Exception',
        extensions: {
          originalError: {
            message: ['password is not strong enough', 'Something else broke'],
          },
        },
      },
    ]);

    applyServerErrors(error, setError, ['email', 'password']);

    expect(setError).toHaveBeenCalledWith('password', {
      type: 'server',
      message: 'password is not strong enough',
    });
    expect(setError).toHaveBeenCalledWith('root.server', {
      type: 'server',
      message: 'Something else broke',
    });
  });
});

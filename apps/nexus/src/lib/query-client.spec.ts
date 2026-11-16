import { ClientError } from 'graphql-request';

import { createQueryClient } from './query-client';
import { session } from './session';

function graphqlError(code: string) {
  return new ClientError(
    {
      status: 200,
      errors: [{ message: 'nope', extensions: { code } }],
    } as never,
    { query: '{ balances { asset } }' },
  );
}

describe('createQueryClient', () => {
  beforeEach(() => {
    session.set({ id: '1', email: 'a@b.co' });
  });

  it('clears the session and signs out on FORBIDDEN', async () => {
    const onSignedOut = vi.fn();
    const client = createQueryClient(onSignedOut);

    await client
      .fetchQuery({
        queryKey: ['x'],
        queryFn: () => Promise.reject(graphqlError('FORBIDDEN')),
        retry: false,
      })
      .catch(() => undefined);

    expect(session.get()).toBeNull();
    expect(onSignedOut).toHaveBeenCalledTimes(1);
  });

  it('keeps the session on other errors', async () => {
    const onSignedOut = vi.fn();
    const client = createQueryClient(onSignedOut);

    await client
      .fetchQuery({
        queryKey: ['y'],
        queryFn: () => Promise.reject(graphqlError('BAD_USER_INPUT')),
        retry: false,
      })
      .catch(() => undefined);

    expect(session.get()).toEqual({ id: '1', email: 'a@b.co' });
    expect(onSignedOut).not.toHaveBeenCalled();
  });

  it('does not retry a FORBIDDEN query', () => {
    const retry = createQueryClient(vi.fn()).getDefaultOptions().queries
      ?.retry as (count: number, error: unknown) => boolean;

    expect(retry(0, graphqlError('FORBIDDEN'))).toBe(false);
    expect(retry(0, new Error('network'))).toBe(true);
    expect(retry(2, new Error('network'))).toBe(false);
  });
});

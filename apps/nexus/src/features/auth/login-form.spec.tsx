import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClientError } from 'graphql-request';

import { login } from './auth-api';
import { LoginForm } from './login-form';

vi.mock('./auth-api', () => ({ login: vi.fn() }));

function renderForm(onSuccess = vi.fn()) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LoginForm onSuccess={onSuccess} />
    </QueryClientProvider>,
  );
  return onSuccess;
}

function fillIn(email: string, password: string) {
  fireEvent.change(screen.getByLabelText('Email'), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: password },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginForm', () => {
  // A braced body: `beforeEach` treats a returned function as teardown, and `mockReset()`
  // returns the mock itself, which would then be called after every test.
  beforeEach(() => {
    vi.mocked(login).mockReset();
  });

  it('validates before calling the server', async () => {
    renderForm();

    fillIn('not-an-email', '');

    expect(
      await screen.findByText('Enter a valid email address.'),
    ).toBeTruthy();
    expect(screen.getByText('Password is required.')).toBeTruthy();
    expect(login).not.toHaveBeenCalled();
  });

  it('logs in and reports success', async () => {
    vi.mocked(login).mockResolvedValue({ id: '1', email: 'a@b.co' });
    const onSuccess = renderForm();

    fillIn('a@b.co', 'secret');

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(vi.mocked(login).mock.calls[0][0]).toEqual({
      email: 'a@b.co',
      password: 'secret',
    });
  });

  it('shows the server error and stays on the form', async () => {
    vi.mocked(login).mockImplementation(async () => {
      throw new ClientError(
        {
          status: 200,
          headers: new Headers(),
          errors: [{ message: 'Credentials are not valid' }],
        } as never,
        { query: '' },
      );
    });
    const onSuccess = renderForm();

    fillIn('a@b.co', 'wrong');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Credentials are not valid',
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });
});

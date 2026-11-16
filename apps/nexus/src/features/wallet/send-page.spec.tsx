import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { WALLET_URL, mockServer, renderPage } from '../../testing/render-page';
import { SendPage } from './send-page';

const server = mockServer();
const wallet = graphql.link(WALLET_URL);

interface Sent {
  key: string | null;
  input: unknown;
}

/** Answers transfers with `respond` (default: success) and records what was sent. */
function recordTransfers(
  respond: (call: number) => Response = () => success('500'),
): Sent[] {
  const sent: Sent[] = [];
  server.use(
    wallet.mutation('Transfer', ({ request, variables }) => {
      sent.push({
        key: request.headers.get('Idempotency-Key'),
        input: variables['input'],
      });
      return respond(sent.length);
    }),
  );
  return sent;
}

function success(amount: string) {
  return HttpResponse.json({
    data: { transfer: { transactionId: 't1', amount, asset: 'USD' } },
  });
}

function failure(message: string, code = 'BAD_USER_INPUT') {
  return HttpResponse.json({
    data: null,
    errors: [{ message, extensions: { code } }],
  });
}

function fillIn(toEmail: string, amount: string) {
  fireEvent.change(screen.getByLabelText("Recipient's email"), {
    target: { value: toEmail },
  });
  fireEvent.change(screen.getByLabelText('Amount (USD)'), {
    target: { value: amount },
  });
}

const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));

describe('SendPage', () => {
  it.each([
    ['not-an-email', '5', 'Enter a valid email address.'],
    [
      'bob@example.com',
      '1.234',
      'Enter an amount like 12.50 (at most 2 decimals).',
    ],
    ['bob@example.com', '0', 'Enter more than $0.00.'],
    ['bob@example.com', '', 'Amount is required.'],
  ])(
    'refuses %s / "%s" before calling the server',
    async (email, amount, message) => {
      const sent = recordTransfers();
      await renderPage(SendPage);

      fillIn(email, amount);
      submit();

      expect(await screen.findByText(message)).toBeTruthy();
      expect(sent).toEqual([]);
    },
  );

  it('sends minor units with an Idempotency-Key and confirms', async () => {
    const sent = recordTransfers();
    await renderPage(SendPage);

    fillIn('bob@example.com', '5');
    submit();

    expect((await screen.findByRole('status')).textContent).toBe(
      'Sent $5.00 to bob@example.com.',
    );
    expect(sent).toEqual([
      {
        key: expect.stringMatching(/^[0-9a-f-]{36}$/),
        input: { toEmail: 'bob@example.com', asset: 'USD', amount: '500' },
      },
    ]);
    // The form is cleared for the next transfer.
    expect(
      (screen.getByLabelText('Amount (USD)') as HTMLInputElement).value,
    ).toBe('');
  });

  it('reuses the key when the same transfer is retried, and not after it succeeds', async () => {
    const sent = recordTransfers((call) =>
      call === 1 ? HttpResponse.error() : success('500'),
    );
    await renderPage(SendPage);

    fillIn('bob@example.com', '5');
    submit();
    expect(await screen.findByRole('alert')).toBeTruthy();
    submit();
    await screen.findByRole('status');
    fillIn('bob@example.com', '5');
    submit();
    await waitFor(() => expect(sent).toHaveLength(3));

    expect(sent[1].key).toBe(sent[0].key);
    expect(sent[2].key).not.toBe(sent[0].key);
  });

  it('uses a new key when the input changes after a failure', async () => {
    const sent = recordTransfers((call) =>
      call === 1
        ? failure('amount exceeds your available balance')
        : success('400'),
    );
    await renderPage(SendPage);

    fillIn('bob@example.com', '5');
    submit();
    await screen.findByText('Not enough money in your wallet.');
    fillIn('bob@example.com', '4');
    submit();
    await screen.findByRole('status');

    expect(sent[1].key).not.toBe(sent[0].key);
  });

  it('sends one request when the form is submitted twice at once', async () => {
    const sent = recordTransfers();
    await renderPage(SendPage);
    const form = screen
      .getByRole('button', { name: 'Send' })
      .closest('form') as HTMLFormElement;

    fillIn('bob@example.com', '5');
    // Submitting the form directly, as a fast double click can before React re-renders the
    // button as disabled.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole('status');

    expect(sent).toHaveLength(1);
  });

  it.each([
    [
      'toEmail does not belong to any user',
      "Recipient's email",
      'No NexusPay user has this email.',
    ],
    [
      'toEmail is your own email',
      "Recipient's email",
      "You can't send money to yourself.",
    ],
    [
      'amount exceeds your available balance',
      'Amount (USD)',
      'Not enough money in your wallet.',
    ],
  ])('shows "%s" on its field', async (serverMessage, label, shown) => {
    recordTransfers(() => failure(serverMessage));
    await renderPage(SendPage);

    fillIn('bob@example.com', '5');
    submit();

    const message = await screen.findByText(shown);
    const input = screen.getByLabelText(label);
    expect(input.getAttribute('aria-describedby')).toBe(message.id);
  });

  it('explains a CONFLICT (the same transfer is still running)', async () => {
    recordTransfers(() =>
      failure(
        'A request with this Idempotency-Key is still in progress',
        'CONFLICT',
      ),
    );
    await renderPage(SendPage);

    fillIn('bob@example.com', '5');
    submit();

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /still being processed/,
    );
  });
});

import { fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import {
  PAYMENTS_URL,
  mockServer,
  renderPage,
} from '../../testing/render-page';
import { TopUpPage } from './topup-page';

const server = mockServer();
const payments = graphql.link(PAYMENTS_URL);
const CHECKOUT = 'https://checkout.stripe.com/c/pay/cs_test_1';

interface Started {
  key: string | null;
  amount: unknown;
}

/** Answers createTopUp with `respond` (default: a Checkout URL) and records each call. */
function recordTopUps(
  respond: (call: number) => Response = () => started(),
): Started[] {
  const calls: Started[] = [];
  server.use(
    payments.mutation('CreateTopUp', ({ request, variables }) => {
      calls.push({
        key: request.headers.get('Idempotency-Key'),
        amount: (variables['input'] as { amount: unknown }).amount,
      });
      return respond(calls.length);
    }),
  );
  return calls;
}

function started() {
  return HttpResponse.json({
    data: { createTopUp: { paymentId: 'p1', checkoutUrl: CHECKOUT } },
  });
}

function failure(message: string, code: string) {
  return HttpResponse.json({
    data: null,
    errors: [{ message, extensions: { code } }],
  });
}

async function renderTopUp() {
  const goTo = vi.fn();
  await renderPage(() => <TopUpPage goTo={goTo} />);
  return goTo;
}

const fillIn = (amount: string) =>
  fireEvent.change(screen.getByLabelText('Amount (USD)'), {
    target: { value: amount },
  });
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Continue to payment' }));

describe('TopUpPage', () => {
  it.each([
    ['', 'Amount is required.'],
    ['abc', 'Enter an amount like 50 or 12.50 (at most 2 decimals).'],
    ['0.99', 'Top up between $1.00 and $1,000.00.'],
    ['1000.01', 'Top up between $1.00 and $1,000.00.'],
  ])('refuses %j before calling the API', async (amount, message) => {
    const calls = recordTopUps();
    const goTo = await renderTopUp();

    fillIn(amount);
    submit();

    expect(await screen.findByText(message)).toBeTruthy();
    expect(calls).toEqual([]);
    expect(goTo).not.toHaveBeenCalled();
  });

  it('starts the top-up in minor units and opens Stripe Checkout', async () => {
    const calls = recordTopUps();
    const goTo = await renderTopUp();

    fillIn('50');
    submit();

    await waitFor(() => expect(goTo).toHaveBeenCalledWith(CHECKOUT));
    expect(calls).toEqual([{ key: expect.any(String), amount: '5000' }]);
    expect(
      (
        screen.getByRole('button', {
          name: 'Opening Stripe…',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('fills in a preset amount', async () => {
    const calls = recordTopUps();
    const goTo = await renderTopUp();

    fireEvent.click(screen.getByRole('button', { name: '$100' }));
    submit();

    await waitFor(() => expect(goTo).toHaveBeenCalled());
    expect(calls[0].amount).toBe('10000');
  });

  it('puts the daily limit refusal on the amount field', async () => {
    recordTopUps(() =>
      failure(
        'amount is over your limit of $2,000.00 per 24 hours: $500.00 left',
        'BAD_USER_INPUT',
      ),
    );
    const goTo = await renderTopUp();

    fillIn('600');
    submit();

    expect(
      await screen.findByText(
        'amount is over your limit of $2,000.00 per 24 hours: $500.00 left',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText('Amount (USD)').getAttribute('aria-invalid'),
    ).toBe('true');
    expect(goTo).not.toHaveBeenCalled();
  });

  it('shows a Stripe outage and retries with the same Idempotency-Key', async () => {
    const calls = recordTopUps((call) =>
      call === 1
        ? failure(
            'Stripe is not available right now; try again in a minute',
            'PAYMENT_PROVIDER_UNAVAILABLE',
          )
        : started(),
    );
    const goTo = await renderTopUp();

    fillIn('25');
    submit();
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Stripe is not available right now; try again in a minute',
    );
    submit();

    await waitFor(() => expect(goTo).toHaveBeenCalledWith(CHECKOUT));
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);
  });

  it('uses a new Idempotency-Key when the amount changes', async () => {
    const calls = recordTopUps((call) =>
      call === 1
        ? failure(
            'Stripe is not available right now',
            'PAYMENT_PROVIDER_UNAVAILABLE',
          )
        : started(),
    );
    const goTo = await renderTopUp();

    fillIn('25');
    submit();
    await screen.findByRole('alert');
    fillIn('30');
    submit();

    await waitFor(() => expect(goTo).toHaveBeenCalled());
    expect(calls.map((c) => c.amount)).toEqual(['2500', '3000']);
    expect(calls[1].key).not.toBe(calls[0].key);
  });
});

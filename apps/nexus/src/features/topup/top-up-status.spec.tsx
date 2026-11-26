import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { fakeRealtime } from '../../testing/fake-socket';
import {
  PAYMENTS_URL,
  WALLET_URL,
  mockServer,
  renderPage,
} from '../../testing/render-page';
import { WalletPage } from '../wallet/wallet-page';
import { TopUpStatus } from './top-up-status';

const server = mockServer();
const payments = graphql.link(PAYMENTS_URL);
const wallet = graphql.link(WALLET_URL);
const PAYMENT_ID = '0b3c1a52-5d0e-4a8e-9c1f-6f1e2d3c4b5a';

type Status = 'PENDING' | 'SUCCEEDED' | 'EXPIRED' | 'FAILED';

/** Answers `payment(id)` with the statuses in turn (the last one repeats); counts the polls. */
function paymentStatuses(...statuses: Status[]) {
  const polls = { count: 0 };
  server.use(
    payments.query('Payment', ({ variables }) => {
      const status = statuses[Math.min(polls.count++, statuses.length - 1)];
      return HttpResponse.json({
        data: {
          payment: {
            id: variables['id'],
            amount: '5000',
            currency: 'USD',
            status,
          },
        },
      });
    }),
  );
  return polls;
}

/** Answers the wallet's `topUp` with null `misses` times, then the credited entry. */
function creditAfter(misses: number) {
  const polls = { count: 0 };
  server.use(
    wallet.query('TopUpEntry', () =>
      HttpResponse.json({
        data: {
          topUp:
            polls.count++ < misses
              ? null
              : { id: '42', amount: '5000', asset: 'USD' },
        },
      }),
    ),
  );
  return polls;
}

async function renderStatus(maxPolls = 5) {
  const onDismiss = vi.fn();
  const { queryClient } = await renderPage(() => (
    <TopUpStatus
      paymentId={PAYMENT_ID}
      onDismiss={onDismiss}
      pollMs={10}
      maxPolls={maxPolls}
    />
  ));
  return { onDismiss, queryClient };
}

const status = () => screen.getByTestId('topup-status').textContent;

describe('TopUpStatus', () => {
  it('waits for Stripe, then for the credit, and only then refreshes the wallet', async () => {
    const payment = paymentStatuses('PENDING', 'PENDING', 'SUCCEEDED');
    const credit = creditAfter(2);
    const { queryClient } = await renderStatus();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    expect(
      await screen.findByText('Waiting for Stripe to confirm $50.00…'),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        'Payment received. Adding $50.00 to your wallet…',
      ),
    ).toBeTruthy();
    expect(invalidate).not.toHaveBeenCalled();

    expect(
      await screen.findByText('$50.00 added to your wallet.'),
    ).toBeTruthy();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['wallet'] });
    expect(screen.getByRole('status')).toBeTruthy();
    expect(payment.count).toBe(3);
    expect(credit.count).toBe(3);
  });

  it.each([
    [
      'EXPIRED',
      'Your $50.00 top-up expired before it was paid. Nothing was charged.',
    ],
    ['FAILED', 'Your $50.00 top-up could not be started. Nothing was charged.'],
  ] as const)(
    'reports %s as an error and stops polling',
    async (final, message) => {
      const payment = paymentStatuses(final);
      await renderStatus();

      expect((await screen.findByRole('alert')).textContent).toContain(message);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(payment.count).toBe(1);
    },
  );

  it('gives up after maxPolls while Stripe has not confirmed', async () => {
    const payment = paymentStatuses('PENDING');
    await renderStatus(3);

    await waitFor(() =>
      expect(status()).toContain(
        "Stripe hasn't confirmed your $50.00 top-up yet.",
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(payment.count).toBe(3);
  });

  it('says so when the credit is slower than the polling', async () => {
    paymentStatuses('SUCCEEDED');
    const credit = creditAfter(Infinity);
    await renderStatus(3);

    await waitFor(() =>
      expect(status()).toContain(
        'Payment received. $50.00 will show in your wallet shortly.',
      ),
    );
    expect(credit.count).toBe(3);
  });

  it('reports a payment it cannot find', async () => {
    server.use(
      payments.query('Payment', () =>
        HttpResponse.json({ data: { payment: null } }),
      ),
    );
    await renderStatus();

    expect((await screen.findByRole('alert')).textContent).toContain(
      'This top-up was not found.',
    );
  });

  it('can be dismissed', async () => {
    paymentStatuses('EXPIRED');
    const { onDismiss } = await renderStatus();

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('TopUpStatus with the realtime feed', () => {
  async function renderLive() {
    const fake = fakeRealtime();
    await renderPage(
      () => (
        <TopUpStatus
          paymentId={PAYMENT_ID}
          onDismiss={() => undefined}
          pollMs={10}
          maxPolls={5}
        />
      ),
      { realtime: fake.realtime },
    );
    fake.client.start();
    act(() => fake.latest().welcome(7));
    return fake;
  }

  it('looks for the credit again on a USD balance message instead of polling', async () => {
    paymentStatuses('SUCCEEDED');
    const credit = creditAfter(1);
    const { latest } = await renderLive();

    expect(
      await screen.findByText(
        'Payment received. Adding $50.00 to your wallet…',
      ),
    ).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The welcome's resync may have asked once more; a poll every 10 ms would be ten times.
    expect(credit.count).toBeLessThanOrEqual(2);
    const before = credit.count;

    act(() =>
      latest().message('user.7', 90, {
        type: 'balance',
        asset: 'NXC',
        available: '1',
        held: '0',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(credit.count).toBe(before);

    act(() =>
      latest().message('user.7', 91, {
        type: 'balance',
        asset: 'USD',
        available: '5000',
        held: '0',
      }),
    );
    expect(
      await screen.findByText('$50.00 added to your wallet.'),
    ).toBeTruthy();
    expect(credit.count).toBe(before + 1);
  });

  it('says so when no balance message came in time', async () => {
    paymentStatuses('SUCCEEDED');
    creditAfter(Infinity);
    await renderLive();

    expect(
      await screen.findByText(
        'Payment received. $50.00 will show in your wallet shortly.',
      ),
    ).toBeTruthy();
  });
});

describe('WalletPage after Stripe', () => {
  it('shows the credited top-up and the new balance', async () => {
    paymentStatuses('SUCCEEDED');
    creditAfter(0);
    let balanceReads = 0;
    server.use(
      wallet.query('Balances', () => {
        balanceReads++;
        return HttpResponse.json({
          data: {
            balances: [
              {
                asset: 'USD',
                available: balanceReads === 1 ? '0' : '5000',
                held: '0',
              },
            ],
          },
        });
      }),
      wallet.query('Entries', () =>
        HttpResponse.json({
          data: { entries: { items: [], nextCursor: null } },
        }),
      ),
    );

    await renderPage(() => <WalletPage topUpId={PAYMENT_ID} />);

    expect(
      await screen.findByText('$50.00 added to your wallet.'),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('balance-USD').textContent).toContain('$50.00'),
    );
  });
});

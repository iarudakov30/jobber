import { fireEvent, screen, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { WALLET_URL, mockServer, renderPage } from '../../testing/render-page';
import { WalletPage } from './wallet-page';

const server = mockServer();
const wallet = graphql.link(WALLET_URL);

const entry = (id: string, type: string, amount: string) => ({
  id,
  transactionId: `t${id}`,
  type,
  asset: 'USD',
  amount,
  createdAt: '2026-11-16T21:44:04.258Z',
});

describe('WalletPage', () => {
  it('shows the balance and pages through the history', async () => {
    const cursors: unknown[] = [];
    server.use(
      wallet.query('Balances', () =>
        HttpResponse.json({
          data: {
            balances: [{ asset: 'USD', available: '9500', held: '0' }],
          },
        }),
      ),
      wallet.query('Entries', ({ variables }) => {
        cursors.push(variables['after']);
        return HttpResponse.json({
          data: {
            entries:
              variables['after'] == null
                ? {
                    items: [entry('3', 'transfer', '-500')],
                    nextCursor: '3',
                  }
                : {
                    items: [entry('1', 'seed', '10000')],
                    nextCursor: null,
                  },
          },
        });
      }),
    );

    await renderPage(WalletPage);

    expect(await screen.findByText('$95.00')).toBeTruthy();
    const history = await screen.findByRole('list', { name: 'History' });
    expect(within(history).getByText('Transfer')).toBeTruthy();
    expect(within(history).getByText('-$5.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await within(history).findByText('Test funds')).toBeTruthy();
    expect(within(history).getByText('+$100.00')).toBeTruthy();
    expect(cursors).toEqual([null, '3']);
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('says so when there is no history yet', async () => {
    server.use(
      wallet.query('Balances', () =>
        HttpResponse.json({
          data: { balances: [{ asset: 'USD', available: '0', held: '0' }] },
        }),
      ),
      wallet.query('Entries', () =>
        HttpResponse.json({
          data: { entries: { items: [], nextCursor: null } },
        }),
      ),
    );

    await renderPage(WalletPage);

    expect(await screen.findByText('No transactions yet.')).toBeTruthy();
    expect(screen.getByText('$0.00')).toBeTruthy();
  });

  it('shows a load error instead of a balance', async () => {
    server.use(
      wallet.query('Balances', () =>
        HttpResponse.json({ errors: [{ message: 'database down' }] }),
      ),
      wallet.query('Entries', () =>
        HttpResponse.json({
          data: { entries: { items: [], nextCursor: null } },
        }),
      ),
    );

    await renderPage(WalletPage);

    expect((await screen.findByRole('alert')).textContent).toBe(
      'database down',
    );
  });
});

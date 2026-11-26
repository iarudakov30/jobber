import { act, screen, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { fakeRealtime } from '../../testing/fake-socket';
import {
  MARKET_URL,
  WALLET_URL,
  mockServer,
  renderPage,
} from '../../testing/render-page';
import { PortfolioPage, valueOf } from './portfolio-page';

const server = mockServer();
const market = graphql.link(MARKET_URL);
const wallet = graphql.link(WALLET_URL);

function backend(positions: unknown[]) {
  server.use(
    wallet.query('Positions', () => HttpResponse.json({ data: { positions } })),
    wallet.query('Balances', () =>
      HttpResponse.json({
        data: {
          balances: [
            { asset: 'USD', available: '1539', held: '1005' },
            { asset: 'NXC', available: '200000000', held: '0' },
          ],
        },
      }),
    ),
    market.query('Coins', () =>
      HttpResponse.json({
        data: {
          coins: [
            {
              code: 'NXC',
              name: 'Nexus Coin',
              tick: { price: '4500', seq: 3, at: '2026-11-26T12:00:00.000Z' },
              open24h: null,
            },
          ],
        },
      }),
    ),
  );
}

describe('PortfolioPage', () => {
  it('values each position at the live price, with its profit or loss', async () => {
    backend([
      {
        coin: 'NXC',
        qty: '200000000',
        costBasis: '8461',
        averagePrice: '4230',
      },
    ]);
    const { realtime, client, latest } = fakeRealtime();
    await renderPage(PortfolioPage, { realtime });
    client.start();
    act(() => latest().welcome());

    const row = await screen.findByTestId('position-NXC');
    expect(row.textContent).toContain('2 NXC');
    expect(row.textContent).toContain('$42.30');
    expect(within(row).getByTestId('value').textContent).toBe('$90.00');
    expect(within(row).getByTestId('pl').textContent).toBe('+$5.39');
    expect(screen.getByTestId('cash').textContent).toBe('$15.39');
    expect(screen.getByText('$10.05 held for limit orders')).toBeTruthy();

    act(() => latest().message('prices.NXC', 4, { price: '4000', at: 1 }));

    expect(within(row).getByTestId('value').textContent).toBe('$80.00');
    expect(within(row).getByTestId('pl').textContent).toBe('-$4.61');
  });

  it('invites a user without coins to the markets', async () => {
    backend([]);
    await renderPage(PortfolioPage);
    expect(
      await screen.findByText('No coins yet.', { exact: false }),
    ).toBeTruthy();
  });
});

it('valueOf rounds a fraction of a cent down', () => {
  expect(valueOf('33333333', '100')).toBe(33n);
  expect(valueOf('100000000', '4209')).toBe(4209n);
});

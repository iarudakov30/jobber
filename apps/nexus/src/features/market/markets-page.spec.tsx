import { act, screen, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { fakeRealtime } from '../../testing/fake-socket';
import { MARKET_URL, mockServer, renderPage } from '../../testing/render-page';
import { MarketsPage, changePercent } from './markets-page';

const server = mockServer();
const market = graphql.link(MARKET_URL);

const coin = (code: string, price: string | null, open24h: string | null) => ({
  code,
  name: `${code} coin`,
  tick: price && { price, seq: 5, at: '2026-11-26T12:00:00.000Z' },
  open24h,
});

describe('MarketsPage', () => {
  it('shows each coin’s price and 24 h change, then follows live ticks', async () => {
    server.use(
      market.query('Coins', () =>
        HttpResponse.json({
          data: {
            coins: [coin('NXC', '4200', '4000'), coin('WISP', null, null)],
          },
        }),
      ),
    );
    const { realtime, client, latest } = fakeRealtime();
    await renderPage(MarketsPage, { realtime });
    client.start();
    act(() => latest().welcome());

    const nxc = await screen.findByTestId('coin-NXC');
    expect(within(nxc).getByTestId('price').textContent).toBe('$42.00');
    expect(within(nxc).getByTestId('change').textContent).toBe('+5.00%');
    const wisp = screen.getByTestId('coin-WISP');
    expect(within(wisp).getByTestId('price').textContent).toBe('—');
    expect(latest().requests).toEqual([
      ['subscribe', 'prices.NXC'],
      ['subscribe', 'prices.WISP'],
    ]);

    act(() => {
      latest().message('prices.NXC', 6, { price: '3800', at: Date.now() });
      // An older tick than the snapshot changes nothing.
      latest().message('prices.WISP', 1, { price: '340', at: Date.now() });
    });
    expect(within(nxc).getByTestId('price').textContent).toBe('$38.00');
    expect(within(nxc).getByTestId('change').textContent).toBe('-5.00%');
    expect(within(wisp).getByTestId('price').textContent).toBe('$3.40');
    expect(
      within(nxc).getByRole('link', { name: 'Trade' }).getAttribute('href'),
    ).toBe('/trade/NXC');
  });
});

it('changePercent needs a price and a non-zero open', () => {
  expect(changePercent('110', '100')).toBeCloseTo(10);
  expect(changePercent(undefined, '100')).toBeUndefined();
  expect(changePercent('110', null)).toBeUndefined();
  expect(changePercent('110', '0')).toBeUndefined();
});

import { act, screen, within } from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { fakeRealtime } from '../../testing/fake-socket';
import { MARKET_URL, mockServer, renderPage } from '../../testing/render-page';
import { MarketsPage, changePercent } from './markets-page';
import { sourceLabel } from './price-status';

const server = mockServer();
const market = graphql.link(MARKET_URL);

const coin = (
  code: string,
  price: string | null,
  open24h: string | null,
  { source = 'simulator', ageMs = 0 } = {},
) => ({
  code,
  name: `${code} coin`,
  live: source !== 'simulator',
  providers: source === 'simulator' ? [] : ['binance', 'coinbase'],
  tick: price && {
    price,
    seq: 5,
    at: new Date(Date.now() - ageMs).toISOString(),
    source,
  },
  open24h,
});

async function renderMarkets(coins: ReturnType<typeof coin>[]) {
  server.use(
    market.query('Coins', () => HttpResponse.json({ data: { coins } })),
  );
  const fake = fakeRealtime();
  await renderPage(MarketsPage, { realtime: fake.realtime });
  fake.client.start();
  act(() => fake.latest().welcome());
  return fake;
}

describe('MarketsPage', () => {
  it('shows each coin’s price and 24 h change, then follows live ticks', async () => {
    const { latest } = await renderMarkets([
      coin('NXC', '4200', '4000'),
      coin('WISP', null, null),
    ]);

    const nxc = await screen.findByTestId('coin-NXC');
    expect(within(nxc).getByTestId('price').textContent).toBe('$42.00');
    expect(within(nxc).getByTestId('change').textContent).toBe('+5.00%');
    const wisp = screen.getByTestId('coin-WISP');
    expect(within(wisp).getByTestId('price').textContent).toBe(
      'Price unavailable',
    );
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

  it('groups real and simulated coins, with the exchange of each real price', async () => {
    const { latest } = await renderMarkets([
      coin('NXC', '4200', '4000'),
      coin('BTC', '6000000', '5900000', { source: 'binance' }),
      coin('ETH', '300000', null, { source: 'coinbase' }),
    ]);

    const real = await screen.findByRole('table', { name: 'Real prices' });
    const simulated = screen.getByRole('table', { name: 'Simulated' });
    expect(
      within(real)
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.dataset['testid']),
    ).toEqual(['coin-BTC', 'coin-ETH']);
    expect(within(simulated).getByTestId('coin-NXC')).toBeTruthy();

    const btc = within(real).getByTestId('coin-BTC');
    const eth = within(real).getByTestId('coin-ETH');
    expect(within(btc).getByTestId('source').textContent).toBe('Binance');
    expect(within(eth).getByTestId('source').textContent).toBe(
      'Coinbase · fallback',
    );
    expect(within(simulated).queryByTestId('source')).toBeNull();

    // Binance takes ETH back: the badge follows the ticks.
    act(() =>
      latest().message('prices.ETH', 6, {
        price: '300100',
        at: Date.now(),
        source: 'binance',
      }),
    );
    expect(within(eth).getByTestId('source').textContent).toBe('Binance');
  });

  it('says "Price unavailable" for a price older than 10 s, with no badge or change', async () => {
    await renderMarkets([
      coin('HYPE', '3500', '3400', { source: 'binance', ageMs: 11_000 }),
    ]);

    const hype = await screen.findByTestId('coin-HYPE');
    expect(within(hype).getByTestId('price').textContent).toBe(
      'Price unavailable',
    );
    expect(within(hype).getByTestId('change').textContent).toBe('—');
    expect(within(hype).queryByTestId('source')).toBeNull();
  });
});

it('changePercent needs a price and a non-zero open', () => {
  expect(changePercent('110', '100')).toBeCloseTo(10);
  expect(changePercent(undefined, '100')).toBeUndefined();
  expect(changePercent('110', null)).toBeUndefined();
  expect(changePercent('110', '0')).toBeUndefined();
});

it('sourceLabel names the exchange, and says when it is the fallback', () => {
  const live = { live: true, providers: ['binance', 'coinbase'] };
  const tick = (source?: string) => ({ price: '1', seq: 1, at: 0, source });
  expect(sourceLabel(live, tick('binance'))).toBe('Binance');
  expect(sourceLabel(live, tick('coinbase'))).toBe('Coinbase · fallback');
  expect(
    sourceLabel(
      { live: true, providers: ['coinbase', 'binance'] },
      tick('coinbase'),
    ),
  ).toBe('Coinbase');
  expect(sourceLabel({ live: false, providers: [] }, tick('simulator'))).toBe(
    undefined,
  );
  expect(sourceLabel(live, undefined)).toBe(undefined);
  expect(sourceLabel(live, tick())).toBe(undefined);
});

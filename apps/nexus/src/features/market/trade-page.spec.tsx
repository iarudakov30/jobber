import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { HttpResponse } from 'msw';
import { graphql } from 'msw/graphql';

import { fakeRealtime } from '../../testing/fake-socket';
import {
  MARKET_URL,
  WALLET_URL,
  mockServer,
  renderPage,
} from '../../testing/render-page';
import { TradePage } from './trade-page';

// The chart draws on a canvas, which jsdom doesn't have; its bar logic is tested in bars.spec.
vi.mock('./price-chart', () => ({ PriceChart: () => <div>chart</div> }));

const server = mockServer();
const market = graphql.link(MARKET_URL);
const wallet = graphql.link(WALLET_URL);

const order = (overrides: Record<string, unknown> = {}) => ({
  id: 'o-1',
  type: 'MARKET',
  coin: 'NXC',
  side: 'BUY',
  qty: '50000000',
  limitPrice: null,
  fillPrice: '4209',
  usdAmount: '2105',
  fee: '11',
  total: '2116',
  status: 'FILLED',
  reason: null,
  expiresAt: null,
  createdAt: '2026-11-26T12:00:00.000Z',
  ...overrides,
});

const limitOrder = (input: Record<string, unknown>) =>
  order({
    type: 'LIMIT',
    status: 'OPEN',
    limitPrice: input['limitPrice'],
    qty: input['qty'],
    fillPrice: null,
  });

interface Calls {
  quotes: Record<string, unknown>[];
  placed: { input: Record<string, unknown>; key: string | null }[];
  cancelled: string[];
}

type PlaceResult = ReturnType<typeof order> | Response;

function backend({
  quoteTtlMs = 10_000,
  placeOrder = (input: Record<string, unknown>): PlaceResult =>
    input['type'] === 'LIMIT' ? limitOrder(input) : order(),
  orders = [] as ReturnType<typeof order>[],
  btcSource = 'binance',
  tickAgeMs = 0,
} = {}) {
  const at = new Date(Date.now() - tickAgeMs).toISOString();
  const calls: Calls = { quotes: [], placed: [], cancelled: [] };
  server.use(
    market.query('Coins', () =>
      HttpResponse.json({
        data: {
          coins: [
            {
              code: 'NXC',
              name: 'Nexus Coin',
              live: false,
              providers: [],
              tick: { price: '4200', seq: 1, at, source: 'simulator' },
              open24h: '4000',
            },
            {
              code: 'BTC',
              name: 'Bitcoin',
              live: true,
              providers: ['binance', 'coinbase'],
              tick: { price: '6000000', seq: 1, at, source: btcSource },
              open24h: '5900000',
            },
          ],
        },
      }),
    ),
    market.query('Candles', () => HttpResponse.json({ data: { candles: [] } })),
    market.query('Orders', () => HttpResponse.json({ data: { orders } })),
    wallet.query('Balances', () =>
      HttpResponse.json({
        data: { balances: [{ asset: 'USD', available: '10000', held: '0' }] },
      }),
    ),
    market.mutation('Quote', ({ variables }) => {
      calls.quotes.push(variables);
      return HttpResponse.json({
        data: {
          quote: {
            id: `q-${calls.quotes.length}`,
            coin: 'NXC',
            side: variables['side'],
            qty: variables['qty'],
            price: '4209',
            usdAmount: '2105',
            fee: '11',
            total: '2116',
            expiresAt: new Date(Date.now() + quoteTtlMs).toISOString(),
          },
        },
      });
    }),
    market.mutation('PlaceOrder', ({ variables, request }) => {
      const input = variables['input'] as Record<string, unknown>;
      calls.placed.push({ input, key: request.headers.get('idempotency-key') });
      const result = placeOrder(input);
      return result instanceof Response
        ? result
        : HttpResponse.json({ data: { placeOrder: result } });
    }),
    market.mutation('CancelOrder', ({ variables }) => {
      calls.cancelled.push(variables['id'] as string);
      return HttpResponse.json({
        data: {
          cancelOrder: order({ id: variables['id'], status: 'CANCELLED' }),
        },
      });
    }),
  );
  return calls;
}

// Each page gets its own price book: one shared across tests would keep an earlier test's tick
// (a tick with the same seq never replaces it) and let it go stale.
const renderTrade = (coin: string) =>
  renderPage(() => <TradePage coin={coin} />, {
    realtime: fakeRealtime().realtime,
  });

const form = () => screen.getByRole('form', { name: 'Order' });
const typeQty = (value: string) =>
  fireEvent.change(within(form()).getByLabelText('Quantity (NXC)'), {
    target: { value },
  });
const click = (name: string | RegExp) =>
  fireEvent.click(within(form()).getByRole('button', { name }));

async function openTrade() {
  await renderTrade('NXC');
  await screen.findByText('$42.00', { selector: '[data-testid="live-price"]' });
}

describe('TradePage', () => {
  it('quotes a market buy, counts the quote down, and places it with the quote as its key', async () => {
    const calls = backend();
    await openTrade();

    typeQty('0.5');
    click('Get quote');

    const quote = await screen.findByTestId('quote');
    expect(quote.textContent).toContain('$42.09');
    expect(quote.textContent).toContain('You pay$21.16');
    expect(screen.getByTestId('quote-countdown').textContent).toMatch(
      /Quote valid for (10|9) s/,
    );
    expect(calls.quotes).toEqual([
      { coin: 'NXC', side: 'BUY', qty: '50000000' },
    ]);

    click('Buy NXC');

    expect(await screen.findByText('Bought 0.5 NXC for $21.16.')).toBeTruthy();
    expect(calls.placed).toEqual([
      { input: { type: 'MARKET', quoteId: 'q-1' }, key: 'q-1' },
    ]);
    expect(screen.queryByTestId('quote')).toBeNull();
  });

  it('asks for a new quote when the countdown runs out', async () => {
    const calls = backend({ quoteTtlMs: 1_000 });
    await openTrade();

    typeQty('1');
    click('Get quote');
    await screen.findByTestId('quote');

    await waitFor(() => expect(calls.quotes.length).toBeGreaterThanOrEqual(2), {
      timeout: 3_000,
    });
    expect(calls.quotes[1]).toEqual(calls.quotes[0]);
  });

  it('gets a new quote when the market says the old one expired', async () => {
    const calls = backend({
      placeOrder: () =>
        HttpResponse.json({
          errors: [
            {
              message:
                'The quote has expired or was already used; get a new one',
              extensions: { code: 'QUOTE_EXPIRED' },
            },
          ],
          data: null,
        }),
    });
    await openTrade();
    typeQty('1');
    click('Get quote');
    await screen.findByTestId('quote');

    click('Buy NXC');

    expect(
      await screen.findByText('The quote expired. Here is a new one.'),
    ).toBeTruthy();
    expect(calls.quotes).toHaveLength(2);
  });

  it('explains a rejected order', async () => {
    backend({
      placeOrder: () =>
        order({ status: 'REJECTED', reason: 'insufficient USD' }),
    });
    await openTrade();
    typeQty('100');
    click('Get quote');
    await screen.findByTestId('quote');

    click('Buy NXC');

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Not enough USD in your wallet.',
    );
  });

  it('places a limit order, keeping its key for a retry of the same order', async () => {
    let attempts = 0;
    const calls = backend({
      placeOrder: (input) =>
        attempts++ === 0
          ? HttpResponse.json(
              { errors: [{ message: 'boom' }], data: null },
              { status: 500 },
            )
          : limitOrder(input),
    });
    await openTrade();

    fireEvent.click(within(form()).getByRole('radio', { name: 'Limit' }));
    typeQty('1');
    fireEvent.change(
      within(form()).getByLabelText('Limit price (USD per coin)'),
      { target: { value: '40' } },
    );
    click('Place limit buy');
    await screen.findByRole('alert');
    click('Place limit buy');

    expect(
      await screen.findByText('Limit order placed: buy 1 NXC at $40.00.'),
    ).toBeTruthy();
    const input = {
      type: 'LIMIT',
      coin: 'NXC',
      side: 'BUY',
      qty: '100000000',
      limitPrice: '4000',
    };
    expect(calls.placed.map((c) => c.input)).toEqual([input, input]);
    expect(calls.placed[0].key).toBeTruthy();
    expect(calls.placed[1].key).toBe(calls.placed[0].key);
  });

  it('checks the quantity and the limit price before asking the market', async () => {
    const calls = backend();
    await openTrade();

    typeQty('1.123456789');
    click('Get quote');
    expect(
      await screen.findByText(
        'Enter a quantity like 0.5 (at most 8 decimals).',
      ),
    ).toBeTruthy();

    fireEvent.click(within(form()).getByRole('radio', { name: 'Limit' }));
    typeQty('1');
    click('Place limit buy');
    expect(
      await screen.findByText('Enter a price like 42.50 (at most 2 decimals).'),
    ).toBeTruthy();
    expect(calls.quotes).toEqual([]);
    expect(calls.placed).toEqual([]);
  });

  it('lists the coin’s open orders with Cancel, and its recent ones', async () => {
    const calls = backend({
      orders: [
        order({
          id: 'open-1',
          type: 'LIMIT',
          status: 'OPEN',
          limitPrice: '4000',
          fillPrice: null,
          qty: '100000000',
        }),
        order({ id: 'other-coin', coin: 'ORB', status: 'OPEN' }),
        order({ id: 'done-1' }),
      ],
    });
    await renderTrade('NXC');

    const open = await screen.findByRole('list', { name: 'Open orders' });
    expect(within(open).getAllByTestId('order')).toHaveLength(1);
    expect(open.textContent).toContain('Buy 1 NXC limit at $40.00');
    const recent = screen.getByRole('list', { name: 'Recent orders' });
    expect(recent.textContent).toContain('Buy 0.5 NXC market at $42.09');

    fireEvent.click(within(open).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(calls.cancelled).toEqual(['open-1']));
  });

  it('says so for a coin that does not exist', async () => {
    await renderTrade('DOGE');
    expect(screen.getByText(/There is no coin called DOGE/)).toBeTruthy();
  });
});

describe('TradePage for a real coin', () => {
  const livePrice = () =>
    screen.findByText('$60,000.00', {
      selector: '[data-testid="live-price"]',
    });

  it('shows where the price comes from, and when that is the fallback', async () => {
    backend({ btcSource: 'binance' });
    await renderTrade('BTC');
    await livePrice();
    expect(screen.getByTestId('source').textContent).toBe('Binance');
    cleanup();

    backend({ btcSource: 'coinbase' });
    await renderTrade('BTC');
    await livePrice();
    expect(screen.getByTestId('source').textContent).toBe(
      'Coinbase · fallback',
    );
  });

  it('asks for no quote without a price, but takes a limit order', async () => {
    const calls = backend({ tickAgeMs: 30_000 });
    await renderTrade('BTC');

    await screen.findByText('Price unavailable', {
      selector: '[data-testid="live-price"]',
    });
    expect(screen.queryByTestId('source')).toBeNull();
    expect(screen.getByTestId('price-unavailable').textContent).toContain(
      'market orders are off',
    );
    const getQuote = within(form()).getByRole('button', { name: 'Get quote' });
    expect((getQuote as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(form());
    expect(calls.quotes).toEqual([]);

    fireEvent.click(within(form()).getByRole('radio', { name: 'Limit' }));
    expect(screen.queryByTestId('price-unavailable')).toBeNull();
    fireEvent.change(within(form()).getByLabelText('Quantity (BTC)'), {
      target: { value: '0.001' },
    });
    fireEvent.change(within(form()).getByLabelText(/Limit price/), {
      target: { value: '55000' },
    });
    click('Place limit buy');
    await waitFor(() =>
      expect(calls.placed.map((p) => p.input)).toEqual([
        {
          type: 'LIMIT',
          coin: 'BTC',
          side: 'BUY',
          qty: '100000',
          limitPrice: '5500000',
        },
      ]),
    );
  });

  it('drops the quote when the price goes stale while the page is open', async () => {
    // 8 s old: available now, stale (over 10 s) two seconds later.
    const calls = backend({ tickAgeMs: 8_000 });
    await renderTrade('BTC');
    await livePrice();
    fireEvent.change(within(form()).getByLabelText('Quantity (BTC)'), {
      target: { value: '0.001' },
    });
    click('Get quote');
    await screen.findByTestId('quote');

    await screen.findByText(
      'Price unavailable',
      { selector: '[data-testid="live-price"]' },
      { timeout: 4_000 },
    );
    expect(screen.queryByTestId('quote')).toBeNull();
    expect(screen.getByTestId('price-unavailable')).toBeTruthy();
    expect(calls.quotes).toHaveLength(1);
  });
});

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';

import { Toaster } from '../../components/ui/toaster';
import { RealtimeProvider } from '../../lib/realtime/realtime';
import { fakeRealtime } from '../../testing/fake-socket';
import { walletKeys } from '../wallet/wallet-api';
import { marketKeys } from './market-api';
import { fillText, useUserFeed } from './use-user-feed';

function Feed() {
  useUserFeed();
  return <Toaster />;
}

function setup() {
  const fake = fakeRealtime();
  const queryClient = new QueryClient();
  queryClient.setQueryData(walletKeys.balances, [
    { asset: 'USD', available: '10000', held: '0' },
  ]);
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <RealtimeProvider value={fake.realtime}>
        <Feed />
      </RealtimeProvider>
    </QueryClientProvider>,
  );
  fake.client.start();
  act(() => fake.latest().welcome(7));
  invalidate.mockClear();
  return { ...fake, queryClient, invalidate };
}

describe('useUserFeed', () => {
  it('writes balance messages into the balances query, adding a new asset', () => {
    const { latest, queryClient } = setup();

    act(() => {
      latest().message('user.7', 10, {
        type: 'balance',
        asset: 'USD',
        available: '7590',
        held: '1005',
      });
      latest().message('user.7', 11, {
        type: 'balance',
        asset: 'NXC',
        available: '10000000',
        held: '0',
      });
    });

    expect(queryClient.getQueryData(walletKeys.balances)).toEqual([
      { asset: 'USD', available: '7590', held: '1005' },
      { asset: 'NXC', available: '10000000', held: '0' },
    ]);
  });

  it('refreshes orders, positions and history on a fill, and says what was traded', () => {
    const { latest, invalidate } = setup();

    act(() =>
      latest().message('user.7', 12, {
        type: 'fill',
        orderId: 'o-1',
        coin: 'NXC',
        side: 'BUY',
        qty: '10000000',
        usdAmount: '421',
        fee: '3',
      }),
    );

    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual([
      marketKeys.orders,
      walletKeys.positions,
      walletKeys.entries,
    ]);
    expect(screen.getByTestId('toast').textContent).toContain(
      'Bought 0.1 NXC for $4.24',
    );
  });

  it('refetches everything the user owns after a resync', () => {
    const { latest, invalidate } = setup();

    act(() => latest().frame({ type: 'resync' }));

    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toEqual([
      walletKeys.all,
      marketKeys.orders,
    ]);
  });
});

it('fillText takes the fee out of a sale', () => {
  expect(
    fillText({
      type: 'fill',
      orderId: 'o',
      coin: 'ORB',
      side: 'SELL',
      qty: '200000000',
      usdAmount: '62000',
      fee: '310',
    }),
  ).toBe('Sold 2 ORB for $616.90');
});

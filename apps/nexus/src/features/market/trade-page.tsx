import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type ReactNode, Suspense, lazy, useMemo } from 'react';
import { COINS } from '@jobber/money';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FormError } from '../../components/ui/field';
import { errorMessages } from '../../lib/errors';
import { formatCoin, formatMinorUnits, formatPrice } from '../../lib/money';
import { usePrice } from '../../lib/realtime/realtime';
import { fetchBalances, walletKeys } from '../wallet/wallet-api';
import { toBars } from './bars';
import {
  type Order,
  cancelOrder,
  fetchCandles,
  fetchCoins,
  fetchOrders,
  marketKeys,
} from './market-api';
import { useSeedPrices } from './markets-page';
import { OrderForm } from './order-form';

// lightweight-charts is the app's biggest dependency and only this page draws a chart: load it
// with the page, not with the app.
const PriceChart = lazy(() =>
  import('./price-chart').then((m) => ({ default: m.PriceChart })),
);

const OPEN_STATUSES = new Set(['OPEN', 'PLACING']);

const STATUS_TEXT: Record<string, string> = {
  PLACING: 'Placing',
  OPEN: 'Open',
  SETTLING: 'Settling',
  FILLED: 'Filled',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
  REJECTED: 'Rejected',
};

/** One coin: its chart with live ticks, the order form, balances, and the user's orders. */
export function TradePage({ coin }: { coin: string }) {
  if (!(COINS as readonly string[]).includes(coin)) {
    return (
      <Card title="Unknown coin">
        <p className="text-slate-600">
          There is no coin called {coin}.{' '}
          <Link to="/markets" className="font-medium text-slate-900 underline">
            See the markets
          </Link>
        </p>
      </Card>
    );
  }
  return <Trade coin={coin} />;
}

function Trade({ coin }: { coin: string }) {
  const coins = useQuery({ queryKey: marketKeys.coins, queryFn: fetchCoins });
  useSeedPrices(coins.data);
  const tick = usePrice(coin);
  const candles = useQuery({
    queryKey: marketKeys.candles(coin),
    queryFn: () => fetchCandles(coin),
  });
  const bars = useMemo(() => toBars(candles.data ?? []), [candles.data]);
  const name = coins.data?.find((c) => c.code === coin)?.name;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">
          {coin}{' '}
          {name && (
            <span className="text-base font-normal text-slate-500">{name}</span>
          )}
        </h1>
        <p
          className="text-2xl font-semibold tabular-nums"
          data-testid="live-price"
        >
          {tick ? formatPrice(tick.price) : '—'}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          {candles.isError && (
            <FormError message={errorMessages(candles.error).join('\n')} />
          )}
          <Suspense fallback={<div className="h-80 w-full" />}>
            <PriceChart bars={bars} tick={tick} />
          </Suspense>
        </Card>
        <div className="space-y-6">
          <Card title="Trade">
            <OrderForm coin={coin} />
          </Card>
          <BalancesCard coin={coin} />
        </div>
      </div>
      <OrdersCard coin={coin} />
    </div>
  );
}

function BalancesCard({ coin }: { coin: string }) {
  const balances = useQuery({
    queryKey: walletKeys.balances,
    queryFn: fetchBalances,
  });
  const row = (asset: string) =>
    balances.data?.find((b) => b.asset === asset) ?? {
      asset,
      available: '0',
      held: '0',
    };
  const usd = row('USD');
  const coinRow = row(coin);
  return (
    <Card title="Your balances">
      {balances.isError && (
        <FormError message={errorMessages(balances.error).join('\n')} />
      )}
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between" data-testid="trade-balance-USD">
          <dt className="text-slate-500">USD</dt>
          <dd className="tabular-nums">
            {formatMinorUnits(usd.available, 'USD')}
            {usd.held !== '0' && (
              <span className="text-slate-500">
                {' '}
                + {formatMinorUnits(usd.held, 'USD')} held
              </span>
            )}
          </dd>
        </div>
        <div
          className="flex justify-between"
          data-testid={`trade-balance-${coin}`}
        >
          <dt className="text-slate-500">{coin}</dt>
          <dd className="tabular-nums">
            {formatCoin(coinRow.available, coin)}
            {coinRow.held !== '0' && (
              <span className="text-slate-500">
                {' '}
                + {formatCoin(coinRow.held, coin)} held
              </span>
            )}
          </dd>
        </div>
      </dl>
    </Card>
  );
}

function OrdersCard({ coin }: { coin: string }) {
  const queryClient = useQueryClient();
  const orders = useQuery({
    queryKey: marketKeys.orders,
    queryFn: fetchOrders,
  });
  const cancel = useMutation({
    mutationFn: cancelOrder,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: marketKeys.orders });
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
    },
  });
  const mine = (orders.data ?? []).filter((o) => o.coin === coin);
  const open = mine.filter((o) => OPEN_STATUSES.has(o.status));
  const recent = mine.filter((o) => !OPEN_STATUSES.has(o.status)).slice(0, 10);

  return (
    <Card title="Orders">
      {orders.isError && (
        <FormError message={errorMessages(orders.error).join('\n')} />
      )}
      {cancel.isError && (
        <FormError message={errorMessages(cancel.error).join('\n')} />
      )}
      <h3 className="mb-2 text-sm font-medium text-slate-500">Open</h3>
      {open.length === 0 ? (
        <p className="mb-4 text-sm text-slate-500">No open orders.</p>
      ) : (
        <ul className="mb-4 divide-y divide-slate-100" aria-label="Open orders">
          {open.map((order) => (
            <OrderRow key={order.id} order={order}>
              <Button
                variant="ghost"
                className="h-8 px-3"
                disabled={order.status !== 'OPEN' || cancel.isPending}
                onClick={() => cancel.mutate(order.id)}
              >
                Cancel
              </Button>
            </OrderRow>
          ))}
        </ul>
      )}
      <h3 className="mb-2 text-sm font-medium text-slate-500">Recent</h3>
      {recent.length === 0 ? (
        <p className="text-sm text-slate-500">No orders yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100" aria-label="Recent orders">
          {recent.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function OrderRow({ order, children }: { order: Order; children?: ReactNode }) {
  const price = order.fillPrice ?? order.limitPrice;
  return (
    <li
      className="flex items-center justify-between gap-4 py-2 text-sm"
      data-testid="order"
    >
      <span>
        <span className="font-medium">
          {order.side === 'BUY' ? 'Buy' : 'Sell'}{' '}
          {formatCoin(order.qty, order.coin)}
        </span>{' '}
        <span className="text-slate-500">
          {order.type === 'LIMIT' ? 'limit' : 'market'}
          {price ? ` at ${formatPrice(price)}` : ''}
        </span>
      </span>
      <span className="flex items-center gap-3">
        <span title={order.reason ?? undefined}>
          {STATUS_TEXT[order.status]}
        </span>
        {children}
      </span>
    </li>
  );
}

import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect } from 'react';

import { Card } from '../../components/ui/card';
import { FormError } from '../../components/ui/field';
import { cn } from '../../lib/cn';
import { errorMessages } from '../../lib/errors';
import { formatPrice } from '../../lib/money';
import { usePrice, useRealtime } from '../../lib/realtime/realtime';
import { type MarketCoin, fetchCoins, marketKeys } from './market-api';

/** Every coin with its live price and the change since 24 hours ago. */
export function MarketsPage() {
  const coins = useQuery({ queryKey: marketKeys.coins, queryFn: fetchCoins });
  useSeedPrices(coins.data);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Markets</h1>
      <Card>
        {coins.isPending && <p className="text-slate-500">Loading…</p>}
        {coins.isError && (
          <FormError message={errorMessages(coins.error).join('\n')} />
        )}
        {coins.data && (
          <table className="w-full text-left" aria-label="Markets">
            <thead className="text-sm text-slate-500">
              <tr>
                <th className="pb-3 font-medium">Coin</th>
                <th className="pb-3 text-right font-medium">Price</th>
                <th className="pb-3 text-right font-medium">24h</th>
                <th className="pb-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {coins.data.map((coin) => (
                <CoinRow key={coin.code} coin={coin} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/** Puts the snapshot's ticks in the price book, so prices show before the first live tick. */
export function useSeedPrices(coins: MarketCoin[] | undefined) {
  const { prices } = useRealtime();
  useEffect(() => {
    for (const coin of coins ?? []) {
      if (coin.tick) {
        prices.set(coin.code, {
          price: coin.tick.price,
          seq: coin.tick.seq,
          at: Date.parse(coin.tick.at),
        });
      }
    }
  }, [coins, prices]);
}

function CoinRow({ coin }: { coin: MarketCoin }) {
  const tick = usePrice(coin.code);
  const change = changePercent(tick?.price, coin.open24h);
  return (
    <tr data-testid={`coin-${coin.code}`}>
      <td className="py-3">
        <p className="font-medium">{coin.code}</p>
        <p className="text-sm text-slate-500">{coin.name}</p>
      </td>
      <td
        className="py-3 text-right font-medium tabular-nums"
        data-testid="price"
      >
        {tick ? formatPrice(tick.price) : '—'}
      </td>
      <td
        className={cn(
          'py-3 text-right tabular-nums',
          change === undefined && 'text-slate-400',
          change !== undefined && change >= 0 && 'text-emerald-700',
          change !== undefined && change < 0 && 'text-red-600',
        )}
        data-testid="change"
      >
        {change === undefined
          ? '—'
          : `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`}
      </td>
      <td className="py-3 text-right">
        <Link
          to="/trade/$coin"
          params={{ coin: coin.code }}
          className="text-sm font-medium text-slate-900 underline"
        >
          Trade
        </Link>
      </td>
    </tr>
  );
}

/** The change from `open` to `price`, in percent; undefined without both. */
export function changePercent(
  price: string | undefined,
  open: string | null | undefined,
): number | undefined {
  if (!price || !open || open === '0') {
    return undefined;
  }
  return ((Number(price) - Number(open)) / Number(open)) * 100;
}

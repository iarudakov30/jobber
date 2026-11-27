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
import {
  SourceBadge,
  isPriceAvailable,
  sourceLabel,
  useNow,
} from './price-status';

/**
 * Every coin with its live price and the change since 24 hours ago, in two groups: real coins
 * (priced by an exchange, with a badge saying which) and simulated ones.
 */
export function MarketsPage() {
  const coins = useQuery({ queryKey: marketKeys.coins, queryFn: fetchCoins });
  useSeedPrices(coins.data);
  const now = useNow();

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Markets</h1>
      {coins.isPending && (
        <Card>
          <p className="text-slate-500">Loading…</p>
        </Card>
      )}
      {coins.isError && (
        <Card>
          <FormError message={errorMessages(coins.error).join('\n')} />
        </Card>
      )}
      {coins.data && (
        <>
          <CoinGroup
            title="Real prices"
            coins={coins.data.filter((c) => c.live)}
            now={now}
          />
          <CoinGroup
            title="Simulated"
            coins={coins.data.filter((c) => !c.live)}
            now={now}
          />
        </>
      )}
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
          source: coin.tick.source,
        });
      }
    }
  }, [coins, prices]);
}

function CoinGroup({
  title,
  coins,
  now,
}: {
  title: string;
  coins: MarketCoin[];
  now: number;
}) {
  if (coins.length === 0) {
    return null;
  }
  return (
    <Card title={title}>
      <table className="w-full text-left" aria-label={title}>
        <thead className="text-sm text-slate-500">
          <tr>
            <th className="pb-3 font-medium">Coin</th>
            <th className="pb-3 text-right font-medium">Price</th>
            <th className="pb-3 text-right font-medium">24h</th>
            <th className="pb-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {coins.map((coin) => (
            <CoinRow key={coin.code} coin={coin} now={now} />
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function CoinRow({ coin, now }: { coin: MarketCoin; now: number }) {
  const tick = usePrice(coin.code);
  const available = isPriceAvailable(tick, now);
  const change = available
    ? changePercent(tick.price, coin.open24h)
    : undefined;
  return (
    <tr data-testid={`coin-${coin.code}`}>
      <td className="py-3">
        <p className="flex items-center gap-2 font-medium">
          {coin.code}
          {available && <SourceBadge label={sourceLabel(coin, tick)} />}
        </p>
        <p className="text-sm text-slate-500">{coin.name}</p>
      </td>
      <td
        className={cn(
          'py-3 text-right tabular-nums',
          available ? 'font-medium' : 'text-sm text-slate-500',
        )}
        data-testid="price"
      >
        {available ? formatPrice(tick.price) : 'Price unavailable'}
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

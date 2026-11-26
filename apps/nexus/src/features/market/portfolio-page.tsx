import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { Card } from '../../components/ui/card';
import { FormError } from '../../components/ui/field';
import { cn } from '../../lib/cn';
import { errorMessages } from '../../lib/errors';
import { formatCoin, formatMinorUnits, formatPrice } from '../../lib/money';
import { usePrice } from '../../lib/realtime/realtime';
import {
  type Position,
  fetchBalances,
  fetchPositions,
  walletKeys,
} from '../wallet/wallet-api';
import { fetchCoins, marketKeys } from './market-api';
import { useSeedPrices } from './markets-page';

const COIN_UNIT = 100_000_000n;

/** The value of `qty` coins at `price` cents per coin, in cents (rounded down). */
export function valueOf(qty: string, price: string): bigint {
  return (BigInt(qty) * BigInt(price)) / COIN_UNIT;
}

/** The user's coins valued at live prices, with profit or loss against what they cost. */
export function PortfolioPage() {
  const positions = useQuery({
    queryKey: walletKeys.positions,
    queryFn: fetchPositions,
  });
  const balances = useQuery({
    queryKey: walletKeys.balances,
    queryFn: fetchBalances,
  });
  const coins = useQuery({ queryKey: marketKeys.coins, queryFn: fetchCoins });
  useSeedPrices(coins.data);
  const usd = balances.data?.find((b) => b.asset === 'USD');

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Portfolio</h1>
      <Card title="Coins">
        {positions.isPending && <p className="text-slate-500">Loading…</p>}
        {positions.isError && (
          <FormError message={errorMessages(positions.error).join('\n')} />
        )}
        {positions.data?.length === 0 && (
          <p className="text-slate-500">
            No coins yet.{' '}
            <Link
              to="/markets"
              className="font-medium text-slate-900 underline"
            >
              Buy some
            </Link>
          </p>
        )}
        {!!positions.data?.length && (
          <table className="w-full text-left text-sm" aria-label="Positions">
            <thead className="text-slate-500">
              <tr>
                <th className="pb-3 font-medium">Coin</th>
                <th className="pb-3 text-right font-medium">Quantity</th>
                <th className="pb-3 text-right font-medium">Avg. cost</th>
                <th className="pb-3 text-right font-medium">Price</th>
                <th className="pb-3 text-right font-medium">Value</th>
                <th className="pb-3 text-right font-medium">P/L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {positions.data.map((position) => (
                <PositionRow key={position.coin} position={position} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Cash">
        <p className="text-2xl font-semibold tabular-nums" data-testid="cash">
          {usd ? formatMinorUnits(usd.available, 'USD') : '—'}
        </p>
        {usd && usd.held !== '0' && (
          <p className="text-sm text-slate-500">
            {formatMinorUnits(usd.held, 'USD')} held for limit orders
          </p>
        )}
      </Card>
    </div>
  );
}

function PositionRow({ position }: { position: Position }) {
  const tick = usePrice(position.coin);
  const value = tick ? valueOf(position.qty, tick.price) : undefined;
  const pl =
    value === undefined ? undefined : value - BigInt(position.costBasis);
  return (
    <tr data-testid={`position-${position.coin}`}>
      <td className="py-3 font-medium">{position.coin}</td>
      <td className="py-3 text-right tabular-nums">
        {formatCoin(position.qty, position.coin)}
      </td>
      <td className="py-3 text-right tabular-nums">
        {formatPrice(position.averagePrice)}
      </td>
      <td className="py-3 text-right tabular-nums">
        {tick ? formatPrice(tick.price) : '—'}
      </td>
      <td className="py-3 text-right tabular-nums" data-testid="value">
        {value === undefined ? '—' : formatMinorUnits(value.toString(), 'USD')}
      </td>
      <td
        className={cn(
          'py-3 text-right tabular-nums',
          pl !== undefined && pl >= 0n && 'text-emerald-700',
          pl !== undefined && pl < 0n && 'text-red-600',
        )}
        data-testid="pl"
      >
        {pl === undefined
          ? '—'
          : `${pl >= 0n ? '+' : ''}${formatMinorUnits(pl.toString(), 'USD')}`}
      </td>
    </tr>
  );
}

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { FormError } from '../../components/ui/field';
import { cn } from '../../lib/cn';
import { errorMessages } from '../../lib/errors';
import { formatMinorUnits } from '../../lib/money';
import {
  type LedgerEntry,
  fetchBalances,
  fetchEntries,
  walletKeys,
} from './wallet-api';

const TYPE_LABELS: Record<string, string> = {
  seed: 'Test funds',
  transfer: 'Transfer',
  topup: 'Top-up',
};

const dateFormat = new Intl.DateTimeFormat('en-US', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

export function WalletPage() {
  const balances = useQuery({
    queryKey: walletKeys.balances,
    queryFn: fetchBalances,
  });
  const history = useInfiniteQuery({
    queryKey: walletKeys.entries,
    queryFn: ({ pageParam }) => fetchEntries(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Wallet</h1>
        <Link
          to="/send"
          className="inline-flex h-10 items-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800"
        >
          Send money
        </Link>
      </div>

      <Card title="Balances">
        {balances.isPending && <p className="text-slate-500">Loading…</p>}
        {balances.isError && (
          <FormError message={errorMessages(balances.error).join('\n')} />
        )}
        {balances.data && (
          <dl className="grid gap-4 sm:grid-cols-2">
            {balances.data.map((balance) => (
              <div key={balance.asset} data-testid={`balance-${balance.asset}`}>
                <dt className="text-sm text-slate-500">
                  {balance.asset} available
                </dt>
                <dd className="text-3xl font-semibold tabular-nums">
                  {formatMinorUnits(balance.available, balance.asset)}
                </dd>
                {balance.held !== '0' && (
                  <dd className="text-sm text-slate-500">
                    {formatMinorUnits(balance.held, balance.asset)} held
                  </dd>
                )}
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card title="History">
        {history.isPending && <p className="text-slate-500">Loading…</p>}
        {history.isError && (
          <FormError message={errorMessages(history.error).join('\n')} />
        )}
        {history.isSuccess && entries.length === 0 && (
          <p className="text-slate-500">No transactions yet.</p>
        )}
        {entries.length > 0 && (
          <ul className="divide-y divide-slate-100" aria-label="History">
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} />
            ))}
          </ul>
        )}
        {history.hasNextPage && (
          <Button
            variant="ghost"
            className="mt-4 w-full"
            disabled={history.isFetchingNextPage}
            onClick={() => history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
      </Card>
    </div>
  );
}

function EntryRow({ entry }: { entry: LedgerEntry }) {
  const incoming = !entry.amount.startsWith('-');
  return (
    <li className="flex items-center justify-between py-3">
      <div>
        <p className="font-medium">{TYPE_LABELS[entry.type] ?? entry.type}</p>
        <p className="text-sm text-slate-500">
          {dateFormat.format(new Date(entry.createdAt))}
        </p>
      </div>
      <p
        className={cn(
          'font-medium tabular-nums',
          incoming ? 'text-emerald-700' : 'text-slate-900',
        )}
      >
        {incoming ? '+' : ''}
        {formatMinorUnits(entry.amount, entry.asset)}
      </p>
    </li>
  );
}

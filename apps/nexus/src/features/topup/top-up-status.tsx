import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { errorMessages } from '../../lib/errors';
import { formatMinorUnits } from '../../lib/money';
import { fetchTopUpEntry, walletKeys } from '../wallet/wallet-api';
import { fetchPayment, topUpKeys } from './topup-api';

/** Poll once a second for up to 30 s (spec); phase 4's realtime feed replaces this. */
export const POLL_MS = 1_000;
export const MAX_POLLS = 30;

type Tone = 'info' | 'success' | 'error';

/**
 * What became of a top-up, on the wallet page Stripe returns to (`/wallet?topup=<id>`).
 *
 * Two waits, both by polling: `payments` turns the payment SUCCEEDED when Stripe's webhook
 * arrives, and the wallet credits it a moment later (through Pulsar). Balances are refreshed
 * only after the second, so the page never shows SUCCEEDED next to the old balance.
 */
export function TopUpStatus({
  paymentId,
  onDismiss,
  pollMs = POLL_MS,
  maxPolls = MAX_POLLS,
}: {
  paymentId: string;
  onDismiss: () => void;
  pollMs?: number;
  maxPolls?: number;
}) {
  const queryClient = useQueryClient();
  const payment = useQuery({
    queryKey: topUpKeys.payment(paymentId),
    queryFn: () => fetchPayment(paymentId),
    refetchInterval: (query) =>
      query.state.data?.status === 'PENDING' &&
      query.state.dataUpdateCount < maxPolls
        ? pollMs
        : false,
  });
  const succeeded = payment.data?.status === 'SUCCEEDED';
  const credit = useQuery({
    queryKey: topUpKeys.credit(paymentId),
    queryFn: () => fetchTopUpEntry(paymentId),
    enabled: succeeded,
    refetchInterval: (query) =>
      query.state.data === null && query.state.dataUpdateCount < maxPolls
        ? pollMs
        : false,
  });
  const credited = !!credit.data;
  // Polling stops after maxPolls answers. The count lives in the query cache, not on the
  // result; `isFetching` (read here) re-renders the page after every poll.
  const gaveUp = (
    query: typeof payment | typeof credit,
    key: readonly unknown[],
  ) =>
    !query.isFetching &&
    (queryClient.getQueryState(key)?.dataUpdateCount ?? 0) >= maxPolls;

  useEffect(() => {
    if (credited) {
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
    }
  }, [credited, queryClient]);

  const { tone, message } = describe();

  function describe(): { tone: Tone; message: string } {
    if (payment.isError) {
      return {
        tone: 'error',
        message: errorMessages(payment.error).join('\n'),
      };
    }
    if (payment.isPending) {
      return { tone: 'info', message: 'Checking your top-up…' };
    }
    const found = payment.data;
    if (!found) {
      return { tone: 'error', message: 'This top-up was not found.' };
    }
    const amount = formatMinorUnits(found.amount, found.currency);
    switch (found.status) {
      case 'EXPIRED':
        return {
          tone: 'error',
          message: `Your ${amount} top-up expired before it was paid. Nothing was charged.`,
        };
      case 'FAILED':
        return {
          tone: 'error',
          message: `Your ${amount} top-up could not be started. Nothing was charged.`,
        };
      case 'PENDING':
        return !gaveUp(payment, topUpKeys.payment(paymentId))
          ? {
              tone: 'info',
              message: `Waiting for Stripe to confirm ${amount}…`,
            }
          : {
              tone: 'info',
              message: `Stripe hasn't confirmed your ${amount} top-up yet. Your balance updates once it does.`,
            };
      case 'SUCCEEDED':
        if (credit.isError) {
          return {
            tone: 'error',
            message: errorMessages(credit.error).join('\n'),
          };
        }
        if (credited) {
          return {
            tone: 'success',
            message: `${amount} added to your wallet.`,
          };
        }
        return !gaveUp(credit, topUpKeys.credit(paymentId))
          ? {
              tone: 'info',
              message: `Payment received. Adding ${amount} to your wallet…`,
            }
          : {
              tone: 'info',
              message: `Payment received. ${amount} will show in your wallet shortly.`,
            };
    }
  }

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      data-testid="topup-status"
      className={cn(
        'flex items-start justify-between gap-4 rounded-md px-4 py-3 text-sm',
        tone === 'success' && 'bg-emerald-50 text-emerald-800',
        tone === 'error' && 'bg-red-50 text-red-700',
        tone === 'info' && 'bg-slate-100 text-slate-700',
      )}
    >
      <p className="whitespace-pre-line">{message}</p>
      <Button
        variant="ghost"
        className="-my-2 h-8 shrink-0 px-2"
        onClick={onDismiss}
      >
        Dismiss
      </Button>
    </div>
  );
}

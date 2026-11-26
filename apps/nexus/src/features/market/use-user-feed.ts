import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { toasts } from '../../components/ui/toaster';
import { formatCoin, formatMinorUnits } from '../../lib/money';
import type { RealtimeMessage } from '../../lib/realtime/realtime-client';
import { useResynced, useUserMessages } from '../../lib/realtime/realtime';
import { type Balance, walletKeys } from '../wallet/wallet-api';
import { marketKeys } from './market-api';

interface BalanceMessage {
  type: 'balance';
  asset: string;
  available: string;
  held: string;
}

interface FillMessage {
  type: 'fill';
  orderId: string;
  coin: string;
  side: 'BUY' | 'SELL';
  qty: string;
  usdAmount: string;
  fee: string;
}

/**
 * Mounted once in the app shell while someone is signed in: applies the user's realtime
 * messages to the query cache.
 *
 * - `balance` (absolute values) replaces that asset's row in the balances query;
 * - `fill` refreshes orders, positions and the history, and shows a toast;
 * - `resynced` (connect, reconnect, gateway `resync`) refetches everything the user owns,
 *   because messages may have been missed.
 */
export function useUserFeed() {
  const queryClient = useQueryClient();
  useUserMessages(
    useCallback(
      (message: RealtimeMessage) => applyUserMessage(queryClient, message),
      [queryClient],
    ),
  );
  useResynced(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
      void queryClient.invalidateQueries({ queryKey: marketKeys.orders });
    }, [queryClient]),
  );
}

export function applyUserMessage(
  queryClient: QueryClient,
  { data }: RealtimeMessage,
): void {
  const message = data as BalanceMessage | FillMessage;
  if (message.type === 'balance') {
    queryClient.setQueryData<Balance[]>(walletKeys.balances, (balances) => {
      if (!balances) {
        return balances; // not fetched yet: the fetch will get it
      }
      const row = {
        asset: message.asset,
        available: message.available,
        held: message.held,
      };
      return balances.some((b) => b.asset === message.asset)
        ? balances.map((b) =>
            b.asset === message.asset ? { ...b, ...row } : b,
          )
        : [...balances, row];
    });
    return;
  }
  if (message.type === 'fill') {
    void queryClient.invalidateQueries({ queryKey: marketKeys.orders });
    void queryClient.invalidateQueries({ queryKey: walletKeys.positions });
    void queryClient.invalidateQueries({ queryKey: walletKeys.entries });
    toasts.show(fillText(message));
  }
}

export function fillText(fill: FillMessage): string {
  const qty = formatCoin(fill.qty, fill.coin);
  const total =
    BigInt(fill.usdAmount) +
    (fill.side === 'BUY' ? 1n : -1n) * BigInt(fill.fee);
  const usd = formatMinorUnits(total.toString(), 'USD');
  return fill.side === 'BUY'
    ? `Bought ${qty} for ${usd}`
    : `Sold ${qty} for ${usd}`;
}

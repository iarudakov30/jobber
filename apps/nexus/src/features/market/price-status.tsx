import { useEffect, useState } from 'react';

import type { PriceTick } from '../../lib/realtime/realtime';
import type { MarketCoin } from './market-api';

/** The market's rule (`STALE_PRICE_MS`): it won't quote a price older than this. */
export const STALE_PRICE_MS = 10_000;

const EXCHANGES: Record<string, string> = {
  binance: 'Binance',
  coinbase: 'Coinbase',
};

/**
 * The current time, every `intervalMs`: a price goes stale because nothing arrives, so the page
 * has to look at the clock, not wait for a tick.
 */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * Whether the coin can be quoted: it has a tick from the last 10 s. Compares the server's tick
 * time with this browser's clock, so a clock that is off by seconds shifts it by as much.
 */
export function isPriceAvailable(
  tick: PriceTick | undefined,
  now: number,
): tick is PriceTick {
  return !!tick && now - tick.at <= STALE_PRICE_MS;
}

/**
 * Where a real coin's price comes from, for its badge: "Binance", or "Coinbase · fallback" when
 * it isn't the coin's first exchange. Undefined for a simulated coin or without a tick.
 */
export function sourceLabel(
  coin: Pick<MarketCoin, 'live' | 'providers'> | undefined,
  tick: PriceTick | undefined,
): string | undefined {
  if (!coin?.live || !tick?.source || tick.source === 'simulator') {
    return undefined;
  }
  const name = EXCHANGES[tick.source] ?? tick.source;
  const preferred = coin.providers[0];
  return preferred && tick.source !== preferred ? `${name} · fallback` : name;
}

export function SourceBadge({ label }: { label: string | undefined }) {
  if (!label) {
    return null;
  }
  const fallback = label.endsWith('fallback');
  return (
    <span
      data-testid="source"
      className={
        fallback
          ? 'rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800'
          : 'rounded bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-600'
      }
    >
      {label}
    </span>
  );
}

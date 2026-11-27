import { Candle, MINUTE_MS } from '../candle-builder';
import { centsOf } from './cents';
import { ProviderError, ProviderName } from './price-provider';

/** GET a public JSON endpoint; anything but a 2xx JSON answer is a `ProviderError`. */
export async function getJson(
  provider: ProviderName,
  url: string,
  timeoutMs: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ProviderError(provider, `GET ${path(url)}: ${reason(error)}`);
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ProviderError(
      provider,
      `GET ${path(url)} answered ${response.status}: ${body.slice(0, 200)}`,
      response.status,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderError(provider, `GET ${path(url)} answered non-JSON`);
  }
}

/** The first whole minute at or after `at`. */
export function ceilToMinute(at: number): number {
  return Math.ceil(at / MINUTE_MS) * MINUTE_MS;
}

/**
 * A candle from an exchange's decimal OHLC values, or null when it isn't one the `candles`
 * table would accept (low above open or close, high below them, a zero price).
 */
export function toCandle(
  coin: string,
  start: number,
  ohlc: { open: unknown; high: unknown; low: unknown; close: unknown },
): Candle | null {
  let open: bigint, high: bigint, low: bigint, close: bigint;
  try {
    open = centsOf(ohlc.open as string | number);
    high = centsOf(ohlc.high as string | number);
    low = centsOf(ohlc.low as string | number);
    close = centsOf(ohlc.close as string | number);
  } catch {
    return null;
  }
  const real =
    Number.isSafeInteger(start) &&
    start % MINUTE_MS === 0 &&
    low > 0n &&
    low <= open &&
    low <= close &&
    high >= open &&
    high >= close;
  return real ? { coin, start: new Date(start), open, high, low, close } : null;
}

/** Candles by start, one per minute (the last one wins), oldest first. */
export function sortedUnique(candles: Candle[]): Candle[] {
  const byStart = new Map<number, Candle>();
  for (const candle of candles) {
    byStart.set(candle.start.getTime(), candle);
  }
  return [...byStart.values()].sort(
    (a, b) => a.start.getTime() - b.start.getTime(),
  );
}

function path(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return url;
  }
}

function reason(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    return cause instanceof Error
      ? `${error.message} (${cause.message})`
      : error.message;
  }
  return String(error);
}

import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { parseAmount, toWire } from '@jobber/money';

import { Button } from '../../components/ui/button';
import { Field, FormError } from '../../components/ui/field';
import { FormSuccess } from '../../components/ui/form-success';
import { Input } from '../../components/ui/input';
import { cn } from '../../lib/cn';
import { errorMessages } from '../../lib/errors';
import { graphqlErrorCode } from '../../lib/graphql';
import { formatCoin, formatMinorUnits, formatPrice } from '../../lib/money';
import { walletKeys } from '../wallet/wallet-api';
import {
  type Order,
  type Quote,
  marketKeys,
  placeOrder,
  requestQuote,
} from './market-api';

type Side = 'BUY' | 'SELL';
type Kind = 'MARKET' | 'LIMIT';

/** The wallet's refusals, in words for this form. */
function rejection(order: Order): string {
  const reason = order.reason ?? '';
  const asset = /^insufficient (\w+)$/.exec(reason)?.[1];
  return asset
    ? `Not enough ${asset} in your wallet.`
    : `The order was rejected: ${reason || 'unknown reason'}.`;
}

function done(order: Order): string {
  const qty = formatCoin(order.qty, order.coin);
  const verb = order.side === 'BUY' ? 'Bought' : 'Sold';
  switch (order.status) {
    case 'FILLED':
      return `${verb} ${qty} for ${formatMinorUnits(order.total, 'USD')}.`;
    case 'OPEN':
      return `Limit order placed: ${order.side === 'BUY' ? 'buy' : 'sell'} ${qty} at ${formatPrice(order.limitPrice ?? '0')}.`;
    default:
      return `Order received; it will show under Orders once the wallet confirms it.`;
  }
}

/** The current time, ticking every 250 ms while `active`; `restart` sets it to now at once. */
function useClock(active: boolean): [number, () => void] {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  return [now, () => setNow(Date.now())];
}

/**
 * Market and limit orders for one coin.
 *
 * A market order needs a quote first: it holds for 10 s, counted down here, and is asked for
 * again when it runs out (as long as nothing in the form changed). The quote's id is the order's
 * `Idempotency-Key`, so a retry of the same quote can't trade twice. A limit order gets one key
 * per side, quantity and price, kept until it is placed.
 *
 * Without a price (`priceAvailable` false: no tick for 10 s), the market can't quote: the form
 * says so, drops any quote and asks for none. A limit order can still be placed; it fills once
 * prices are back.
 */
export function OrderForm({
  coin,
  priceAvailable = true,
}: {
  coin: string;
  priceAvailable?: boolean;
}) {
  const queryClient = useQueryClient();
  const [side, setSide] = useState<Side>('BUY');
  const [kind, setKind] = useState<Kind>('MARKET');
  const [qty, setQty] = useState('');
  const [limitPrice, setLimitPrice] = useState('');
  const [quote, setQuote] = useState<Quote>();
  const [errors, setErrors] = useState<{
    qty?: string;
    limitPrice?: string;
    form?: string;
  }>({});
  const [success, setSuccess] = useState<string>();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const limitAttempt = useRef<{ key: string; input: string } | null>(null);
  const [now, restartClock] = useClock(!!quote);
  const secondsLeft = quote
    ? Math.max(0, Math.ceil((Date.parse(quote.expiresAt) - now) / 1000))
    : undefined;

  // Anything that changes the trade makes the quote worthless.
  const reset = () => {
    setQuote(undefined);
    setSuccess(undefined);
    setErrors({});
  };

  function parsedQty(): string | undefined {
    try {
      const minor = parseAmount(qty.trim(), coin as 'NXC');
      if (minor > 0n) {
        return toWire(minor);
      }
    } catch {
      // fall through
    }
    setErrors({ qty: 'Enter a quantity like 0.5 (at most 8 decimals).' });
    return undefined;
  }

  function parsedLimit(): string | undefined {
    try {
      const minor = parseAmount(limitPrice.trim(), 'USD');
      if (minor > 0n) {
        return toWire(minor);
      }
    } catch {
      // fall through
    }
    setErrors({ limitPrice: 'Enter a price like 42.50 (at most 2 decimals).' });
    return undefined;
  }

  /** Asks for a quote; `note` is shown with it (why a new one was needed). */
  async function getQuote(amount = parsedQty(), note?: string) {
    if (!amount) {
      return;
    }
    setErrors(note ? { form: note } : {});
    try {
      const next = await requestQuote(coin, side, amount);
      restartClock();
      setQuote(next);
    } catch (error) {
      setQuote(undefined);
      setErrors(errorsFrom(error));
    }
  }

  // Re-quote when the countdown reaches 0.
  useEffect(() => {
    if (quote && secondsLeft === 0 && !inFlight.current && priceAvailable) {
      void getQuote(quote.qty);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secondsLeft]);

  // A quote on a price that has gone stale is worthless, and the market would refuse a new one.
  // Adjusted while rendering (not in an effect), so the stale quote is never on screen.
  const [hadPrice, setHadPrice] = useState(priceAvailable);
  if (hadPrice !== priceAvailable) {
    setHadPrice(priceAvailable);
    if (!priceAvailable) {
      setQuote(undefined);
    }
  }

  const quoteBlocked = kind === 'MARKET' && !priceAvailable;

  async function run(work: () => Promise<Order | undefined>) {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setSuccess(undefined);
    setErrors({});
    try {
      const order = await work();
      if (!order) {
        return;
      }
      if (order.status === 'REJECTED') {
        setErrors({ form: rejection(order) });
      } else {
        setSuccess(done(order));
        setQty('');
        setLimitPrice('');
      }
      setQuote(undefined);
      // The user feed refreshes these too; without a socket this keeps the page right.
      void queryClient.invalidateQueries({ queryKey: marketKeys.orders });
      void queryClient.invalidateQueries({ queryKey: walletKeys.all });
    } catch (error) {
      if (graphqlErrorCode(error) === 'QUOTE_EXPIRED' && quote) {
        await getQuote(quote.qty, 'The quote expired. Here is a new one.');
      } else {
        setErrors(errorsFrom(error));
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const submitMarket = () =>
    run(async () =>
      quote
        ? placeOrder({ type: 'MARKET', quoteId: quote.id }, quote.id)
        : undefined,
    );

  const submitLimit = () =>
    run(async () => {
      const amount = parsedQty();
      const price = amount && parsedLimit();
      if (!amount || !price) {
        return undefined;
      }
      const input = JSON.stringify([side, amount, price]);
      if (limitAttempt.current?.input !== input) {
        limitAttempt.current = { key: crypto.randomUUID(), input };
      }
      const order = await placeOrder(
        { type: 'LIMIT', coin, side, qty: amount, limitPrice: price },
        limitAttempt.current.key,
      );
      limitAttempt.current = null;
      return order;
    });

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (kind === 'LIMIT') {
      void submitLimit();
    } else if (!priceAvailable) {
      return;
    } else if (quote) {
      void submitMarket();
    } else {
      void getQuote();
    }
  };

  const action = side === 'BUY' ? 'Buy' : 'Sell';

  return (
    <form
      onSubmit={onSubmit}
      noValidate
      className="space-y-4"
      aria-label="Order"
    >
      <Toggle
        label="Side"
        value={side}
        options={[
          ['BUY', 'Buy'],
          ['SELL', 'Sell'],
        ]}
        onChange={(v) => {
          setSide(v as Side);
          reset();
        }}
      />
      <Toggle
        label="Order type"
        value={kind}
        options={[
          ['MARKET', 'Market'],
          ['LIMIT', 'Limit'],
        ]}
        onChange={(v) => {
          setKind(v as Kind);
          reset();
        }}
      />
      <Field id="qty" label={`Quantity (${coin})`} error={errors.qty}>
        <Input
          id="qty"
          inputMode="decimal"
          placeholder="0.0"
          value={qty}
          aria-invalid={!!errors.qty}
          onChange={(e) => {
            setQty(e.target.value);
            reset();
          }}
        />
      </Field>
      {kind === 'LIMIT' && (
        <Field
          id="limitPrice"
          label="Limit price (USD per coin)"
          error={errors.limitPrice}
        >
          <Input
            id="limitPrice"
            inputMode="decimal"
            placeholder="0.00"
            value={limitPrice}
            aria-invalid={!!errors.limitPrice}
            onChange={(e) => {
              setLimitPrice(e.target.value);
              reset();
            }}
          />
        </Field>
      )}

      {kind === 'MARKET' && quote && (
        <dl
          className="grid grid-cols-2 gap-1 rounded-md bg-slate-50 px-3 py-2 text-sm"
          data-testid="quote"
        >
          <dt className="text-slate-500">Price</dt>
          <dd className="text-right tabular-nums">
            {formatPrice(quote.price)}
          </dd>
          <dt className="text-slate-500">Fee</dt>
          <dd className="text-right tabular-nums">
            {formatMinorUnits(quote.fee, 'USD')}
          </dd>
          <dt className="font-medium">
            {side === 'BUY' ? 'You pay' : 'You get'}
          </dt>
          <dd className="text-right font-medium tabular-nums">
            {formatMinorUnits(quote.total, 'USD')}
          </dd>
          <dd
            className="col-span-2 text-xs text-slate-500"
            data-testid="quote-countdown"
          >
            Quote valid for {secondsLeft ?? 0} s
          </dd>
        </dl>
      )}

      {quoteBlocked && (
        <p
          className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="price-unavailable"
        >
          Price unavailable: market orders are off until prices come back. A
          limit order can still be placed.
        </p>
      )}
      <FormError message={errors.form} />
      <FormSuccess message={success} />
      <Button type="submit" disabled={busy || quoteBlocked} className="w-full">
        {kind === 'LIMIT'
          ? `Place limit ${action.toLowerCase()}`
          : quote
            ? `${action} ${coin}`
            : 'Get quote'}
      </Button>
    </form>
  );
}

function errorsFrom(error: unknown): {
  qty?: string;
  limitPrice?: string;
  form?: string;
} {
  if (graphqlErrorCode(error) === 'PRICES_UNAVAILABLE') {
    return { form: 'No price right now; try again in a few seconds.' };
  }
  const messages = errorMessages(error);
  const qty = messages.find((m) => m.startsWith('qty '));
  const limitPrice = messages.find((m) => m.startsWith('limitPrice '));
  const rest = messages.filter((m) => m !== qty && m !== limitPrice);
  return {
    qty: qty && capitalize(qty),
    limitPrice: limitPrice && capitalize(limitPrice),
    form: rest.length ? rest.join('\n') : undefined,
  };
}

function capitalize(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1) + '.';
}

function Toggle({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex rounded-md bg-slate-100 p-1"
    >
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          role="radio"
          aria-checked={value === option}
          onClick={() => onChange(option)}
          className={cn(
            'flex-1 rounded px-3 py-1.5 text-sm font-medium',
            value === option
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-600 hover:text-slate-900',
          )}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

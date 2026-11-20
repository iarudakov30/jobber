import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { parseAmount, toWire } from '@jobber/money';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, FormError } from '../../components/ui/field';
import { Input } from '../../components/ui/input';
import { applyServerErrors } from '../../lib/errors';
import { graphqlErrorCode } from '../../lib/graphql';
import { createTopUp } from './topup-api';

/** The limits `payments` enforces too: USD 1.00 to 1,000.00 per top-up. */
const MIN_TOP_UP = 100n;
const MAX_TOP_UP = 100_000n;
const PRESETS = ['10', '50', '100'];

const topUpSchema = z.object({
  amount: z
    .string()
    .trim()
    .min(1, 'Amount is required.')
    .superRefine((value, ctx) => {
      let minor: bigint;
      try {
        minor = parseAmount(value, 'USD');
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Enter an amount like 50 or 12.50 (at most 2 decimals).',
        });
        return;
      }
      if (minor < MIN_TOP_UP || minor > MAX_TOP_UP) {
        ctx.addIssue({
          code: 'custom',
          message: 'Top up between $1.00 and $1,000.00.',
        });
      }
    }),
});

type TopUpValues = z.infer<typeof topUpSchema>;

/**
 * Starts a Stripe Checkout top-up and sends the browser to Stripe's page. Stripe sends it back to
 * `/wallet?topup=<paymentId>` after paying, or here after "Back".
 *
 * `goTo` exists for tests: jsdom can't navigate away.
 */
export function TopUpPage({
  goTo = (url: string) => window.location.assign(url),
}: {
  goTo?: (url: string) => void;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<TopUpValues>({
    resolver: zodResolver(topUpSchema),
    defaultValues: { amount: '' },
  });
  // One Idempotency-Key per top-up, kept while the amount stays the same: a retry after a
  // timeout returns the first Checkout session instead of starting a second payment.
  const attempt = useRef<{ key: string; amount: string } | null>(null);
  const inFlight = useRef(false);

  const startTopUp = async (values: TopUpValues) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    const amount = toWire(parseAmount(values.amount, 'USD'));
    if (attempt.current?.amount !== amount) {
      attempt.current = { key: crypto.randomUUID(), amount };
    }
    try {
      const topUp = await createTopUp(amount, attempt.current.key);
      // Stays in flight: the page is about to unload, and a second click must not start another.
      setRedirecting(true);
      goTo(topUp.checkoutUrl);
    } catch (error) {
      inFlight.current = false;
      if (graphqlErrorCode(error) === 'CONFLICT') {
        setError('root.server', {
          type: 'server',
          message: 'This top-up is still being started. Try again in a moment.',
        });
        return;
      }
      applyServerErrors(error, setError, ['amount']);
    }
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    handleSubmit(startTopUp)(event);

  const busy = isSubmitting || redirecting;
  return (
    <Card title="Top up" className="mx-auto max-w-md">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field id="amount" label="Amount (USD)" error={errors.amount?.message}>
          <Input
            id="amount"
            inputMode="decimal"
            placeholder="50.00"
            aria-invalid={!!errors.amount}
            aria-describedby={errors.amount ? 'amount-error' : undefined}
            {...register('amount')}
          />
        </Field>
        <div className="flex gap-2">
          {PRESETS.map((preset) => (
            <Button
              key={preset}
              variant="ghost"
              className="border border-slate-200"
              disabled={busy}
              onClick={() =>
                setValue('amount', preset, { shouldValidate: true })
              }
            >
              ${preset}
            </Button>
          ))}
        </div>
        <FormError message={errors.root?.server?.message} />
        <Button type="submit" disabled={busy} className="w-full">
          {redirecting
            ? 'Opening Stripe…'
            : isSubmitting
              ? 'Starting…'
              : 'Continue to payment'}
        </Button>
      </form>
      <div className="mt-6 space-y-2 text-sm text-slate-600">
        <p>
          You pay on Stripe's checkout page (test mode: card 4242 4242 4242
          4242, any future date, any CVC). The money shows in your wallet once
          Stripe confirms it.
        </p>
        <p>
          Up to $2,000.00 per 24 hours. A top-up you leave unpaid counts toward
          that until it expires, 30 minutes later.
        </p>
        <p>
          <Link
            to="/wallet"
            search={{}}
            className="font-medium text-slate-900 underline"
          >
            Back to your wallet
          </Link>
        </p>
      </div>
    </Card>
  );
}

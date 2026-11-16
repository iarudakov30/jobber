import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { parseAmount, toWire } from '@jobber/money';

import { Button } from '../../components/ui/button';
import { Card } from '../../components/ui/card';
import { Field, FormError } from '../../components/ui/field';
import { FormSuccess } from '../../components/ui/form-success';
import { Input } from '../../components/ui/input';
import { applyServerErrors, errorMessages } from '../../lib/errors';
import { graphqlErrorCode } from '../../lib/graphql';
import { formatMinorUnits } from '../../lib/money';
import { sendTransfer, walletKeys } from './wallet-api';

const sendSchema = z.object({
  toEmail: z
    .string()
    .trim()
    .min(1, 'Email is required.')
    .pipe(z.email('Enter a valid email address.')),
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
          message: 'Enter an amount like 12.50 (at most 2 decimals).',
        });
        return;
      }
      if (minor <= 0n) {
        ctx.addIssue({ code: 'custom', message: 'Enter more than $0.00.' });
      }
    }),
});

type SendValues = z.infer<typeof sendSchema>;

/** The wallet's refusals, in words for this form (the API's start with the field name). */
const FRIENDLY: Record<string, { field: keyof SendValues; message: string }> = {
  'toEmail does not belong to any user': {
    field: 'toEmail',
    message: 'No NexusPay user has this email.',
  },
  'toEmail is your own email': {
    field: 'toEmail',
    message: "You can't send money to yourself.",
  },
  'amount exceeds your available balance': {
    field: 'amount',
    message: 'Not enough money in your wallet.',
  },
};

export function SendPage() {
  const queryClient = useQueryClient();
  const [sent, setSent] = useState<string>();
  const {
    register,
    handleSubmit,
    setError,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<SendValues>({
    resolver: zodResolver(sendSchema),
    defaultValues: { toEmail: '', amount: '' },
  });
  // One Idempotency-Key per transfer: kept for retries of the same recipient and amount (after a
  // timeout or an error, the first attempt may have gone through), replaced once a transfer
  // succeeds or the input changes.
  const attempt = useRef<{ key: string; input: string } | null>(null);
  // A double click submits twice before the button re-renders as disabled.
  const inFlight = useRef(false);

  const submitTransfer = async (values: SendValues) => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setSent(undefined);
    const amount = toWire(parseAmount(values.amount, 'USD'));
    const input = JSON.stringify([values.toEmail, amount]);
    if (attempt.current?.input !== input) {
      attempt.current = { key: crypto.randomUUID(), input };
    }
    try {
      const transfer = await sendTransfer(
        { toEmail: values.toEmail, asset: 'USD', amount },
        attempt.current.key,
      );
      attempt.current = null;
      setSent(
        `Sent ${formatMinorUnits(transfer.amount, transfer.asset)} to ${values.toEmail}.`,
      );
      reset();
      await queryClient.invalidateQueries({ queryKey: walletKeys.all });
    } catch (error) {
      showError(error);
    } finally {
      inFlight.current = false;
    }
  };
  // handleSubmit is called inside the event, not during render, where the refs above may not
  // be read (react-hooks/refs can't tell that handleSubmit only stores its callback).
  const onSubmit = (event: FormEvent<HTMLFormElement>) =>
    handleSubmit(submitTransfer)(event);

  function showError(error: unknown) {
    if (graphqlErrorCode(error) === 'CONFLICT') {
      setError('root.server', {
        type: 'server',
        message:
          'This transfer is still being processed. Check your wallet before trying again.',
      });
      return;
    }
    const known = errorMessages(error)
      .map((message) => FRIENDLY[message])
      .filter(Boolean);
    if (known.length) {
      for (const { field, message } of known) {
        setError(field, { type: 'server', message });
      }
      return;
    }
    applyServerErrors(error, setError, ['toEmail', 'amount']);
  }

  return (
    <Card title="Send money" className="mx-auto max-w-md">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        <Field
          id="toEmail"
          label="Recipient's email"
          error={errors.toEmail?.message}
        >
          <Input
            id="toEmail"
            type="email"
            autoComplete="off"
            aria-invalid={!!errors.toEmail}
            aria-describedby={errors.toEmail ? 'toEmail-error' : undefined}
            {...register('toEmail')}
          />
        </Field>
        <Field id="amount" label="Amount (USD)" error={errors.amount?.message}>
          <Input
            id="amount"
            inputMode="decimal"
            placeholder="0.00"
            aria-invalid={!!errors.amount}
            aria-describedby={errors.amount ? 'amount-error' : undefined}
            {...register('amount')}
          />
        </Field>
        <FormError message={errors.root?.server?.message} />
        <FormSuccess message={sent} />
        <Button type="submit" disabled={isSubmitting} className="w-full">
          {isSubmitting ? 'Sending…' : 'Send'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-slate-600">
        <Link to="/wallet" className="font-medium text-slate-900 underline">
          Back to your wallet
        </Link>
      </p>
    </Card>
  );
}

import { PAYMENT_SUCCEEDED_TOPIC, PaymentSucceededMessage } from './messages';
import { NonRetryableError } from './pulsar.consumer';
import { validateMessage } from './validate-message';

const valid = {
  paymentId: '0b9f6d1e-6f0c-4c8e-9a51-2f4d3c1b7a90',
  userId: 7,
  amount: '5000',
  currency: 'USD',
};

describe('validateMessage(PaymentSucceededMessage)', () => {
  it('returns an instance for a valid payload', async () => {
    const message = await validateMessage(PaymentSucceededMessage, valid);

    expect(message).toBeInstanceOf(PaymentSucceededMessage);
    expect(message).toEqual(valid);
    expect(PAYMENT_SUCCEEDED_TOPIC).toBe('payment-succeeded');
  });

  it.each([
    [
      'a non-uuid paymentId',
      { paymentId: 'pay_1' },
      'paymentId must be a UUID',
    ],
    ['a zero userId', { userId: 0 }, 'userId must not be less than 1'],
    ['a string userId', { userId: '7' }, 'userId must be an integer'],
    [
      'a numeric amount',
      { amount: 5000 },
      'amount must be a positive integer string',
    ],
    [
      'a decimal amount',
      { amount: '50.00' },
      'amount must be a positive integer string',
    ],
    [
      'a zero amount',
      { amount: '0' },
      'amount must be a positive integer string',
    ],
    [
      'a negative amount',
      { amount: '-5000' },
      'amount must be a positive integer string',
    ],
    ['an unknown currency', { currency: 'EUR' }, 'currency must be one of'],
  ])('rejects %s as non-retryable', async (_, change, text) => {
    const call = validateMessage(PaymentSucceededMessage, {
      ...valid,
      ...change,
    });

    await expect(call).rejects.toBeInstanceOf(NonRetryableError);
    await expect(call).rejects.toThrow(text);
  });

  it('lists every broken field', async () => {
    await expect(
      validateMessage(PaymentSucceededMessage, { currency: 'USD' }),
    ).rejects.toThrow(/paymentId.*userId.*amount/);
  });

  it.each([null, 'text', 42, [valid]])(
    'rejects %p, which is not an object',
    async (data) => {
      await expect(
        validateMessage(PaymentSucceededMessage, data),
      ).rejects.toThrow('Invalid PaymentSucceededMessage: expected an object');
    },
  );
});

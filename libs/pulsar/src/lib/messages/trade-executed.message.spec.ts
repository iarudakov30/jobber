import { NonRetryableError } from '../pulsar.consumer';
import { validateMessage } from '../validate-message';
import {
  TRADE_EXECUTED_TOPIC,
  TradeExecutedMessage,
} from './trade-executed.message';

const valid = {
  tradeId: '3c7e1a52-8d4b-4f0e-b1a9-6e2d5c4b3a21',
  transactionId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  userId: 7,
  coin: 'NXC',
  side: 'BUY',
  qty: '150000000',
  usdAmount: '4237',
  fee: '22',
};

describe('validateMessage(TradeExecutedMessage)', () => {
  it('returns an instance for a valid payload', async () => {
    const message = await validateMessage(TradeExecutedMessage, valid);

    expect(message).toBeInstanceOf(TradeExecutedMessage);
    expect(message).toEqual(valid);
    expect(TRADE_EXECUTED_TOPIC).toBe('trade-executed');
  });

  it('accepts a zero fee', async () => {
    await expect(
      validateMessage(TradeExecutedMessage, { ...valid, fee: '0' }),
    ).resolves.toMatchObject({ fee: '0' });
  });

  it.each([
    ['a non-uuid tradeId', { tradeId: 'order-1' }, 'tradeId must be a UUID'],
    [
      'a non-uuid transactionId',
      { transactionId: '42' },
      'transactionId must be a UUID',
    ],
    ['a zero userId', { userId: 0 }, 'userId must not be less than 1'],
    ['a lowercase coin', { coin: 'nxc' }, 'coin must be an asset code'],
    ['an unknown side', { side: 'HOLD' }, 'side must be one of'],
    ['a numeric qty', { qty: 150000000 }, 'qty must be a positive integer'],
    ['a zero qty', { qty: '0' }, 'qty must be a positive integer'],
    [
      'a decimal usdAmount',
      { usdAmount: '42.37' },
      'usdAmount must be a positive integer',
    ],
    ['a negative fee', { fee: '-1' }, 'fee must be a non-negative integer'],
  ])('rejects %s as non-retryable', async (_, change, text) => {
    const call = validateMessage(TradeExecutedMessage, { ...valid, ...change });

    await expect(call).rejects.toBeInstanceOf(NonRetryableError);
    await expect(call).rejects.toThrow(text);
  });
});

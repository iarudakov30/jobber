import { ClientGrpc } from '@nestjs/microservices';
import { Observable, of, throwError } from 'rxjs';
import { GenerateCandlesResult, GrpcStatus } from '@jobber/grpc';
import {
  BackfillCandlesMessage,
  NonRetryableError,
  PulsarClient,
} from '@jobber/pulsar';
import { BackfillCandlesConsumer } from './backfill-candles.consumer';

describe('BackfillCandlesConsumer', () => {
  function consumer(generateCandles: () => Observable<GenerateCandlesResult>) {
    const market = { generateCandles: jest.fn(generateCandles) };
    const instance = new BackfillCandlesConsumer(
      {} as PulsarClient,
      {} as ClientGrpc,
      { getService: () => market } as unknown as ClientGrpc,
    );
    // Only the market client: onModuleInit would also subscribe to Pulsar.
    Object.assign(instance, { market });
    const logger = (instance as unknown as { logger: object }).logger;
    return {
      execute: (data: Partial<BackfillCandlesMessage>) =>
        (
          instance as unknown as {
            execute(d: Partial<BackfillCandlesMessage>): Promise<void>;
          }
        ).execute({
          jobId: 4,
          index: 2,
          coin: 'NXC',
          day: '2026-11-01',
          ...data,
        }),
      market,
      log: jest.spyOn(logger as never, 'log').mockImplementation(),
    };
  }

  it('asks the market for the coin-day and logs what it wrote', async () => {
    const { execute, market, log } = consumer(() => of({ written: 1_440 }));

    await execute({});

    expect(market.generateCandles).toHaveBeenCalledWith({
      coin: 'NXC',
      day: '2026-11-01',
    });
    expect(log).toHaveBeenCalledWith(
      'Backfill (job 4) NXC 2026-11-01: 1440 candle(s) written',
    );
  });

  it('dead-letters a day the market refuses', async () => {
    const { execute } = consumer(() =>
      throwError(() => ({
        code: GrpcStatus.INVALID_ARGUMENT,
        details: 'day must be 2020-01-01 or later',
      })),
    );

    await expect(execute({ day: '2019-01-01' })).rejects.toThrow(
      new NonRetryableError(
        'The market refused NXC 2019-01-01: day must be 2020-01-01 or later',
      ),
    );
  });

  it('dead-letters a live coin while the market has live prices off', async () => {
    const { execute } = consumer(() =>
      throwError(() => ({
        code: GrpcStatus.FAILED_PRECONDITION,
        details: 'live prices are off (MARKET_LIVE_PRICES)',
      })),
    );

    await expect(execute({ coin: 'BTC' })).rejects.toThrow(
      new NonRetryableError(
        'The market refused BTC 2026-11-01: live prices are off (MARKET_LIVE_PRICES)',
      ),
    );
  });

  it('fails (so Pulsar redelivers) when the market is unreachable', async () => {
    const error = Object.assign(new Error('14 UNAVAILABLE'), {
      code: GrpcStatus.UNAVAILABLE,
    });
    const { execute } = consumer(() => throwError(() => error));

    await expect(execute({})).rejects.toBe(error);
  });
});

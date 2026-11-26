import { Matches } from 'class-validator';
import { JobMessage } from './job.message';

/** The first day the market can generate (`GenerateCandles`); matches `apps/market`'s epoch. */
export const BACKFILL_FIRST_DAY = '2020-01-01';

/**
 * One item of a `BackfillCandles` job: generate one coin's 1-minute candles for one UTC day
 * (`MarketService.GenerateCandles`). The market writes only minutes without a candle, so a
 * redelivered message writes nothing. Checked by shape here; `jobs` checks the coin and the
 * day's range before creating the job, and the market checks again.
 */
export class BackfillCandlesMessage extends JobMessage {
  @Matches(/^[A-Z]{2,10}$/, { message: 'coin must be a coin code' })
  coin: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'day must be a date: YYYY-MM-DD' })
  day: string;
}

import { BadRequestException } from '@nestjs/common';
import { Jobs } from '@jobber/nestjs';
import { COINS, isCoin } from '@jobber/money';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { BACKFILL_FIRST_DAY, BackfillCandlesMessage } from '@jobber/pulsar';
import { Job } from '../../decorators/job.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { AbstractJob, MAX_JOB_ITEMS } from '../abstract.job';

const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `data` as a range: every coin (or `coins`) for every day from `from` to `to` (default yesterday). */
export interface BackfillRange {
  from: string;
  to?: string;
  coins?: string[];
}

type Item = Pick<BackfillCandlesMessage, 'coin' | 'day'>;

/**
 * Fills the charts' past: one item per coin-day, each a `GenerateCandles` call to the market from
 * the executor (generated candles for a simulated coin, the exchanges' own for BTC, ETH, HYPE and
 * ZEC; the market's 24 h fill on leadership covers their today). `data` is either a range, `{ from: "2026-11-01", to?: "2026-11-25", coins?:
 * ["NXC"] }`, which becomes one item per coin per day, or the items themselves,
 * `[{ coin: "NXC", day: "2026-11-01" }, ...]`. Days run from 2020-01-01 to yesterday (UTC); today
 * belongs to the live simulator.
 */
@Job({
  name: Jobs.BACKFILL_CANDLES,
  description:
    'Writes 1-minute candles for past days, one item per coin-day: generated for simulated coins, from the exchanges for live ones. data: { from: "YYYY-MM-DD", to?: "YYYY-MM-DD" (default yesterday), coins?: ["NXC", ...] (default all) }, or [{ coin, day }, ...].',
})
export class BackfillCandlesJob extends AbstractJob<BackfillCandlesMessage> {
  protected messageClass = BackfillCandlesMessage;

  constructor(
    prismaService: PrismaService,
    outbox: PrismaOutboxStore,
    outboxRelay: OutboxRelay,
  ) {
    super(prismaService, outbox, outboxRelay);
  }

  override execute(
    data: BackfillCandlesMessage | BackfillCandlesMessage[],
    name: string,
  ) {
    return super.execute(
      isRange(data) ? (expandRange(data) as BackfillCandlesMessage[]) : data,
      name,
    );
  }

  /** What the message's decorators can't check: the coin exists, the market can make the day. */
  protected override itemErrors(item: BackfillCandlesMessage): string[] {
    return itemErrors(item);
  }
}

function isRange(data: unknown): data is BackfillRange {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    'from' in data
  );
}

/** The latest day that can be generated: yesterday, UTC. */
function yesterday(now: number): string {
  return new Date(Math.floor(now / DAY_MS) * DAY_MS - DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** One item per coin per day of the range, oldest day first. */
export function expandRange(
  { from, to, coins }: BackfillRange,
  now = Date.now(),
): Item[] {
  const last = to ?? yesterday(now);
  for (const [field, value] of [
    ['from', from],
    ['to', last],
  ] as const) {
    if (typeof value !== 'string' || !isDate(value)) {
      throw new BadRequestException([`${field} must be a date: YYYY-MM-DD`]);
    }
  }
  const selected = coins ?? [...COINS];
  if (!Array.isArray(selected) || selected.length === 0) {
    throw new BadRequestException(['coins must be a non-empty list']);
  }
  if (from < BACKFILL_FIRST_DAY) {
    throw new BadRequestException([
      `from must be ${BACKFILL_FIRST_DAY} or later`,
    ]);
  }
  if (last > yesterday(now)) {
    throw new BadRequestException([
      'to must be before today (UTC): today belongs to the live simulator',
    ]);
  }
  const first = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${last}T00:00:00Z`);
  if (first > end) {
    throw new BadRequestException(['from must not be after to']);
  }
  const days = (end - first) / DAY_MS + 1;
  if (days * selected.length > MAX_JOB_ITEMS) {
    throw new BadRequestException([
      `A range can cover at most ${MAX_JOB_ITEMS} coin-days; this one is ${days * selected.length}.`,
    ]);
  }
  const items: Item[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(first + d * DAY_MS).toISOString().slice(0, 10);
    for (const coin of selected) {
      items.push({ coin, day });
    }
  }
  return items;
}

/**
 * The checks beyond the message's shape: the coin is one of `COINS`, the day is a real date the
 * market can generate. A value with the wrong shape is left to the decorators' message.
 */
export function itemErrors(item: Partial<Item>, now = Date.now()): string[] {
  const errors: string[] = [];
  if (
    typeof item?.coin === 'string' &&
    /^[A-Z]{2,10}$/.test(item.coin) &&
    !isCoin(item.coin)
  ) {
    errors.push(`coin must be one of: ${COINS.join(', ')}`);
  }
  const day = item?.day;
  if (typeof day === 'string' && DATE.test(day)) {
    if (!isDate(day)) {
      errors.push('day must be a date: YYYY-MM-DD');
    } else if (day < BACKFILL_FIRST_DAY) {
      errors.push(`day must be ${BACKFILL_FIRST_DAY} or later`);
    } else if (day > yesterday(now)) {
      errors.push(
        'day must be before today (UTC): today belongs to the live simulator',
      );
    }
  }
  return errors;
}

function isDate(value: string): boolean {
  return (
    DATE.test(value) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

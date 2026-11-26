import { BadRequestException } from '@nestjs/common';
import { Jobs } from '@jobber/nestjs';
import { OutboxRelay, PrismaOutboxStore } from '@jobber/outbox';
import { BackfillCandlesMessage } from '@jobber/pulsar';
import { PrismaService } from '../../prisma/prisma.service';
import { BackfillCandlesJob, expandRange } from './backfill-candles.job';

describe('BackfillCandlesJob', () => {
  function job() {
    const tx = {
      job: {
        create: jest.fn(({ data }) => Promise.resolve({ id: 21, ...data })),
      },
    };
    const outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    const instance = new BackfillCandlesJob(
      {
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      } as unknown as PrismaService,
      outbox as unknown as PrismaOutboxStore,
      { poke: jest.fn() } as unknown as OutboxRelay,
    );
    const run = (data: unknown) =>
      instance.execute(data as BackfillCandlesMessage, Jobs.BACKFILL_CANDLES);
    const payloads = () =>
      outbox.enqueue.mock.calls[0][1].map(
        (r: { payload: unknown }) => r.payload,
      );
    return { run, outbox, payloads };
  }

  async function refusal(data: unknown): Promise<string[]> {
    try {
      await job().run(data);
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      return (
        (error as BadRequestException).getResponse() as { message: string[] }
      ).message;
    }
    throw new Error('accepted');
  }

  const today = new Date().toISOString().slice(0, 10);

  it('turns a range into one item per coin per day, oldest first', async () => {
    const { run, outbox, payloads } = job();

    const created = await run({
      from: '2026-11-01',
      to: '2026-11-02',
      coins: ['NXC', 'ORB'],
    });

    expect(created).toMatchObject({ id: 21, name: 'BackfillCandles', size: 4 });
    expect(payloads()).toEqual([
      { coin: 'NXC', day: '2026-11-01', jobId: 21, index: 0 },
      { coin: 'ORB', day: '2026-11-01', jobId: 21, index: 1 },
      { coin: 'NXC', day: '2026-11-02', jobId: 21, index: 2 },
      { coin: 'ORB', day: '2026-11-02', jobId: 21, index: 3 },
    ]);
    expect(outbox.enqueue.mock.calls[0][1][0]).toMatchObject({
      transport: 'pulsar',
      destination: 'BackfillCandles',
      key: '21',
    });
  });

  it('defaults to every coin up to yesterday', () => {
    const now = Date.UTC(2026, 10, 26, 9, 0, 0);
    const items = expandRange({ from: '2026-11-24' }, now);
    expect(items.map((i) => i.day)).toEqual([
      ...Array(4).fill('2026-11-24'),
      ...Array(4).fill('2026-11-25'),
    ]);
    expect(items.slice(0, 4).map((i) => i.coin)).toEqual([
      'NXC',
      'BLIP',
      'ORB',
      'WISP',
    ]);
  });

  it('takes the items themselves', async () => {
    const { run, payloads } = job();
    await run([
      { coin: 'WISP', day: '2026-10-31' },
      { coin: 'BLIP', day: '2025-01-01' },
    ]);
    expect(payloads()).toEqual([
      { coin: 'WISP', day: '2026-10-31', jobId: 21, index: 0 },
      { coin: 'BLIP', day: '2025-01-01', jobId: 21, index: 1 },
    ]);
  });

  it('refuses ranges it can’t expand', async () => {
    expect(await refusal({ from: '2026-11-31' })).toEqual([
      'from must be a date: YYYY-MM-DD',
    ]);
    expect(await refusal({ from: '2026-11-02', to: '2026-11-01' })).toEqual([
      'from must not be after to',
    ]);
    expect(await refusal({ from: '2026-11-01', coins: [] })).toEqual([
      'coins must be a non-empty list',
    ]);
    // 2020-01-01 to 2026-11-25 is 2,521 days: 10,084 coin-days.
    expect(await refusal({ from: '2020-01-01', to: '2026-11-25' })).toEqual([
      'A range can cover at most 10000 coin-days; this one is 10084.',
    ]);
    expect(await refusal({ from: '2019-12-31', to: '2020-01-02' })).toEqual([
      'from must be 2020-01-01 or later',
    ]);
    expect(await refusal({ from: '2026-11-01', to: today })).toEqual([
      'to must be before today (UTC): today belongs to the live simulator',
    ]);
  });

  it('refuses unknown coins and days the market can’t generate, naming the item', async () => {
    expect(
      await refusal([
        { coin: 'DOGE', day: '2026-11-01' },
        { coin: 'NXC', day: '2019-12-31' },
        { coin: 'NXC', day: today },
        { coin: 'NXC', day: '2026-02-30' },
        { coin: 'nxc', day: '01.11.2026' },
      ]),
    ).toEqual([
      'data[0]: coin must be one of: NXC, BLIP, ORB, WISP',
      'data[1]: day must be 2020-01-01 or later',
      'data[2]: day must be before today (UTC): today belongs to the live simulator',
      'data[3]: day must be a date: YYYY-MM-DD',
      'data[4]: coin must be a coin code',
      'data[4]: day must be a date: YYYY-MM-DD',
    ]);
    expect(await refusal({ coin: 'NXC', day: '2030-01-01' })).toEqual([
      'day must be before today (UTC): today belongs to the live simulator',
    ]);
  });
});

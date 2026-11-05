import { BadRequestException } from '@nestjs/common';
import { TraceFlags, trace } from '@opentelemetry/api';
import {
  FibonacciMessage,
  LoadProductsMessage,
  MAX_FIBONACCI_ITERATIONS,
} from '@jobber/pulsar';
import {
  NewOutboxRecord,
  OutboxRelay,
  PrismaOutboxStore,
} from '@jobber/outbox';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_JOB_ITEMS } from './abstract.job';
import { FibonacciJob } from './fibonacci/fibonacci.job';
import { LoadProductsJob } from './products/load-products.job';

const product = {
  name: 'Widget',
  category: 'Electronics',
  price: 29.99,
  stock: 100,
  rating: 4.5,
  description: 'A cool widget',
};

describe('AbstractJob', () => {
  let tx: { job: { create: jest.Mock } };
  let prismaService: { $transaction: jest.Mock };
  let outbox: { enqueue: jest.Mock };
  let outboxRelay: { poke: jest.Mock };

  beforeEach(() => {
    tx = {
      job: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 7, ...data }),
          ),
      },
    };
    prismaService = {
      $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
    };
    outbox = { enqueue: jest.fn().mockResolvedValue(undefined) };
    outboxRelay = { poke: jest.fn() };
  });

  afterEach(() => jest.restoreAllMocks());

  const deps = () =>
    [
      prismaService as unknown as PrismaService,
      outbox as unknown as PrismaOutboxStore,
      outboxRelay as unknown as OutboxRelay,
    ] as const;
  // Job data arrives as untyped GraphQL JSON without `jobId`, which `execute()` adds.
  const runFibonacci = (data: unknown) =>
    new FibonacciJob(...deps()).execute(data as FibonacciMessage, 'Fibonacci');
  const runLoadProducts = (data: unknown) =>
    new LoadProductsJob(...deps()).execute(
      data as LoadProductsMessage[],
      'LoadProducts',
    );
  const enqueued = (): NewOutboxRecord[] =>
    outbox.enqueue.mock.calls.flatMap(([, records]) => records);
  const sent = () => enqueued().map((record) => record.payload);

  async function rejection(promise: Promise<unknown>) {
    const error = await promise.then(
      () => {
        throw new Error('Expected execute() to reject');
      },
      (err) => err,
    );
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as {
      message: string | string[];
    };
  }

  function expectNothingCreated() {
    expect(prismaService.$transaction).not.toHaveBeenCalled();
    expect(outbox.enqueue).not.toHaveBeenCalled();
  }

  it('creates the job and enqueues its message in the same transaction', async () => {
    const job = await runFibonacci({ iterations: 10 });

    expect(job).toMatchObject({ id: 7, size: 1, status: 'IN_PROGRESS' });
    expect(outbox.enqueue).toHaveBeenCalledWith(tx, expect.any(Array));
    expect(enqueued()).toEqual([
      {
        transport: 'pulsar',
        destination: 'Fibonacci',
        key: '7',
        payload: { iterations: 10, jobId: 7, index: 0 },
      },
    ]);
  });

  it('wakes the relay only after the transaction commits', async () => {
    prismaService.$transaction.mockImplementation(async (fn) => {
      const result = await fn(tx);
      expect(outboxRelay.poke).not.toHaveBeenCalled();
      return result;
    });

    await runFibonacci({ iterations: 10 });

    expect(outboxRelay.poke).toHaveBeenCalledTimes(1);
  });

  it('records the trace of the request that created the job', async () => {
    const traceId = '43e9d06ab4f91608107331c0ff33be67';
    jest.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext({
        traceId,
        spanId: '0123456789abcdef',
        traceFlags: TraceFlags.SAMPLED,
      }),
    );

    await runFibonacci({ iterations: 10 });

    expect(tx.job.create.mock.calls[0][0].data.traceId).toBe(traceId);
  });

  it('records no trace when tracing is off', async () => {
    await runFibonacci({ iterations: 10 });

    expect(tx.job.create.mock.calls[0][0].data.traceId).toBeNull();
  });

  it('enqueues nothing when the transaction fails', async () => {
    prismaService.$transaction.mockRejectedValue(new Error('db down'));

    await expect(runFibonacci({ iterations: 10 })).rejects.toThrow('db down');
    expect(outboxRelay.poke).not.toHaveBeenCalled();
  });

  it(`rejects more than ${MAX_JOB_ITEMS} items`, async () => {
    const response = await rejection(
      runLoadProducts(Array.from({ length: MAX_JOB_ITEMS + 1 }, () => product)),
    );

    expect(response.message).toBe(
      `A job can have at most ${MAX_JOB_ITEMS} items; got ${MAX_JOB_ITEMS + 1}.`,
    );
    expectNothingCreated();
  });

  it('sends every array item tagged with the job id', async () => {
    const job = await runLoadProducts([
      product,
      { ...product, name: 'Gadget' },
    ]);

    expect(job).toMatchObject({ size: 2 });
    expect(sent()).toEqual([
      { ...product, jobId: 7, index: 0 },
      { ...product, name: 'Gadget', jobId: 7, index: 1 },
    ]);
  });

  it('rejects invalid data before creating a job', async () => {
    const response = await rejection(runFibonacci({ iterations: 'ten' }));

    expect(response.message).toEqual(
      expect.arrayContaining(['iterations must be an integer number']),
    );
    expectNothingCreated();
  });

  it('caps Fibonacci iterations so one job cannot block the executor', async () => {
    const response = await rejection(
      runFibonacci({ iterations: MAX_FIBONACCI_ITERATIONS + 1 }),
    );

    expect(response.message).toEqual([
      `iterations must not be greater than ${MAX_FIBONACCI_ITERATIONS}`,
    ]);
    expectNothingCreated();
  });

  it('rejects an array when any item is invalid, naming the item', async () => {
    const response = await rejection(
      runLoadProducts([product, { ...product, price: -1 }]),
    );

    expect(response.message).toEqual([
      'data[1]: price must not be less than 0',
    ]);
    expectNothingCreated();
  });

  it('rejects an empty array instead of creating a job that never completes', async () => {
    const response = await rejection(runLoadProducts([]));

    expect(response.message).toBe('Job data must not be empty.');
    expectNothingCreated();
  });
});

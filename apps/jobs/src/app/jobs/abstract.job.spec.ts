import { BadRequestException } from '@nestjs/common';
import {
  FibonacciMessage,
  LoadProductsMessage,
  PulsarClient,
  deserialize,
} from '@jobber/pulsar';
import { PrismaService } from '../prisma/prisma.service';
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
  let producer: { send: jest.Mock };
  let pulsarClient: { createProducer: jest.Mock };
  let prismaService: { job: { create: jest.Mock } };

  beforeEach(() => {
    producer = { send: jest.fn().mockResolvedValue(undefined) };
    pulsarClient = { createProducer: jest.fn().mockResolvedValue(producer) };
    prismaService = {
      job: {
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ id: 7, ...data }),
          ),
      },
    };
  });

  // Job data arrives as untyped GraphQL JSON without `jobId`, which `execute()` adds.
  const runFibonacci = (data: unknown) =>
    new FibonacciJob(
      pulsarClient as unknown as PulsarClient,
      prismaService as unknown as PrismaService,
    ).execute(data as FibonacciMessage, 'Fibonacci');
  const runLoadProducts = (data: unknown) =>
    new LoadProductsJob(
      pulsarClient as unknown as PulsarClient,
      prismaService as unknown as PrismaService,
    ).execute(data as LoadProductsMessage[], 'LoadProducts');
  const sent = () =>
    producer.send.mock.calls.map(([{ data }]) => deserialize(data));

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
    expect(prismaService.job.create).not.toHaveBeenCalled();
    expect(pulsarClient.createProducer).not.toHaveBeenCalled();
    expect(producer.send).not.toHaveBeenCalled();
  }

  it('creates the job and sends a single message', async () => {
    const job = await runFibonacci({ iterations: 10 });

    expect(job).toMatchObject({ id: 7, size: 1, status: 'IN_PROGRESS' });
    expect(sent()).toEqual([{ iterations: 10, jobId: 7 }]);
  });

  it('sends every array item tagged with the job id', async () => {
    const job = await runLoadProducts([
      product,
      { ...product, name: 'Gadget' },
    ]);

    expect(job).toMatchObject({ size: 2 });
    expect(sent()).toEqual([
      { ...product, jobId: 7 },
      { ...product, name: 'Gadget', jobId: 7 },
    ]);
  });

  it('rejects invalid data before creating a job', async () => {
    const response = await rejection(runFibonacci({ iterations: 'ten' }));

    expect(response.message).toEqual([
      'iterations must be a number conforming to the specified constraints',
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

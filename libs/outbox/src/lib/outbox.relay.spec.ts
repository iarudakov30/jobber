import { OutboxRelay } from './outbox.relay';
import { OutboxPublisher, OutboxRecord, OutboxStore } from './outbox.types';

function record(id: number, transport: OutboxRecord['transport'] = 'pulsar') {
  return {
    id: BigInt(id),
    transport,
    destination: 'Things',
    key: null,
    payload: { id },
    headers: {},
  } satisfies OutboxRecord;
}

/**
 * A store that hands out `pending` records (of one transport when asked) in order and stops at
 * the first publish failure.
 */
function fakeStore(pending: OutboxRecord[]) {
  const store: OutboxStore & { processBatch: jest.Mock } = {
    processBatch: jest.fn(async (limit, publish, transport) => {
      const batch = pending
        .filter((r) => !transport || r.transport === transport)
        .slice(0, limit);
      let published = 0;
      let error: unknown;
      for (const r of batch) {
        try {
          await publish(r);
        } catch (e) {
          error = e;
          break;
        }
        pending.splice(pending.indexOf(r), 1);
        published++;
      }
      return error ? { published, error } : { published };
    }),
  };
  return store;
}

function fakePublisher(
  transport: OutboxRecord['transport'] = 'pulsar',
): OutboxPublisher & { publish: jest.Mock } {
  return {
    transport,
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

describe('OutboxRelay', () => {
  it('publishes pending records in order', async () => {
    const publisher = fakePublisher();
    const relay = new OutboxRelay(fakeStore([record(1), record(2)]), [
      publisher,
    ]);

    expect(await relay.tick()).toBe(2);
    expect(publisher.publish.mock.calls.map(([r]) => r.id)).toEqual([
      BigInt(1),
      BigInt(2),
    ]);
  });

  it('reports a failed batch without throwing', async () => {
    const publisher = fakePublisher();
    publisher.publish
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('broker down'));
    const pending = [record(1), record(2), record(3)];
    const relay = new OutboxRelay(fakeStore(pending), [publisher]);

    expect(await relay.tick()).toBe(-1);
    expect(pending.map((r) => r.id)).toEqual([BigInt(2), BigInt(3)]);
  });

  it('keeps publishing Pulsar records while RabbitMQ is down', async () => {
    const pulsar = fakePublisher('pulsar');
    const rabbit = fakePublisher('rabbitmq');
    rabbit.publish.mockRejectedValue(new Error('RabbitMQ is not connected'));
    // The RabbitMQ record was written first, as payment.expire is before payment-succeeded.
    const pending = [record(1, 'rabbitmq'), record(2, 'pulsar')];
    const relay = new OutboxRelay(fakeStore(pending), [pulsar, rabbit]);

    expect(await relay.tick()).toBe(1);
    expect(pulsar.publish.mock.calls.map(([r]) => r.id)).toEqual([BigInt(2)]);
    expect(pending.map((r) => r.id)).toEqual([BigInt(1)]);
  });

  it('backs off a failing transport without blocking the others', async () => {
    const pulsar = fakePublisher('pulsar');
    const rabbit = fakePublisher('rabbitmq');
    rabbit.publish.mockRejectedValueOnce(new Error('down'));
    const pending = [record(1, 'rabbitmq')];
    const store = fakeStore(pending);
    const relay = new OutboxRelay(store, [pulsar, rabbit], {
      minIdleMs: 50,
      maxIdleMs: 50,
    });

    expect(await relay.tick()).toBe(-1);
    // Within the backoff, RabbitMQ isn't tried again; Pulsar is.
    pending.push(record(2, 'pulsar'));
    expect(await relay.tick()).toBe(1);
    expect(rabbit.publish).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 60));
    expect(await relay.tick()).toBe(1);
    expect(pending).toEqual([]);
  });

  it('ignores records of a transport it has no publisher for', async () => {
    const pending = [record(1, 'rabbitmq')];
    const relay = new OutboxRelay(fakeStore(pending), [fakePublisher()]);

    expect(await relay.tick()).toBe(0);
    expect(pending).toHaveLength(1);
  });

  it('survives a store error', async () => {
    const store = {
      processBatch: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const relay = new OutboxRelay(store, [fakePublisher()]);

    expect(await relay.tick()).toBe(-1);
  });

  it('drains in the background, wakes on poke, and stops cleanly', async () => {
    const pending = [record(1)];
    const store = fakeStore(pending);
    const publisher = fakePublisher();
    const relay = new OutboxRelay(store, [publisher], {
      minIdleMs: 60_000,
      maxIdleMs: 60_000,
    });

    relay.onApplicationBootstrap();
    await waitFor(() => publisher.publish.mock.calls.length === 1);

    // The relay is now asleep for a minute; a poke must wake it for the new record.
    pending.push(record(2));
    relay.poke();
    await waitFor(() => publisher.publish.mock.calls.length === 2);

    await relay.beforeApplicationShutdown();
    const batches = store.processBatch.mock.calls.length;
    relay.poke();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.processBatch.mock.calls.length).toBe(batches);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 1000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('condition not met in time');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

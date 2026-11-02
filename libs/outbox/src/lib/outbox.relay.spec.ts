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

/** A store that hands out `pending` records and stops at the first publish failure. */
function fakeStore(pending: OutboxRecord[]) {
  const store: OutboxStore & { processBatch: jest.Mock } = {
    processBatch: jest.fn(async (limit, publish) => {
      let published = 0;
      for (const r of pending.slice(0, limit)) {
        try {
          await publish(r);
        } catch (error) {
          pending.splice(0, published);
          return { published, error };
        }
        published++;
      }
      pending.splice(0, published);
      return { published };
    }),
  };
  return store;
}

function fakePublisher(): OutboxPublisher & { publish: jest.Mock } {
  return {
    transport: 'pulsar',
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

  it('fails a record whose transport has no publisher', async () => {
    const pending = [record(1, 'rabbitmq')];
    const relay = new OutboxRelay(fakeStore(pending), [fakePublisher()]);

    expect(await relay.tick()).toBe(-1);
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

import { PrismaOutboxStore, PrismaRawClient } from './prisma-outbox.store';

/** Records each raw call as its SQL text (whitespace collapsed) plus its values. */
function fakeTx(rows: unknown[] = []) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const record = (strings: TemplateStringsArray, values: unknown[]) =>
    calls.push({ sql: strings.join('?').replace(/\s+/g, ' ').trim(), values });
  const tx: PrismaRawClient = {
    $queryRaw: async <T>(
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      record(strings, values);
      return rows as T;
    },
    $executeRaw: async (
      strings: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      record(strings, values);
      return 1;
    },
  };
  return { tx, calls };
}

const row = (id: number) => ({
  id: BigInt(id),
  transport: 'pulsar',
  destination: 'Things',
  key: '7',
  payload: { id },
  headers: {},
});

describe('PrismaOutboxStore', () => {
  describe('enqueue', () => {
    it('inserts all records in one statement per 1,000', async () => {
      const { tx, calls } = fakeTx();
      const store = new PrismaOutboxStore({} as never);

      await store.enqueue(
        tx,
        Array.from({ length: 1001 }, (_, i) => ({
          transport: 'pulsar' as const,
          destination: 'Things',
          key: String(i),
          payload: { i },
        })),
      );

      expect(calls).toHaveLength(2);
      expect(calls[0].sql).toMatch(/^INSERT INTO outbox/);
      const [transports, , keys, payloads, headers] = calls[1].values;
      expect(transports).toEqual(['pulsar']);
      expect(keys).toEqual(['1000']);
      expect(payloads).toEqual(['{"i":1000}']);
      expect(headers).toEqual(['{}']);
    });
  });

  describe('processBatch', () => {
    function storeWith(rows: unknown[]) {
      const { tx, calls } = fakeTx(rows);
      const prisma = {
        ...tx,
        $transaction: jest.fn(async (fn: (t: PrismaRawClient) => unknown) =>
          fn(tx),
        ),
      };
      return { store: new PrismaOutboxStore(prisma as never), prisma, calls };
    }

    it('claims rows with SKIP LOCKED and marks the published ones', async () => {
      const { store, prisma, calls } = storeWith([row(1), row(2)]);
      const publish = jest.fn().mockResolvedValue(undefined);

      const result = await store.processBatch(100, publish);

      expect(result).toEqual({ published: 2, error: undefined });
      expect(calls[0].sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(calls[0].values).toEqual([100]);
      expect(calls[1].sql).toMatch(/^UPDATE outbox SET published_at = now\(\)/);
      expect(calls[1].values).toEqual([['1', '2']]);
      expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        timeout: 60_000,
      });
    });

    it('stops at the first failure but still marks what went out', async () => {
      const { store, calls } = storeWith([row(1), row(2), row(3)]);
      const failure = new Error('broker down');
      const publish = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(failure);

      const result = await store.processBatch(100, publish);

      expect(result).toEqual({ published: 1, error: failure });
      expect(publish).toHaveBeenCalledTimes(2);
      expect(calls[1].values).toEqual([['1']]);
    });

    it('marks nothing when nothing was published', async () => {
      const { store, calls } = storeWith([]);

      expect(await store.processBatch(100, jest.fn())).toEqual({
        published: 0,
        error: undefined,
      });
      expect(calls).toHaveLength(1);
    });
  });
});

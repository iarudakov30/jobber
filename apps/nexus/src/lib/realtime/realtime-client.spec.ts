import { fakeRealtime } from '../../testing/fake-socket';
import { PriceBook } from './realtime';
import { realtimeUrl } from './realtime-client';

describe('RealtimeClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('subscribes once per channel, sends it when connected, and unsubscribes after the last listener', () => {
    const { client, latest } = fakeRealtime();
    const one = client.subscribe('prices.NXC', () => undefined);
    client.start();
    expect(client.status).toBe('connecting');
    expect(latest().sent).toEqual([]);

    latest().welcome();
    expect(client.status).toBe('open');
    expect(latest().requests).toEqual([['subscribe', 'prices.NXC']]);

    const two = client.subscribe('prices.NXC', () => undefined);
    client.subscribe('prices.ORB', () => undefined);
    one();
    expect(latest().requests).toEqual([
      ['subscribe', 'prices.NXC'],
      ['subscribe', 'prices.ORB'],
    ]);
    two();
    two();
    expect(latest().requests.at(-1)).toEqual(['unsubscribe', 'prices.NXC']);
    expect(latest().requests).toHaveLength(3);
  });

  it('delivers price messages to their channel and user messages to the user listeners', () => {
    const { client, latest } = fakeRealtime();
    const nxc = vi.fn();
    const user = vi.fn();
    client.subscribe('prices.NXC', nxc);
    client.onUserMessage(user);
    client.start();
    latest().welcome(7);

    latest().message('prices.NXC', 10, { price: '4200' });
    latest().message('prices.ORB', 3, { price: '31000' });
    latest().message('user.7', 50, { type: 'balance', asset: 'USD' });

    expect(client.userId).toBe(7);
    expect(nxc).toHaveBeenCalledExactlyOnceWith({
      channel: 'prices.NXC',
      seq: 10,
      data: { price: '4200' },
    });
    expect(user).toHaveBeenCalledOnce();
  });

  it('drops a message that is not newer: per price channel, per asset, per fill', () => {
    const { client, latest } = fakeRealtime();
    const prices: number[] = [];
    const user: string[] = [];
    client.subscribe('prices.NXC', ({ seq }) => prices.push(seq));
    client.onUserMessage(({ seq, data }) =>
      user.push(
        `${(data as { asset?: string; type: string }).asset ?? (data as { type: string }).type}@${seq}`,
      ),
    );
    client.start();
    latest().welcome(7);
    const socket = latest();

    socket.message('prices.NXC', 10, {});
    socket.message('prices.NXC', 9, {});
    socket.message('prices.NXC', 10, {});
    socket.message('prices.NXC', 12, {});
    // Balances are ordered per asset: NXC@100 after USD@101 is still news.
    socket.message('user.7', 101, { type: 'balance', asset: 'USD' });
    socket.message('user.7', 100, { type: 'balance', asset: 'NXC' });
    socket.message('user.7', 99, { type: 'balance', asset: 'USD' });
    // A redelivered fill has the same seq.
    socket.message('user.7', 102, { type: 'fill', orderId: 'o-1' });
    socket.message('user.7', 102, { type: 'fill', orderId: 'o-1' });

    expect(prices).toEqual([10, 12]);
    expect(user).toEqual(['USD@101', 'NXC@100', 'fill@102']);
  });

  it('reconnects with a growing, randomized backoff up to 30 s, and resets it after a welcome', () => {
    let random = 0;
    const { client, sockets, latest } = fakeRealtime({ random: () => random });
    client.start();
    latest().drop();
    expect(client.status).toBe('closed');

    // random 0: half of 1 s, 2 s, 4 s, ...
    for (const delay of [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000]) {
      const before = sockets.length;
      vi.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(before);
      vi.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
      latest().drop();
    }
    // random 1: the full delay, capped at 30 s.
    random = 1;
    vi.advanceTimersByTime(15_000);
    latest().drop();
    const before = sockets.length;
    vi.advanceTimersByTime(29_999);
    expect(sockets).toHaveLength(before);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(before + 1);

    // A welcome resets the backoff: the next wait is 1 s again.
    latest().welcome();
    latest().drop();
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(before + 2);
  });

  it('comes back at once (within a random second) when the gateway restarts with 1012', () => {
    const { client, sockets, latest } = fakeRealtime({ random: () => 0.3 });
    client.start();
    latest().welcome();
    // Even after earlier failures.
    for (let i = 0; i < 4; i++) {
      latest().drop();
      vi.runOnlyPendingTimers();
    }
    latest().welcome();
    latest().drop(1012);

    vi.advanceTimersByTime(300);
    expect(sockets).toHaveLength(6);
  });

  it('resubscribes after a reconnect, and fires resynced on every welcome and resync', () => {
    const { client, latest } = fakeRealtime();
    const resynced = vi.fn();
    client.onResynced(resynced);
    client.subscribe('prices.WISP', () => undefined);
    client.start();
    latest().welcome();
    expect(resynced).toHaveBeenCalledTimes(1);

    latest().frame({ type: 'resync' });
    expect(resynced).toHaveBeenCalledTimes(2);

    latest().drop();
    vi.runOnlyPendingTimers();
    expect(latest().requests).toEqual([]);
    latest().welcome();
    expect(latest().requests).toEqual([['subscribe', 'prices.WISP']]);
    expect(resynced).toHaveBeenCalledTimes(3);
  });

  it('stops for good: closes the socket and never reconnects', () => {
    const { client, sockets, latest } = fakeRealtime();
    const statuses: string[] = [];
    client.onStatus(() => statuses.push(client.status));
    client.start();
    latest().welcome();
    const socket = latest();

    client.stop();
    socket.drop();
    vi.advanceTimersByTime(60_000);

    expect(socket.closedWith).toBe(1000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    expect(client.userId).toBeUndefined();
  });

  it('ignores what a socket it already replaced says', () => {
    const { client, latest } = fakeRealtime();
    const user = vi.fn();
    client.onUserMessage(user);
    client.start();
    const old = latest();
    old.welcome();
    old.drop();
    vi.runOnlyPendingTimers();
    latest().welcome();

    old.message('user.7', 1, { type: 'balance', asset: 'USD' });
    old.drop();

    expect(user).not.toHaveBeenCalled();
    expect(client.status).toBe('open');
  });
});

describe('PriceBook', () => {
  it('keeps the tick with the highest seq and tells only that coin’s listeners', () => {
    const book = new PriceBook();
    const nxc = vi.fn();
    const orb = vi.fn();
    book.subscribe('NXC', nxc);
    book.subscribe('ORB', orb);

    book.set('NXC', { price: '4200', seq: 5, at: 1 });
    book.set('NXC', { price: '4100', seq: 4, at: 2 });
    book.set('NXC', { price: '4300', seq: 6, at: 3 });

    expect(book.get('NXC')).toEqual({ price: '4300', seq: 6, at: 3 });
    expect(nxc).toHaveBeenCalledTimes(2);
    expect(orb).not.toHaveBeenCalled();
  });
});

it('realtimeUrl goes through the app’s own origin', () => {
  expect(
    realtimeUrl({ protocol: 'http:', host: 'localhost:4300' } as Location),
  ).toBe('ws://localhost:4300/api/realtime');
  expect(
    realtimeUrl({ protocol: 'https:', host: 'nexus.example' } as Location),
  ).toBe('wss://nexus.example/api/realtime');
});

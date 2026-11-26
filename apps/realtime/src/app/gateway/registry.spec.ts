import { Registry } from './registry';

describe('Registry', () => {
  it("reports a user's first and last socket, for binding and unbinding user.<id>", () => {
    const registry = new Registry<string>();
    expect(registry.addSocket(7, 'tab-1')).toBe(true);
    expect(registry.addSocket(7, 'tab-2')).toBe(false);
    expect(registry.addSocket(8, 'other')).toBe(true);
    expect(registry.counts).toEqual({ sockets: 3, users: 2, channels: 0 });

    expect(registry.removeSocket(7, 'tab-1')).toBe(false);
    expect(registry.removeSocket(7, 'tab-1')).toBe(false);
    expect(registry.removeSocket(7, 'tab-2')).toBe(true);
    expect(registry.counts).toEqual({ sockets: 1, users: 1, channels: 0 });
  });

  it('keeps channel membership per socket and drops it with the socket', () => {
    const registry = new Registry<string>();
    registry.addSocket(7, 'a');
    registry.addSocket(8, 'b');
    expect(registry.join('a', 'prices.NXC')).toBe(true);
    expect(registry.join('a', 'prices.NXC')).toBe(false);
    registry.join('b', 'prices.NXC');
    registry.join('a', 'user.7');
    expect([...registry.subscribers('prices.NXC')]).toEqual(['a', 'b']);
    expect([...registry.channelsOf('a')]).toEqual(['prices.NXC', 'user.7']);

    expect(registry.leave('b', 'prices.NXC')).toBe(true);
    expect(registry.leave('b', 'prices.NXC')).toBe(false);
    registry.removeSocket(7, 'a');
    expect([...registry.subscribers('prices.NXC')]).toEqual([]);
    expect([...registry.subscribers('user.7')]).toEqual([]);
    expect(registry.counts.channels).toBe(0);
    // A removed socket can't join anything.
    expect(registry.join('a', 'prices.ORB')).toBe(false);
  });
});

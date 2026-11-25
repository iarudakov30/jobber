import { notificationsTopology } from './notifications';
import {
  REALTIME_EXCHANGE,
  priceChannel,
  realtimeTopology,
  userChannel,
} from './realtime';
import { mergeTopologies } from './topology';

describe('realtime channels', () => {
  it('names the routing keys the gateway binds', () => {
    expect(userChannel(42)).toBe('user.42');
    expect(userChannel('42')).toBe('user.42');
    expect(priceChannel('NXC')).toBe('prices.NXC');
  });

  it('declares one topic exchange', () => {
    expect(realtimeTopology()).toEqual({
      exchanges: [{ name: REALTIME_EXCHANGE, type: 'topic' }],
    });
  });
});

describe('mergeTopologies', () => {
  it('keeps every exchange, queue and delay bucket of each part, in order', () => {
    const merged = mergeTopologies(
      notificationsTopology(),
      realtimeTopology(),
      { delayBuckets: [{ name: 'delay.1m', ttlMs: 60_000, target: 'x' }] },
    );

    expect(merged.exchanges?.map((e) => e.name)).toEqual([
      'notifications',
      'realtime',
    ]);
    expect(merged.queues?.map((q) => q.name)).toEqual(['notifications.email']);
    expect(merged.delayBuckets?.map((b) => b.name)).toEqual(['delay.1m']);
  });
});

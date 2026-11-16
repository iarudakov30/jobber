import { EDGE_BY_ID } from './pipeline';
import { TimedHop, dotAt, playbackDuration, routesPlayback } from './playback';

describe('playback', () => {
  // publish (0–100 ms), a wait at Pulsar, then deliver (300–400 ms).
  const hops: TimedHop[] = [
    { edge: 'publish', start: 0, end: 100 },
    { edge: 'deliver', start: 300, end: 400 },
  ];

  it('hides a dot before its first hop and after its last', () => {
    expect(dotAt(hops, -1)).toBeUndefined();
    expect(dotAt(hops, 400)).toBeUndefined();
  });

  it('moves a dot along the hop it is on', () => {
    expect(dotAt(hops, 50)).toEqual({
      point: { x: 572.5, y: 188 },
      node: 'pulsar',
      edge: 'publish',
    });
  });

  it('parks a dot where its last hop ended until the next one starts', () => {
    const end = EDGE_BY_ID.publish.points[1];
    expect(dotAt(hops, 200)).toEqual({ point: end, node: 'pulsar' });
  });

  it('times fixed-speed routes hop after hop', () => {
    const playback = routesPlayback(
      [
        {
          route: [
            { edge: 'claim', text: 'claimed' },
            { edge: 'publish', text: 'published' },
          ],
          delay: 50,
        },
      ],
      600,
    );

    expect(playback.tokens).toEqual([
      [
        { edge: 'claim', start: 50, end: 650 },
        { edge: 'publish', start: 650, end: 1250 },
      ],
    ]);
    expect(playback.events).toEqual([
      { at: 50, text: 'claimed' },
      { at: 650, text: 'published' },
    ]);
    expect(playbackDuration(playback)).toBe(1250);
  });
});

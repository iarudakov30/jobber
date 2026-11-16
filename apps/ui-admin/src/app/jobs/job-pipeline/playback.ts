import { EDGE_BY_ID, EdgeId, Hop, NodeId, Point, pointAlong } from './pipeline';

/** One arrow a dot travels, with its timing in ms from the start of the playback. */
export interface TimedHop {
  edge: EdgeId;
  start: number;
  end: number;
}

export interface PlaybackEvent {
  at: number;
  text: string;
}

/** Everything one replay shows: dots travelling timed hops, and log lines at set times. */
export interface Playback {
  tokens: TimedHop[][];
  events: PlaybackEvent[];
}

/** Where a dot is: on an arrow (`edge` set), or waiting at the box its last arrow led to. */
export interface DotState {
  point: Point;
  node: NodeId;
  edge?: EdgeId;
}

export function playbackDuration(playback: Playback): number {
  return Math.max(
    0,
    ...playback.tokens.flat().map((hop) => hop.end),
    ...playback.events.map((event) => event.at),
  );
}

/**
 * A dot at time `t`: moving along the hop it is on, or, between hops, waiting where the last one
 * ended. Hidden before its first hop and after its last.
 */
export function dotAt(
  hops: readonly TimedHop[],
  t: number,
): DotState | undefined {
  if (
    hops.length === 0 ||
    t < hops[0].start ||
    t >= hops[hops.length - 1].end
  ) {
    return undefined;
  }
  for (let i = hops.length - 1; i >= 0; i--) {
    const hop = hops[i];
    if (t < hop.start) {
      continue;
    }
    const edge = EDGE_BY_ID[hop.edge];
    if (t < hop.end) {
      return {
        point: pointAlong(edge.points, (t - hop.start) / (hop.end - hop.start)),
        node: edge.to,
        edge: hop.edge,
      };
    }
    return { point: edge.points[edge.points.length - 1], node: edge.to };
  }
  return undefined;
}

/** Fixed-speed routes: every hop takes `hopMs`, and each route starts after its own delay. */
export function routesPlayback(
  routes: readonly { route: readonly Hop[]; delay: number }[],
  hopMs: number,
): Playback {
  return {
    tokens: routes.map(({ route, delay }) =>
      route.map((hop, i) => ({
        edge: hop.edge,
        start: delay + i * hopMs,
        end: delay + (i + 1) * hopMs,
      })),
    ),
    events: routes.flatMap(({ route, delay }) =>
      route.map((hop, i) => ({ at: delay + i * hopMs, text: hop.text })),
    ),
  };
}

/**
 * The job pipeline diagram: where each service sits, the arrows between them, and the route a
 * job (and each of its items) takes along those arrows. Pure data and geometry, no Angular.
 *
 * Coordinates are in SVG user units inside a `VIEW_BOX`-sized canvas. Arrows are polylines, so a
 * dot's position along one can be computed without measuring the rendered `<path>`.
 */

export interface Point {
  x: number;
  y: number;
}

export type NodeId =
  'ui' | 'jobs' | 'auth' | 'products' | 'db' | 'relay' | 'pulsar' | 'executor';

export interface PipelineNode {
  id: NodeId;
  title: string;
  subtitle: string;
  x: number;
  y: number;
}

export type EdgeId =
  | 'submit'
  | 'reply'
  | 'authenticate'
  | 'user'
  | 'sql'
  | 'claim'
  | 'publish'
  | 'deliver'
  | 'nack'
  | 'create-product'
  | 'product-saved'
  | 'acknowledge';

export interface PipelineEdge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  points: Point[];
  label?: string;
  labelAt?: Point;
  labelAnchor?: 'start' | 'middle' | 'end';
}

/** One step of a route: the arrow a dot travels and what is happening while it does. */
export interface Hop {
  edge: EdgeId;
  text: string;
}

export const VIEW_BOX = { width: 935, height: 240 };
export const NODE_WIDTH = 120;
export const NODE_HEIGHT = 56;

export const NODES: readonly PipelineNode[] = [
  { id: 'ui', title: 'ui-admin', subtitle: 'browser', x: 20, y: 40 },
  { id: 'jobs', title: 'jobs', subtitle: 'GraphQL · gRPC', x: 250, y: 40 },
  { id: 'auth', title: 'auth', subtitle: 'users · JWT', x: 500, y: 40 },
  {
    id: 'products',
    title: 'products',
    subtitle: 'gRPC · Drizzle',
    x: 775,
    y: 40,
  },
  { id: 'db', title: 'jobs DB', subtitle: 'Job · outbox', x: 250, y: 160 },
  {
    id: 'relay',
    title: 'outbox relay',
    subtitle: 'inside jobs',
    x: 425,
    y: 160,
  },
  { id: 'pulsar', title: 'Pulsar', subtitle: 'job topic', x: 600, y: 160 },
  { id: 'executor', title: 'executor', subtitle: 'consumer', x: 775, y: 160 },
];

export const EDGES: readonly PipelineEdge[] = [
  {
    id: 'submit',
    from: 'ui',
    to: 'jobs',
    points: [
      { x: 140, y: 58 },
      { x: 250, y: 58 },
    ],
    label: 'executeJob',
    labelAt: { x: 195, y: 52 },
  },
  {
    id: 'reply',
    from: 'jobs',
    to: 'ui',
    points: [
      { x: 250, y: 78 },
      { x: 140, y: 78 },
    ],
    label: 'reply · poll',
    labelAt: { x: 195, y: 92 },
  },
  {
    id: 'authenticate',
    from: 'jobs',
    to: 'auth',
    points: [
      { x: 370, y: 58 },
      { x: 500, y: 58 },
    ],
    label: 'Authenticate',
    labelAt: { x: 435, y: 52 },
  },
  {
    id: 'user',
    from: 'auth',
    to: 'jobs',
    points: [
      { x: 500, y: 78 },
      { x: 370, y: 78 },
    ],
    label: 'user',
    labelAt: { x: 435, y: 92 },
  },
  {
    id: 'sql',
    from: 'jobs',
    to: 'db',
    points: [
      { x: 310, y: 96 },
      { x: 310, y: 160 },
    ],
    label: 'SQL',
    labelAt: { x: 318, y: 132 },
    labelAnchor: 'start',
  },
  {
    id: 'claim',
    from: 'db',
    to: 'relay',
    points: [
      { x: 370, y: 188 },
      { x: 425, y: 188 },
    ],
    label: 'claim',
    labelAt: { x: 397, y: 182 },
  },
  {
    id: 'publish',
    from: 'relay',
    to: 'pulsar',
    points: [
      { x: 545, y: 188 },
      { x: 600, y: 188 },
    ],
    label: 'publish',
    labelAt: { x: 572, y: 182 },
  },
  {
    id: 'deliver',
    from: 'pulsar',
    to: 'executor',
    points: [
      { x: 720, y: 188 },
      { x: 775, y: 188 },
    ],
    label: 'deliver',
    labelAt: { x: 747, y: 182 },
  },
  {
    // A failed handler hands the message back for redelivery; only real traces travel it.
    id: 'nack',
    from: 'executor',
    to: 'pulsar',
    points: [
      { x: 775, y: 204 },
      { x: 720, y: 204 },
    ],
    label: 'nack',
    labelAt: { x: 747, y: 218 },
  },
  {
    id: 'create-product',
    from: 'executor',
    to: 'products',
    points: [
      { x: 825, y: 160 },
      { x: 825, y: 96 },
    ],
    label: 'CreateProduct',
    labelAt: { x: 817, y: 132 },
    labelAnchor: 'end',
  },
  {
    id: 'product-saved',
    from: 'products',
    to: 'executor',
    points: [
      { x: 845, y: 96 },
      { x: 845, y: 160 },
    ],
  },
  {
    id: 'acknowledge',
    from: 'executor',
    to: 'jobs',
    points: [
      { x: 895, y: 188 },
      { x: 918, y: 188 },
      { x: 918, y: 18 },
      { x: 330, y: 18 },
      { x: 330, y: 40 },
    ],
    label: 'Acknowledge (gRPC)',
    labelAt: { x: 624, y: 13 },
  },
];

export const EDGE_BY_ID = Object.fromEntries(
  EDGES.map((edge) => [edge.id, edge]),
) as Readonly<Record<EdgeId, PipelineEdge>>;

interface JobRef {
  id: string;
  name: string;
  size: number;
}

/** The job's own trip: from the "Run job" button to the job and its outbox rows being saved. */
export function creationRoute(job: JobRef): Hop[] {
  return [
    {
      edge: 'submit',
      text: `ui-admin sends the executeJob mutation for ${job.name}`,
    },
    {
      edge: 'authenticate',
      text: 'jobs checks the Authentication cookie with auth over gRPC',
    },
    { edge: 'user', text: 'auth returns the signed-in user' },
    {
      edge: 'sql',
      text: `One transaction: INSERT Job #${job.id} and ${count(job.size, 'outbox row')}`,
    },
    { edge: 'reply', text: `jobs replies: Job #${job.id} is IN_PROGRESS` },
  ];
}

/**
 * One item's trip, from its outbox row to being counted. Only LoadProducts calls `products`.
 * Items are processed in parallel and out of order, so the route doesn't name an index.
 */
export function itemRoute(job: JobRef): Hop[] {
  const route: Hop[] = [
    {
      edge: 'claim',
      text: 'The relay claims an outbox row (FOR UPDATE SKIP LOCKED)',
    },
    {
      edge: 'publish',
      text: `Published to topic ${job.name}; sequenceId = outbox id, so a resend is dropped`,
    },
    {
      edge: 'deliver',
      text: 'Pulsar delivers it to the executor (shared subscription "jobber")',
    },
  ];
  if (usesProducts(job.name)) {
    route.push(
      {
        edge: 'create-product',
        text: `executor calls CreateProduct with sourceRef job:${job.id}:<index>`,
      },
      {
        edge: 'product-saved',
        text: 'products saves it; a repeat with the same sourceRef is ignored',
      },
    );
  }
  route.push(
    {
      edge: 'acknowledge',
      text: 'executor acknowledges { jobId, index } over gRPC',
    },
    {
      edge: 'sql',
      text: 'INSERT JobItem (a duplicate is a no-op) and completed + 1',
    },
  );
  return route;
}

/** ui-admin learning about progress: the job query it polls every 2 seconds. */
export function pollRoute(job: { completed: number; size: number }): Hop[] {
  return [
    {
      edge: 'reply',
      text: `Progress poll: ${job.completed} of ${job.size} done`,
    },
  ];
}

export function usesProducts(jobName: string): boolean {
  return jobName === 'LoadProducts';
}

/** An SVG path `d` attribute for a polyline. */
export function pathData(points: readonly Point[]): string {
  return points
    .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x} ${point.y}`)
    .join(' ');
}

/** The point `fraction` (0–1) of the way along a polyline, by length. */
export function pointAlong(points: readonly Point[], fraction: number): Point {
  const lengths = points
    .slice(1)
    .map((point, i) =>
      Math.hypot(point.x - points[i].x, point.y - points[i].y),
    );
  let remaining =
    Math.min(Math.max(fraction, 0), 1) * lengths.reduce((a, b) => a + b, 0);
  for (let i = 0; i < lengths.length; i++) {
    if (remaining <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : Math.min(remaining / lengths[i], 1);
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    remaining -= lengths[i];
  }
  return points[0];
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

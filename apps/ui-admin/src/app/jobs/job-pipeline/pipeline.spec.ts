import {
  EDGE_BY_ID,
  creationRoute,
  itemRoute,
  pathData,
  pointAlong,
  pollRoute,
} from './pipeline';

describe('pipeline', () => {
  const job = { id: '7', name: 'Fibonacci', size: 3 };

  it('draws a polyline', () => {
    expect(
      pathData([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
      ]),
    ).toBe('M0 0 L10 0 L10 5');
  });

  describe('pointAlong', () => {
    // Two segments of length 10 each.
    const line = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];

    it('starts and ends at the endpoints', () => {
      expect(pointAlong(line, 0)).toEqual({ x: 0, y: 0 });
      expect(pointAlong(line, 1)).toEqual({ x: 10, y: 10 });
    });

    it('measures by length across segments', () => {
      expect(pointAlong(line, 0.25)).toEqual({ x: 5, y: 0 });
      expect(pointAlong(line, 0.75)).toEqual({ x: 10, y: 5 });
    });

    it('clamps fractions outside 0–1', () => {
      expect(pointAlong(line, -1)).toEqual({ x: 0, y: 0 });
      expect(pointAlong(line, 2)).toEqual({ x: 10, y: 10 });
    });
  });

  it('creates the job and its outbox rows in one transaction', () => {
    const route = creationRoute(job);
    expect(route.map((hop) => hop.edge)).toEqual([
      'submit',
      'authenticate',
      'user',
      'sql',
      'reply',
    ]);
    expect(route[3].text).toContain('INSERT Job #7 and 3 outbox rows');
  });

  it('calls products only for LoadProducts items', () => {
    expect(itemRoute(job).map((hop) => hop.edge)).toEqual([
      'claim',
      'publish',
      'deliver',
      'acknowledge',
      'sql',
    ]);
    expect(
      itemRoute({ ...job, name: 'LoadProducts' }).map((hop) => hop.edge),
    ).toEqual([
      'claim',
      'publish',
      'deliver',
      'create-product',
      'product-saved',
      'acknowledge',
      'sql',
    ]);
  });

  it('moves an item from the outbox back to the jobs DB without gaps', () => {
    for (const name of ['Fibonacci', 'LoadProducts']) {
      const edges = itemRoute({ ...job, name }).map(
        (hop) => EDGE_BY_ID[hop.edge],
      );
      expect(edges[0].from).toBe('db');
      expect(edges[edges.length - 1].to).toBe('db');
      edges.slice(1).forEach((edge, i) => expect(edge.from).toBe(edges[i].to));
    }
  });

  it('reports polled progress to ui-admin', () => {
    const [hop] = pollRoute({ completed: 2, size: 3 });
    expect(EDGE_BY_ID[hop.edge].to).toBe('ui');
    expect(hop.text).toBe('Progress poll: 2 of 3 done');
  });
});

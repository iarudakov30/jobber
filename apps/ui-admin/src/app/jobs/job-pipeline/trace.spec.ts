import { fibonacciWithRetries, loadProducts } from './testing/trace-fixtures';
import {
  analyseJobTrace,
  ms,
  parseTrace,
  screenClock,
  summarise,
  tracePlayback,
} from './trace';

// The fixtures are real traces: a 3-item Fibonacci job whose first two messages failed once
// (the executor ran with FAULT_ACK_FAILURES=2) and a 1-item LoadProducts job.
describe('trace', () => {
  const retries = () => {
    const job = analyseJobTrace(parseTrace(fibonacciWithRetries));
    if (!job) {
      throw new Error('fixture has no request span');
    }
    return job;
  };

  it('parses spans with times relative to the first one', () => {
    const spans = parseTrace(fibonacciWithRetries);

    expect(spans).toHaveLength(34);
    expect(Math.min(...spans.map((s) => s.start))).toBe(0);
    expect(new Set(spans.map((s) => s.service))).toEqual(
      new Set(['jobs', 'executor']),
    );
  });

  it('finds every message and each of its delivery attempts', () => {
    const job = retries();

    expect(job.authenticate?.attributes['rpc.method']).toBe('Authenticate');
    expect(job.begin?.name).toMatch(/^pg\.query:BEGIN/);
    expect(job.commit?.name).toMatch(/^pg\.query:COMMIT/);
    expect(job.messages.map((m) => m.attempts.map((a) => a.outcome))).toEqual([
      ['nacked', 'acked'],
      ['nacked', 'acked'],
      ['acked'],
    ]);
    expect(job.messages[0].attempts[1].countQuery?.name).toMatch(
      /^pg\.query:WITH/,
    );
  });

  it('finds the CreateProduct call of a LoadProducts message', () => {
    const job = analyseJobTrace(parseTrace(loadProducts));

    expect(
      job?.messages[0].attempts[0].createProduct?.attributes['rpc.method'],
    ).toBe('CreateProduct');
  });

  it('needs the request span, which jobs may not have exported yet', () => {
    const response = structuredClone(fibonacciWithRetries);
    for (const resourceSpans of response.result.resourceSpans) {
      for (const scope of resourceSpans.scopeSpans) {
        scope.spans = scope.spans.filter((span) => span.parentSpanId);
      }
    }

    expect(analyseJobTrace(parseTrace(response))).toBeNull();
  });

  it('summarises the real timings', () => {
    const job = retries();
    const summary = summarise(job);

    expect(summary.retries).toBe(2);
    expect(summary.acknowledged).toBe(3);
    expect(summary.transaction).toBeCloseTo(
      (job.commit?.end ?? 0) - (job.begin?.start ?? 0),
    );
    expect(summary.relayLag).toBeGreaterThan(0);
    // The redelivered messages finish after Pulsar's 5 s redelivery delay.
    expect(summary.total).toBeGreaterThan(5000);
  });

  describe('playback', () => {
    it('draws the request, then one dot per message along its real route', () => {
      const playback = tracePlayback(retries(), 6);
      const routes = playback.tokens.map((hops) => hops.map((h) => h.edge));

      expect(routes[0]).toEqual([
        'submit',
        'authenticate',
        'user',
        'sql',
        'reply',
      ]);
      expect(routes[1]).toEqual([
        'claim',
        'publish',
        'deliver',
        'nack',
        'deliver',
        'acknowledge',
        'sql',
      ]);
      expect(routes[3]).toEqual([
        'claim',
        'publish',
        'deliver',
        'acknowledge',
        'sql',
      ]);
    });

    it('sends LoadProducts messages through products', () => {
      const playback = tracePlayback(
        analyseJobTrace(parseTrace(loadProducts)) ?? retries(),
        6,
      );

      expect(playback.tokens[1].map((h) => h.edge)).toContain('create-product');
    });

    it('keeps every route moving forward in time', () => {
      for (const hops of tracePlayback(retries(), 6).tokens) {
        hops.forEach((hop, i) => {
          expect(hop.end).toBeGreaterThan(hop.start);
          if (i > 0) {
            expect(hop.start).toBeGreaterThanOrEqual(hops[i - 1].start);
          }
        });
      }
    });

    it('quotes real times in the log', () => {
      const texts = tracePlayback(retries(), 6).events.map((e) => e.text);

      expect(texts).toContainEqual(
        expect.stringMatching(
          /^Message 1 failed \(nacked\); Pulsar redelivers it 5\.\d s later$/,
        ),
      );
      expect(texts).toContainEqual(
        expect.stringMatching(/^Authenticate over gRPC: /),
      );
    });

    it('notes the messages it does not draw', () => {
      const playback = tracePlayback(retries(), 1);

      expect(playback.tokens).toHaveLength(2);
      expect(playback.events.map((e) => e.text)).toContain(
        '…2 more messages are in the trace but not drawn',
      );
    });
  });

  describe('screenClock', () => {
    const timed = (...instants: number[]) =>
      screenClock({
        tokens: [],
        events: instants.map((at, i) => ({ at, text: String(i) })),
      }).events.map((e) => e.at);

    it('keeps simultaneous moments together and stretches short gaps', () => {
      expect(timed(0, 0, 10)).toEqual([0, 0, 200]);
    });

    it('never puts distinct moments closer than the minimum step', () => {
      expect(timed(0, 1)).toEqual([0, 120]);
    });

    it('cuts long waits down', () => {
      expect(timed(0, 5000)).toEqual([0, 1000]);
    });
  });

  it('formats durations for people', () => {
    expect(ms(0.42)).toBe('0.4 ms');
    expect(ms(36.4)).toBe('36 ms');
    expect(ms(5083)).toBe('5.1 s');
  });
});

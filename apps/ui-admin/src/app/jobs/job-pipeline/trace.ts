/**
 * Turns a job's real OpenTelemetry trace (as Jaeger's `GET /api/v3/traces/{id}` returns it) into
 * a playback for the pipeline diagram. Pure functions, no Angular.
 *
 * The span names and attributes it relies on come from `@jobber/tracing` (HTTP, GraphQL, gRPC and
 * pg instrumentation) and from the hand-made Pulsar spans in `@jobber/pulsar` and `@jobber/outbox`:
 * `<topic> publish` (producer) and `<topic> process` (consumer, with `messaging.outcome`).
 */
import { Playback, PlaybackEvent, TimedHop } from './playback';
import { EdgeId } from './pipeline';

interface OtlpAttribute {
  key: string;
  value: {
    stringValue?: string;
    intValue?: string | number;
    boolValue?: boolean;
    doubleValue?: number;
  };
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes?: OtlpAttribute[];
}

/** The part of Jaeger's v3 trace response (OTLP JSON) this module reads. */
export interface OtlpTraceResponse {
  result: {
    resourceSpans: {
      resource: { attributes?: OtlpAttribute[] };
      scopeSpans: { spans: OtlpSpan[] }[];
    }[];
  };
}

/** OTLP span kinds. */
const SERVER = 2;
const CLIENT = 3;
const PRODUCER = 4;
const CONSUMER = 5;

/** A span with times in ms since the trace's first span started. */
export interface TraceSpan {
  id: string;
  parentId?: string;
  service: string;
  name: string;
  kind: number;
  start: number;
  end: number;
  attributes: Record<string, string>;
}

export function parseTrace(response: OtlpTraceResponse): TraceSpan[] {
  const raw = response.result.resourceSpans.flatMap((resourceSpans) => {
    const service =
      attributes(resourceSpans.resource.attributes)['service.name'] ?? '?';
    return resourceSpans.scopeSpans.flatMap((scope) =>
      scope.spans.map((span) => ({ span, service })),
    );
  });
  if (raw.length === 0) {
    return [];
  }
  const t0 = Math.min(...raw.map(({ span }) => micros(span.startTimeUnixNano)));
  return raw.map(({ span, service }) => ({
    id: span.spanId,
    parentId: span.parentSpanId || undefined,
    service,
    name: span.name,
    kind: span.kind,
    start: (micros(span.startTimeUnixNano) - t0) / 1000,
    end: (micros(span.endTimeUnixNano) - t0) / 1000,
    attributes: attributes(span.attributes),
  }));
}

/** One delivery of a message to the executor. */
export interface Attempt {
  process: TraceSpan;
  outcome: string;
  createProduct?: TraceSpan;
  acknowledge?: TraceSpan;
  /** `jobs`' side of Acknowledge, and the statement that counted the item. */
  acknowledgeServer?: TraceSpan;
  countQuery?: TraceSpan;
}

/** One message: its publish by the outbox relay and every delivery attempt, in order. */
export interface MessageRun {
  publish: TraceSpan;
  attempts: Attempt[];
}

/** The pieces of a job's trace the replay draws. */
export interface JobTrace {
  request: TraceSpan;
  authenticate?: TraceSpan;
  begin?: TraceSpan;
  commit?: TraceSpan;
  messages: MessageRun[];
  /** When the last span ended, in ms after the request started. */
  total: number;
}

/**
 * Finds the job's structure in its spans. Returns null without the `jobs` request span, which is
 * missing until `jobs` exports it (spans are sent in batches every few seconds).
 */
export function analyseJobTrace(spans: readonly TraceSpan[]): JobTrace | null {
  const request = spans.find((span) => span.kind === SERVER && !span.parentId);
  if (!request) {
    return null;
  }
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentId) {
      children.set(span.parentId, [
        ...(children.get(span.parentId) ?? []),
        span,
      ]);
    }
  }
  const descendants = (root: TraceSpan): TraceSpan[] =>
    (children.get(root.id) ?? [])
      .flatMap((child) => [child, ...descendants(child)])
      .sort((a, b) => a.start - b.start);
  const rpc = (within: TraceSpan[], method: string) =>
    within.find(
      (span) =>
        span.kind === CLIENT && span.attributes['rpc.method'] === method,
    );

  const inRequest = descendants(request);
  const queries = inRequest.filter((span) => span.name.startsWith('pg.query:'));
  const messages = inRequest
    .filter((span) => span.kind === PRODUCER)
    .map((publish) => ({
      publish,
      attempts: (children.get(publish.id) ?? [])
        .filter((span) => span.kind === CONSUMER)
        .sort((a, b) => a.start - b.start)
        .map((process): Attempt => {
          const inProcess = descendants(process);
          const acknowledge = rpc(inProcess, 'Acknowledge');
          const acknowledgeServer = acknowledge
            ? (children.get(acknowledge.id) ?? []).find(
                (s) => s.kind === SERVER,
              )
            : undefined;
          return {
            process,
            outcome: process.attributes['messaging.outcome'] ?? 'unknown',
            createProduct: rpc(inProcess, 'CreateProduct'),
            acknowledge,
            acknowledgeServer,
            countQuery: acknowledgeServer
              ? descendants(acknowledgeServer).find((s) =>
                  s.name.startsWith('pg.query:'),
                )
              : undefined,
          };
        }),
    }));

  return {
    request,
    authenticate: rpc(inRequest, 'Authenticate'),
    begin: queries.find((span) => span.name.startsWith('pg.query:BEGIN')),
    commit: queries
      .filter((span) => span.name.startsWith('pg.query:COMMIT'))
      .pop(),
    messages,
    total: Math.max(...spans.map((span) => span.end)),
  };
}

/** Real timings worth showing next to the replay, in ms. */
export interface TraceSummary {
  request: number;
  authenticate?: number;
  transaction?: number;
  relayLag?: number;
  publishAverage?: number;
  processAverage?: number;
  retries: number;
  acknowledged: number;
  total: number;
}

export function summarise(job: JobTrace): TraceSummary {
  const attempts = job.messages.flatMap((message) => message.attempts);
  const acked = attempts.filter((attempt) => attempt.outcome === 'acked');
  const firstPublish = job.messages[0]?.publish;
  return {
    request: duration(job.request),
    authenticate: job.authenticate && duration(job.authenticate),
    transaction:
      job.begin && job.commit ? job.commit.end - job.begin.start : undefined,
    relayLag:
      job.commit && firstPublish
        ? firstPublish.start - job.commit.end
        : undefined,
    publishAverage: average(job.messages.map((m) => duration(m.publish))),
    processAverage: average(acked.map((a) => duration(a.process))),
    retries: attempts.length - acked.length,
    acknowledged: job.messages.filter((m) =>
      m.attempts.some((a) => a.outcome === 'acked'),
    ).length,
    total: job.total,
  };
}

/** Real time is stretched by this factor so millisecond steps can be seen... */
const SLOWDOWN = 20;
/** ...but distinct moments are never closer than this on screen... */
const MIN_STEP_MS = 120;
/** ...and long waits (the outbox, a redelivery delay) are cut down to this. */
const MAX_STEP_MS = 1000;

/**
 * The replay of a job's trace: one dot for the request, then one per message (the first
 * `maxMessages`, by publish time). Times come from the spans, re-timed by `screenClock` so the
 * order and the relative gaps stay true while everything stays watchable; the log quotes the
 * real durations.
 */
export function tracePlayback(job: JobTrace, maxMessages: number): Playback {
  const tokens: TimedHop[][] = [];
  const events: PlaybackEvent[] = [];
  const hop = (edge: EdgeId, start: number, end: number): TimedHop => ({
    edge,
    start,
    end: Math.max(end, start + 0.01),
  });

  const { request, authenticate, begin, commit } = job;
  const creation: TimedHop[] = [];
  events.push({
    at: request.start,
    text: `jobs receives executeJob; the request takes ${ms(duration(request))} in all`,
  });
  creation.push(
    hop(
      'submit',
      request.start,
      authenticate?.start ?? begin?.start ?? request.end,
    ),
  );
  if (authenticate) {
    const middle = (authenticate.start + authenticate.end) / 2;
    creation.push(
      hop('authenticate', authenticate.start, middle),
      hop('user', middle, authenticate.end),
    );
    events.push({
      at: authenticate.start,
      text: `Authenticate over gRPC: ${ms(duration(authenticate))}`,
    });
  }
  if (begin && commit) {
    creation.push(hop('sql', begin.start, commit.end));
    events.push({
      at: begin.start,
      text: `One transaction saves the job and its outbox rows: ${ms(commit.end - begin.start)}`,
    });
  }
  creation.push(hop('reply', commit?.end ?? request.end, request.end));
  tokens.push(creation);

  const messages = job.messages.slice(0, maxMessages);
  const firstPublish = messages[0]?.publish;
  const committed = commit?.end ?? request.end;
  if (firstPublish) {
    events.push({
      at: committed,
      text: `The outbox relay picks the rows up ${ms(firstPublish.start - committed)} after the commit`,
    });
  }
  messages.forEach(({ publish, attempts }, i) => {
    const n = i + 1;
    // The relay claims a whole batch at once, then publishes it one message at a time, so
    // every dot leaves the outbox together and waits at the relay for its turn.
    const claimed = firstPublish?.start ?? publish.start;
    const route: TimedHop[] = [
      hop('claim', Math.min(committed, claimed - 0.01), claimed),
      hop('publish', publish.start, publish.end),
    ];
    events.push({
      at: publish.start,
      text: `Message ${n} published; Pulsar confirms it in ${ms(duration(publish))}`,
    });
    let ready = publish.end;
    attempts.forEach((attempt, a) => {
      const { process } = attempt;
      // A redelivery waits at Pulsar (the redelivery delay), then arrives quickly.
      const delivered =
        a === 0
          ? Math.min(ready, process.start - 0.01)
          : Math.max(ready, process.start - 0.5);
      route.push(hop('deliver', delivered, process.start));
      if (a > 0) {
        events.push({
          at: process.start,
          text: `Message ${n} redelivered (attempt ${a + 1})`,
        });
      }
      if (attempt.createProduct) {
        const { start, end } = attempt.createProduct;
        route.push(
          hop('create-product', start, (start + end) / 2),
          hop('product-saved', (start + end) / 2, end),
        );
        events.push({
          at: start,
          text: `Message ${n}: CreateProduct over gRPC, ${ms(end - start)}`,
        });
      }
      if (attempt.outcome !== 'acked') {
        const next = attempts[a + 1]?.process.start;
        route.push(hop('nack', process.end, process.end + 0.5));
        events.push({
          at: process.end,
          text:
            `Message ${n} failed (${attempt.outcome})` +
            (next === undefined
              ? '; no retry in the trace yet'
              : `; Pulsar redelivers it ${ms(next - process.end)} later`),
        });
        ready = process.end + 0.5;
        return;
      }
      if (attempt.acknowledge) {
        const server = attempt.acknowledgeServer;
        route.push(
          hop(
            'acknowledge',
            attempt.acknowledge.start,
            server?.start ?? attempt.acknowledge.end,
          ),
        );
        if (attempt.countQuery) {
          route.push(
            hop('sql', attempt.countQuery.start, attempt.countQuery.end),
          );
        }
        events.push({
          at: attempt.acknowledge.start,
          text: `Message ${n} processed in ${ms(duration(process))} and acknowledged; counted at +${ms(attempt.countQuery?.end ?? attempt.acknowledge.end)}`,
        });
      }
    });
    tokens.push(route);
  });
  if (job.messages.length > messages.length) {
    events.push({
      at: committed,
      text: `…${job.messages.length - messages.length} more messages are in the trace but not drawn`,
    });
  }
  return screenClock({ tokens, events });
}

/**
 * Re-times a playback for the screen: moments keep their order and simultaneous ones (equal to
 * 0.01 ms) stay simultaneous, but each gap is stretched by `SLOWDOWN` and clamped to
 * [MIN_STEP_MS, MAX_STEP_MS].
 */
export function screenClock(real: Playback): Playback {
  const key = (t: number) => Math.round(t * 100) / 100;
  const instants = [
    ...new Set([
      ...real.tokens.flat().flatMap((h) => [key(h.start), key(h.end)]),
      ...real.events.map((e) => key(e.at)),
    ]),
  ].sort((a, b) => a - b);
  const screen = new Map<number, number>();
  let elapsed = 0;
  instants.forEach((t, i) => {
    if (i > 0) {
      const gap = t - instants[i - 1];
      elapsed += Math.min(Math.max(gap * SLOWDOWN, MIN_STEP_MS), MAX_STEP_MS);
    }
    screen.set(t, elapsed);
  });
  const at = (t: number) => screen.get(key(t)) ?? 0;
  return {
    tokens: real.tokens.map((hops) =>
      hops.map((h) => ({ ...h, start: at(h.start), end: at(h.end) })),
    ),
    events: real.events
      .map((e) => ({ ...e, at: at(e.at) }))
      .sort((a, b) => a.at - b.at),
  };
}

/** Formats a duration in ms for people. */
export function ms(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)} s`;
  }
  if (value >= 10) {
    return `${Math.round(value)} ms`;
  }
  return `${value.toFixed(1)} ms`;
}

function duration(span: TraceSpan): number {
  return span.end - span.start;
}

function average(values: number[]): number | undefined {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : undefined;
}

/** Nanoseconds (an OTLP decimal string) to microseconds, exact in a double. */
function micros(nanos: string): number {
  return Number(nanos.slice(0, -3));
}

function attributes(list: OtlpAttribute[] | undefined): Record<string, string> {
  return Object.fromEntries(
    (list ?? []).map(({ key, value }) => [
      key,
      String(
        value.stringValue ??
          value.intValue ??
          value.boolValue ??
          value.doubleValue ??
          '',
      ),
    ]),
  );
}

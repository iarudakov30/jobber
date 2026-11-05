import { HttpErrorResponse, httpResource } from '@angular/common/http';
import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';

import { Job } from '../job.model';
import {
  EDGES,
  Hop,
  NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  NodeId,
  VIEW_BOX,
  creationRoute,
  itemRoute,
  pathData,
  pollRoute,
  usesProducts,
} from './pipeline';
import { Playback, dotAt, playbackDuration, routesPlayback } from './playback';
import {
  OtlpTraceResponse,
  analyseJobTrace,
  ms,
  parseTrace,
  summarise,
  tracePlayback,
} from './trace';

/** How long a dot takes to travel one arrow in the illustration. */
const HOP_MS = 600;
/** Gap between dots sent together, so they read as separate items. */
const STAGGER_MS = 350;
/** Items beyond this many are summarised in the log instead of drawn. */
const MAX_DOTS = 6;
/** A job opened this soon after it started replays its run on its own. */
const AUTOPLAY_WINDOW_MS = 60_000;
const LOG_SIZE = 8;
/** Jaeger's query API, proxied by the dev server (`proxy.conf.json`). */
const JAEGER_API = '/api/jaeger/v3/traces';
/** Jaeger's own UI. */
const JAEGER_UI = 'http://localhost:16686/trace';

/** A playback in progress; `origin` is its time 0 on the `performance.now()` clock. */
interface Run {
  id: number;
  origin: number;
  playback: Playback;
  duration: number;
  /** How many of the playback's events are already in the log. */
  logged: number;
}

interface LogEntry {
  id: number;
  text: string;
}

const centerOf = (id: NodeId) =>
  (NODES.find((node) => node.id === id)?.x ?? 0) + NODE_WIDTH / 2;

/**
 * Animated diagram of the services a job passes through, in one of two modes:
 *
 * - **Illustration** (default): the browser only sees the job's polled progress, so the dots
 *   show the path each item takes; the counters, and when new dots appear, are real.
 * - **Trace**: replays the job's real OpenTelemetry trace from Jaeger, so the order of events and
 *   the gaps between them are real (slowed down for the screen), as are the times in the log.
 */
@Component({
  selector: 'app-job-pipeline',
  templateUrl: './job-pipeline.html',
  styleUrl: './job-pipeline.css',
})
export class JobPipeline {
  readonly job = input.required<Job>();

  protected readonly viewBox = `0 0 ${VIEW_BOX.width} ${VIEW_BOX.height}`;
  protected readonly nodeWidth = NODE_WIDTH;
  protected readonly nodeHeight = NODE_HEIGHT;
  protected readonly counterY = VIEW_BOX.height - 6;
  protected readonly dbCenter = centerOf('db');
  protected readonly pulsarCenter = centerOf('pulsar');
  protected readonly nodes = NODES;
  protected readonly edges = EDGES.map((edge) => ({
    ...edge,
    d: pathData(edge.points),
  }));
  protected readonly ms = ms;

  protected readonly usesProducts = computed(() =>
    usesProducts(this.job().name),
  );

  protected readonly subtitles = computed(() => {
    const subtitles = Object.fromEntries(
      NODES.map((node) => [node.id, node.subtitle]),
    ) as Record<NodeId, string>;
    subtitles.pulsar = `topic ${this.job().name}`;
    if (!this.usesProducts()) {
      subtitles.products = 'LoadProducts only';
    }
    return subtitles;
  });

  protected readonly mode = signal<'illustration' | 'trace'>('illustration');
  private readonly runs = signal<Run[]>([]);
  private readonly now = signal(0);
  protected readonly log = signal<LogEntry[]>([]);

  protected readonly dots = computed(() => {
    const now = this.now();
    return this.runs().flatMap((run) =>
      run.playback.tokens.flatMap((hops, i) => {
        const dot = dotAt(hops, now - run.origin);
        return dot ? [{ id: `${run.id}.${i}`, ...dot }] : [];
      }),
    );
  });

  protected readonly activeEdges = computed(
    () => new Set(this.dots().flatMap((dot) => (dot.edge ? [dot.edge] : []))),
  );

  protected readonly activeNodes = computed(
    () => new Set(this.dots().map((dot) => dot.node)),
  );

  /** The trace being replayed; set by "Replay real trace". */
  private readonly traceId = signal<string | undefined>(undefined);

  protected readonly trace = httpResource<OtlpTraceResponse>(() => {
    const id = this.traceId();
    return id ? `${JAEGER_API}/${id}` : undefined;
  });

  private readonly jobTrace = computed(() =>
    this.trace.hasValue()
      ? analyseJobTrace(parseTrace(this.trace.value()))
      : null,
  );

  protected readonly summary = computed(() => {
    const jobTrace = this.jobTrace();
    return jobTrace ? summarise(jobTrace) : null;
  });

  protected readonly jaegerLink = computed(() => {
    const id = this.job().traceId;
    return id ? `${JAEGER_UI}/${id}` : undefined;
  });

  protected readonly traceStatus = computed((): string | undefined => {
    if (this.trace.isLoading()) {
      return 'Loading the trace from Jaeger…';
    }
    const error = this.trace.error();
    if (error) {
      return error instanceof HttpErrorResponse && error.status === 404
        ? "Jaeger doesn't have this trace (yet). Spans reach it every few seconds, and it forgets everything when it restarts."
        : 'Could not reach Jaeger. Is it running (docker compose up -d jaeger)?';
    }
    if (this.trace.hasValue() && !this.jobTrace()) {
      return "The trace is incomplete: jobs hasn't exported the request yet. Try again in a few seconds.";
    }
    const summary = this.summary();
    const size = this.job().size;
    if (summary && summary.acknowledged < size) {
      return `The trace shows ${summary.acknowledged} of ${size} messages acknowledged so far; the rest may still be on their way to Jaeger.`;
    }
    return undefined;
  });

  private readonly reducedMotion =
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches;

  private nextId = 0;
  private frame = 0;
  /** The `completed` count already animated; null until the first job value arrives. */
  private seenCompleted: number | null = null;

  constructor() {
    effect(() => {
      const job = this.job();
      untracked(() => this.onProgress(job));
    });
    // Every (re)load of the trace replays it.
    effect(() => {
      const jobTrace = this.jobTrace();
      if (jobTrace) {
        untracked(() => {
          this.mode.set('trace');
          this.start(tracePlayback(jobTrace, MAX_DOTS));
        });
      }
    });
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  /** Plays the illustrated run from the start: the job's creation, then its items. */
  protected replay(): void {
    const job = this.job();
    const creation = creationRoute(job);
    this.mode.set('illustration');
    this.start(
      this.itemsPlayback(job, job.completed, creation.length * HOP_MS, [
        { route: creation, delay: 0 },
      ]),
    );
  }

  protected replayTrace(): void {
    const id = this.job().traceId;
    if (!id) {
      return;
    }
    if (this.traceId() === id) {
      this.trace.reload();
    } else {
      this.traceId.set(id);
    }
  }

  private onProgress(job: Job): void {
    if (this.seenCompleted === null) {
      this.seenCompleted = job.completed;
      if (Date.now() - Date.parse(job.started) < AUTOPLAY_WINDOW_MS) {
        this.replay();
      }
      return;
    }
    const added = job.completed - this.seenCompleted;
    this.seenCompleted = job.completed;
    if (added > 0) {
      this.play(this.itemsPlayback(job, added, 0));
    }
  }

  /** `count` item dots (at most `MAX_DOTS`) after `delay`, then the poll that reports them. */
  private itemsPlayback(
    job: Job,
    count: number,
    delay: number,
    before: { route: Hop[]; delay: number }[] = [],
  ): Playback {
    const drawn = Math.min(count, MAX_DOTS);
    const route = itemRoute(job);
    const routes = [
      ...before,
      ...Array.from({ length: drawn }, (_, i) => ({
        route,
        delay: delay + i * STAGGER_MS,
      })),
    ];
    if (drawn > 0) {
      routes.push({
        route: pollRoute(job),
        delay: delay + (drawn - 1) * STAGGER_MS + route.length * HOP_MS,
      });
    }
    const playback = routesPlayback(routes, HOP_MS);
    if (count > drawn) {
      playback.events.push({
        at: delay,
        text: `…and ${count - drawn} more items the same way`,
      });
    }
    return playback;
  }

  /** Replaces whatever is playing. */
  private start(playback: Playback): void {
    this.runs.set([]);
    this.log.set([]);
    this.play(playback);
  }

  /** Plays alongside whatever is already playing. */
  private play(playback: Playback): void {
    const events = [...playback.events].sort((a, b) => a.at - b.at);
    if (this.reducedMotion) {
      // No movement: describe the run instead, each step once.
      this.addLog([...new Set(events.map((event) => event.text))]);
      return;
    }
    const run: Run = {
      id: this.nextId++,
      origin: performance.now(),
      playback: { ...playback, events },
      duration: playbackDuration(playback),
      logged: 0,
    };
    this.runs.update((runs) => [...runs, run]);
    if (!this.frame) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    const now = performance.now();
    const texts: string[] = [];
    const runs = this.runs().flatMap((run) => {
      const t = now - run.origin;
      const { events } = run.playback;
      let logged = run.logged;
      while (logged < events.length && events[logged].at <= t) {
        texts.push(events[logged++].text);
      }
      if (t > run.duration) {
        return [];
      }
      return [logged === run.logged ? run : { ...run, logged }];
    });
    this.runs.set(runs);
    this.now.set(now);
    this.addLog(texts);
    this.frame = runs.length ? requestAnimationFrame(this.tick) : 0;
  };

  /** Newest entry first. */
  private addLog(texts: string[]): void {
    if (texts.length === 0) {
      return;
    }
    const entries = texts.map((text) => ({ id: this.nextId++, text }));
    this.log.update((log) => [...entries.reverse(), ...log].slice(0, LOG_SIZE));
  }
}

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
  EDGE_BY_ID,
  Hop,
  NODES,
  NODE_HEIGHT,
  NODE_WIDTH,
  NodeId,
  VIEW_BOX,
  creationRoute,
  itemRoute,
  pathData,
  pointAlong,
  pollRoute,
  usesProducts,
} from './pipeline';

/** How long a dot takes to travel one arrow. */
const HOP_MS = 600;
/** Gap between dots sent together, so they read as separate items. */
const STAGGER_MS = 350;
/** Items beyond this many are summarised in the log instead of drawn. */
const MAX_DOTS = 6;
/** A job opened this soon after it started replays its run on its own. */
const AUTOPLAY_WINDOW_MS = 60_000;
const LOG_SIZE = 8;

/** A dot travelling a route; `hop` is the arrow it was last seen on (-1 before it starts). */
interface Token {
  id: number;
  route: Hop[];
  start: number;
  hop: number;
}

interface LogEntry {
  id: number;
  text: string;
}

const centerOf = (id: NodeId) =>
  (NODES.find((node) => node.id === id)?.x ?? 0) + NODE_WIDTH / 2;

/**
 * Animated diagram of the services a job passes through.
 *
 * The browser only sees the job's polled progress, so the dots are an illustration of the path
 * each item takes; what is real is the counters and when new dots appear: every rise in
 * `completed` sends that many dots (up to `MAX_DOTS`) through the item route.
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

  private readonly tokens = signal<Token[]>([]);
  private readonly now = signal(0);
  protected readonly log = signal<LogEntry[]>([]);

  protected readonly dots = computed(() => {
    const now = this.now();
    return this.tokens().flatMap((token) => {
      const elapsed = now - token.start;
      const hop = token.route[Math.floor(elapsed / HOP_MS)];
      if (elapsed < 0 || !hop) {
        return [];
      }
      const point = pointAlong(
        EDGE_BY_ID[hop.edge].points,
        (elapsed % HOP_MS) / HOP_MS,
      );
      return [{ id: token.id, edge: hop.edge, ...point }];
    });
  });

  protected readonly activeEdges = computed(
    () => new Set(this.dots().map((dot) => dot.edge)),
  );

  protected readonly activeNodes = computed(
    () => new Set(this.dots().map((dot) => EDGE_BY_ID[dot.edge].to)),
  );

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
    inject(DestroyRef).onDestroy(() => cancelAnimationFrame(this.frame));
  }

  /** Plays the whole run from the start: the job's creation, then its items. */
  protected replay(): void {
    const job = this.job();
    this.tokens.set([]);
    this.log.set([]);
    const creation = creationRoute(job);
    this.send([creation], 0);
    this.sendItems(job, job.completed, creation.length * HOP_MS);
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
    this.sendItems(job, added, 0);
  }

  /** Sends `count` item dots (at most `MAX_DOTS`), then the poll that reports them. */
  private sendItems(job: Job, count: number, delay: number): void {
    if (count <= 0) {
      return;
    }
    const drawn = Math.min(count, MAX_DOTS);
    const route = itemRoute(job);
    this.send(
      Array.from({ length: drawn }, () => route),
      delay,
    );
    if (count > drawn) {
      this.addLog([`…and ${count - drawn} more items the same way`]);
    }
    this.send(
      [pollRoute(job)],
      delay + (drawn - 1) * STAGGER_MS + route.length * HOP_MS,
    );
  }

  private send(routes: Hop[][], delay: number): void {
    if (this.reducedMotion) {
      // No movement: describe each distinct route once instead.
      this.addLog([...new Set(routes)].flatMap((r) => r.map((h) => h.text)));
      return;
    }
    const start = performance.now() + delay;
    this.tokens.update((tokens) => [
      ...tokens,
      ...routes.map((route, i) => ({
        id: this.nextId++,
        route,
        start: start + i * STAGGER_MS,
        hop: -1,
      })),
    ]);
    if (!this.frame) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private readonly tick = (): void => {
    const now = performance.now();
    const texts: string[] = [];
    const tokens = this.tokens().flatMap((token) => {
      const hop = Math.floor((now - token.start) / HOP_MS);
      if (hop >= token.route.length) {
        return [];
      }
      if (hop >= 0 && hop !== token.hop) {
        texts.push(token.route[hop].text);
        return [{ ...token, hop }];
      }
      return [token];
    });
    this.tokens.set(tokens);
    this.now.set(now);
    this.addLog(texts);
    this.frame = tokens.length ? requestAnimationFrame(this.tick) : 0;
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

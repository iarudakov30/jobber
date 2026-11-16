import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { Job } from '../job.model';
import { JobPipeline } from './job-pipeline';
import { fibonacciWithRetries } from './testing/trace-fixtures';

const traceId = 'bbd8e3137063dfe7d7e6a035b935849c';

const job: Job = {
  id: '7',
  name: 'Fibonacci',
  size: 10,
  completed: 4,
  status: 'IN_PROGRESS',
  // Long ago, so the run doesn't replay on its own.
  started: '2026-01-01T00:00:00.000Z',
  ended: null,
  traceId: null,
};

async function render(value: Job) {
  const fixture = TestBed.createComponent(JobPipeline);
  fixture.componentRef.setInput('job', value);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  const button = (label: string) =>
    [...element.querySelectorAll('button')].find((b) =>
      b.textContent?.includes(label),
    ) as HTMLButtonElement;
  return {
    fixture,
    element,
    button,
    log: () => element.querySelector('.log')?.textContent ?? '',
  };
}

describe('JobPipeline', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }),
  );

  afterEach(() => vi.unstubAllGlobals());

  it('shows the real progress and dims products for other job types', async () => {
    const { element, log } = await render(job);

    expect(element.textContent).toContain('done 4 / 10');
    expect(element.textContent).toContain('still to process: 6');
    expect(element.textContent).toContain('topic Fibonacci');
    expect(element.querySelector('g.node.dim')?.textContent).toContain(
      'LoadProducts only',
    );
    expect(log()).toContain('Press Replay');
  });

  it('keeps products in the picture for LoadProducts', async () => {
    const { element } = await render({ ...job, name: 'LoadProducts' });

    expect(element.querySelector('g.node.dim')).toBeNull();
  });

  it('offers the real trace only for jobs that have one', async () => {
    const without = await render(job);
    expect(without.button('Replay real trace').disabled).toBe(true);
    expect(without.element.textContent).not.toContain('Open in Jaeger');

    const withTrace = await render({ ...job, traceId });
    expect(withTrace.button('Replay real trace').disabled).toBe(false);
    expect(withTrace.element.querySelector('a')?.getAttribute('href')).toBe(
      `http://localhost:16686/trace/${traceId}`,
    );
  });

  describe('animation', () => {
    beforeEach(() => {
      vi.useFakeTimers({
        toFake: [
          'Date',
          'performance',
          'requestAnimationFrame',
          'cancelAnimationFrame',
        ],
      });
      vi.setSystemTime(new Date('2026-11-05T12:00:00.000Z'));
    });
    afterEach(() => vi.useRealTimers());

    it('replays a job that just started, then comes to rest', async () => {
      const { element, fixture, log } = await render({
        ...job,
        started: '2026-11-05T11:59:58.000Z',
      });

      await vi.advanceTimersByTimeAsync(700);
      await fixture.whenStable();
      expect(element.querySelectorAll('circle').length).toBe(1);
      expect(log()).toContain('jobs checks the Authentication cookie');

      await vi.advanceTimersByTimeAsync(20_000);
      await fixture.whenStable();
      expect(element.querySelector('circle')).toBeNull();
      expect(log()).toContain('Progress poll: 4 of 10 done');
    });
  });

  describe('with reduced motion', () => {
    beforeEach(() =>
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('reduce'),
      })),
    );

    it('describes the whole run on Replay instead of animating it', async () => {
      const { element, fixture, button, log } = await render(job);

      button('Replay').click();
      await fixture.whenStable();

      expect(log()).toContain('Progress poll: 4 of 10 done');
      expect(log()).toContain('executor acknowledges');
      expect(element.querySelector('circle')).toBeNull();
    });

    it('follows new progress as it is polled', async () => {
      const { fixture, log } = await render(job);

      fixture.componentRef.setInput('job', { ...job, completed: 6 });
      await fixture.whenStable();

      expect(log()).toContain('Progress poll: 6 of 10 done');
      expect(log()).toContain('The relay claims an outbox row');
    });

    it('replays the real trace from Jaeger with its real timings', async () => {
      const { element, fixture, button, log } = await render({
        ...job,
        size: 3,
        traceId,
      });

      button('Replay real trace').click();
      // whenStable() would wait for the pending request itself; just run the effects.
      TestBed.tick();
      TestBed.inject(HttpTestingController)
        .expectOne(`/api/jaeger/v3/traces/${traceId}`)
        .flush(fibonacciWithRetries);
      await fixture.whenStable();

      expect(log()).toMatch(/Pulsar redelivers it 5\.\d s later/);
      const summary = element.querySelector('.trace-summary')?.textContent;
      expect(summary).toContain('Failed deliveries');
      expect(summary).toContain('Outbox relay lag');
      expect(element.textContent).toContain('Replaying the real trace');
    });

    it('explains a trace Jaeger does not have', async () => {
      const { element, fixture, button } = await render({ ...job, traceId });

      button('Replay real trace').click();
      // whenStable() would wait for the pending request itself; just run the effects.
      TestBed.tick();
      TestBed.inject(HttpTestingController)
        .expectOne(`/api/jaeger/v3/traces/${traceId}`)
        .flush(
          { error: { httpCode: 404, message: 'No traces found' } },
          { status: 404, statusText: 'Not Found' },
        );
      await fixture.whenStable();

      expect(element.querySelector('[role=status]')?.textContent).toContain(
        "Jaeger doesn't have this trace (yet)",
      );
    });
  });
});

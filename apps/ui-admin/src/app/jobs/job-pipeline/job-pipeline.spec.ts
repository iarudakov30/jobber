import { TestBed } from '@angular/core/testing';

import { Job } from '../job.model';
import { JobPipeline } from './job-pipeline';

const job: Job = {
  id: '7',
  name: 'Fibonacci',
  size: 10,
  completed: 4,
  status: 'IN_PROGRESS',
  // Long ago, so the run doesn't replay on its own.
  started: '2026-01-01T00:00:00.000Z',
  ended: null,
};

async function render(value: Job) {
  const fixture = TestBed.createComponent(JobPipeline);
  fixture.componentRef.setInput('job', value);
  await fixture.whenStable();
  const element = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    element,
    log: () => element.querySelector('.log')?.textContent ?? '',
  };
}

describe('JobPipeline', () => {
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
      const { element, fixture, log } = await render(job);

      element.querySelector('button')?.click();
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
  });
});

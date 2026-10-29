import { DatePipe, PercentPipe } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { JobStatusBadge } from '../job-status-badge';
import { JobsService } from '../jobs.service';

@Component({
  selector: 'app-job-detail',
  imports: [DatePipe, PercentPipe, RouterLink, JobStatusBadge],
  templateUrl: './job-detail.html',
})
export class JobDetail {
  private readonly jobsService = inject(JobsService);

  /** Bound from the `:id` route param. */
  readonly id = input.required<string>();

  /** Re-streams whenever `id` changes (e.g. navigating between jobs). */
  protected readonly job = rxResource({
    params: () => ({ id: Number(this.id()) }),
    stream: ({ params }) => this.jobsService.job(params.id),
  });
}

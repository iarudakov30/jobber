import { DatePipe } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { ExecuteJob } from '../execute-job/execute-job';
import { JobStatusBadge } from '../job-status-badge';
import { JobsService } from '../jobs.service';

@Component({
  selector: 'app-jobs-list',
  imports: [DatePipe, RouterLink, ExecuteJob, JobStatusBadge],
  templateUrl: './jobs-list.html',
  styleUrl: './jobs-list.css',
})
export class JobsList {
  private readonly jobsService = inject(JobsService);

  protected readonly jobs = rxResource({
    stream: () => this.jobsService.jobs(),
  });

  /** Newest first. */
  protected readonly sortedJobs = computed(() =>
    this.jobs.hasValue()
      ? [...this.jobs.value()].sort(
          (a, b) => Date.parse(b.started) - Date.parse(a.started),
        )
      : [],
  );
}

import { Component, computed, input } from '@angular/core';

import { JobStatus } from './job.model';

const LABELS: Record<JobStatus, string> = {
  IN_PROGRESS: 'In progress',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
};

@Component({
  selector: 'app-job-status-badge',
  template: `<span class="badge" [attr.data-status]="status()">{{
    label()
  }}</span>`,
})
export class JobStatusBadge {
  readonly status = input.required<JobStatus>();
  protected readonly label = computed(
    () => LABELS[this.status()] ?? this.status(),
  );
}
